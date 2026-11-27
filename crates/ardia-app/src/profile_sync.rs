use ardia_state::actions::ProfilePatch;
use ardia_state::persistence::documents;
use ardia_state::sync::SyncDoc;
use ardia_state::{Action, DataDir, ProfileId};
use serde_json::Value;

use crate::coordinator::AppCoordinator;

const RETIRE: &str = "retire";
const TABS_RETIRE: &str = "tabsRetire";

pub fn mark_profile_synced(doc: &mut SyncDoc, profile: &ProfileId, on: bool) -> bool {
    let Some(link) = doc.profiles.get_mut(profile.as_str()) else {
        return false;
    };
    link.enabled = on;
    if on {
        link.extra.remove(RETIRE);
    } else {
        link.extra.insert(RETIRE.to_owned(), Value::Bool(true));
    }
    true
}

pub fn mark_open_tabs_synced(doc: &mut SyncDoc, profile: &ProfileId, on: bool) -> bool {
    let enabled = doc.enabled;
    let Some(link) = doc.profiles.get_mut(profile.as_str()) else {
        return false;
    };
    if on {
        link.extra.remove(TABS_RETIRE).is_some()
    } else if enabled {
        link.extra
            .insert(TABS_RETIRE.to_owned(), Value::Bool(true))
            .is_none()
    } else {
        false
    }
}

impl AppCoordinator {
    fn edit_sync_doc(&self, edit: impl FnOnce(&mut SyncDoc) -> bool) {
        let Some(data_dir) = self.config.data_dir.clone() else {
            return;
        };
        let dir = DataDir::new(&data_dir);
        let mut doc = documents::load_sync(&dir);
        if !edit(&mut doc) {
            return;
        }
        if let Err(problem) = documents::save_sync(&dir, &doc) {
            log::warn!("the sync choice for a profile wasn't saved: {problem}");
        }
        self.refresh_sync();
    }

    pub(crate) fn write_profile_synced(&self, profile: ProfileId, on: bool) {
        if let Some(engine) = crate::sync_engine::ui_bridge::running(self) {
            engine.set_profile_synced(&profile, on);
            return;
        }
        self.edit_sync_doc(|doc| mark_profile_synced(doc, &profile, on));
    }

    pub(crate) fn write_profile_tabs_synced(&self, profile: ProfileId, on: bool) {
        let _ = self.store.dispatch(Action::UpdateProfile {
            profile: profile.clone(),
            patch: ProfilePatch {
                sync_tabs: Some(on),
                ..ProfilePatch::default()
            },
        });
        if let Some(engine) = crate::sync_engine::ui_bridge::running(self) {
            engine.set_open_tabs_synced(&profile, on);
            return;
        }
        self.edit_sync_doc(|doc| mark_open_tabs_synced(doc, &profile, on));
    }
}

pub fn haptic_alignment() {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        const ALIGNMENT: isize = 1;
        const NOW: usize = 1;
        let Some(class) = AnyClass::get(c"NSHapticFeedbackManager") else {
            return;
        };
        let performer: *mut AnyObject = unsafe { msg_send![class, defaultPerformer] };
        if performer.is_null() {
            return;
        }
        let _: () = unsafe {
            msg_send![performer, performFeedbackPattern: ALIGNMENT, performanceTime: NOW]
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> SyncDoc {
        serde_json::from_value(serde_json::json!({
            "enabled": true,
            "profiles": {"work": {"syncId": "s", "enabled": true}}
        }))
        .unwrap()
    }

    #[test]
    fn turning_a_profile_off_retires_it_like_the_old_engine() {
        let mut doc = doc();
        let work = ProfileId::new("work");
        assert!(mark_profile_synced(&mut doc, &work, false));
        let link = &doc.profiles["work"];
        assert!(!link.enabled);
        assert_eq!(link.extra.get(RETIRE), Some(&Value::Bool(true)));
        assert!(mark_profile_synced(&mut doc, &work, true));
        assert!(doc.profiles["work"].extra.get(RETIRE).is_none());
        assert!(!mark_profile_synced(
            &mut doc,
            &ProfileId::new("home"),
            true
        ));
    }

    #[test]
    fn open_tabs_retire_only_while_sync_is_on() {
        let mut doc = doc();
        let work = ProfileId::new("work");
        assert!(mark_open_tabs_synced(&mut doc, &work, false));
        assert_eq!(
            doc.profiles["work"].extra.get(TABS_RETIRE),
            Some(&Value::Bool(true))
        );
        assert!(mark_open_tabs_synced(&mut doc, &work, true));
        assert!(doc.profiles["work"].extra.get(TABS_RETIRE).is_none());
        doc.enabled = false;
        assert!(!mark_open_tabs_synced(&mut doc, &work, false));
    }
}
