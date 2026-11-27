use std::path::PathBuf;

use ardia_ui::host::{PluginDetail, PluginLine};

use super::super::consent::{ConsentContext, consent_lines, full_control_line};
use super::{PluginService, ProcessState};

pub fn process_text(state: Option<&ProcessState>, on_demand: bool) -> Option<String> {
    let Some(state) = state else {
        return on_demand.then(|| "Ready (on demand)".to_owned());
    };
    Some(match state {
        ProcessState::Running { .. } => "Running".to_owned(),
        ProcessState::Starting => "Starting…".to_owned(),
        ProcessState::Waiting { failures } => {
            if *failures == 1 {
                "Restarting after a crash…".to_owned()
            } else {
                format!("Restarting after {failures} crashes…")
            }
        }
        ProcessState::Crashed(reason) => format!("Its program crashed ({reason}) and was stopped"),
        ProcessState::Failed(reason) => format!("Its program couldn't start: {reason}"),
        ProcessState::Exited => {
            if on_demand {
                "Ready (on demand)".to_owned()
            } else {
                "Its program finished".to_owned()
            }
        }
    })
}

impl PluginService {
    pub fn never_chosen_profiles(&self) -> usize {
        self.env.state().map_or(0, |browser| {
            browser
                .profiles
                .keys()
                .filter(|id| ardia_ui::settings::extras::stored_choice(&browser, id).is_none())
                .count()
        })
    }

    pub fn settings_detail(&self, name: &str) -> Option<PluginDetail> {
        let control_off = !self.env.control_on();
        let moves_profiles = self.never_chosen_profiles();
        let state = self.state.lock();
        let listing = state.listings.get(name)?;
        let record = state.records.get(name);
        let active = state.active(name).is_some();
        let enabled = record.is_some_and(|r| r.enabled);
        let hash = listing.hash.as_ref();
        let approved = |h: &Option<String>| h.as_ref().is_some_and(|h| Some(h) == hash);
        let needs_review = enabled
            && !active
            && listing.read.manifest.is_some()
            && record.is_some_and(|r| !approved(&r.approved) && !approved(&r.previous));
        let process = state.supervised.get(name).map(|s| s.state.clone());
        let manifest = listing.read.manifest.as_ref();
        let context = ConsentContext {
            control_off,
            official: listing.official && !active,
            moves_profiles,
            installed: active,
        };
        let program = manifest.and_then(|m| {
            if let Some(sidecar) = &m.sidecar {
                Some(("Its program".to_owned(), sidecar.run.join(" ")))
            } else {
                m.main
                    .as_ref()
                    .map(|main| ("Its code".to_owned(), main.entry.clone()))
            }
        });
        let shows_program = manifest
            .is_some_and(|m| m.sidecar.is_some() || (m.main.is_some() && process.is_some()));
        Some(PluginDetail {
            name: name.to_owned(),
            title: manifest.map_or_else(|| name.to_owned(), |m| m.title.clone()),
            version: manifest.and_then(|m| m.version.clone()),
            description: manifest.map(|m| m.description.clone()).unwrap_or_default(),
            icon: manifest.and_then(|m| {
                m.icon
                    .clone()
                    .or_else(|| m.page.as_ref().map(|p| p.icon.clone()))
            }),
            loads: manifest.is_some(),
            official: listing.official,
            ignores_user_folder: listing.ignores_user_folder,
            active,
            enabled,
            needs_review,
            status: if active {
                process_text(process.as_ref(), manifest.is_some_and(|m| m.main.is_some()))
            } else {
                None
            },
            program: program.filter(|_| active && shows_program),
            programs: manifest
                .map(|m| {
                    m.contributes
                        .programs
                        .iter()
                        .map(|p| p.name.clone())
                        .collect()
                })
                .unwrap_or_default(),
            full_control: manifest.is_some_and(|m| full_control_line(m, context).is_some()),
            consent: manifest
                .map(|m| {
                    consent_lines(m, context)
                        .into_iter()
                        .map(|line| PluginLine {
                            icon: line.icon,
                            text: line.text,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            problems: listing.read.problems.clone(),
            password_manager: manifest.is_some_and(|m| m.contributes.password_manager.is_some()),
            unsaved: state.unsaved.as_deref() == Some(name),
            auto_update: record
                .filter(|r| listing.official && r.approved.is_some() && r.approved == listing.hash)
                .and_then(|r| r.updated.as_ref())
                .map(super::official_updates::auto_update_note),
            plugins_folder: self.folders.user_root().to_string_lossy().into_owned(),
        })
    }

    pub fn restart_plugin(&self, name: &str) {
        self.stop_process(name);
        self.supervise(name);
    }

    pub fn remove_plugin(&self, name: &str) -> bool {
        let (folder, official) = {
            let state = self.state.lock();
            let Some(listing) = state.listings.get(name) else {
                return false;
            };
            (listing.folder.clone(), listing.official)
        };
        self.turn_plugin_off(name);
        self.remove_plugin_programs(name);
        let removed = if official {
            let download = self.official_store().plugin_folder(name);
            !download.exists() || std::fs::remove_dir_all(&download).is_ok()
        } else {
            let trashed = crate::native_ui::move_to_trash(&folder.to_string_lossy());
            if trashed && let Some(data) = self.folders.data_folder(name) {
                let _ = std::fs::remove_dir_all(data);
            }
            trashed
        };
        self.rescan();
        removed
    }

    pub fn plugin_log(&self, name: &str) -> Option<PathBuf> {
        let log = self.folders.data_folder(name)?.join("plugin.log");
        log.exists().then_some(log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_lines_match_the_old_plugins_pane() {
        assert_eq!(process_text(None, false), None);
        assert_eq!(
            process_text(None, true).as_deref(),
            Some("Ready (on demand)")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Running { run: 1 }), false).as_deref(),
            Some("Running")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Waiting { failures: 1 }), false).as_deref(),
            Some("Restarting after a crash…")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Waiting { failures: 3 }), false).as_deref(),
            Some("Restarting after 3 crashes…")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Crashed("signal 9".into())), false).as_deref(),
            Some("Its program crashed (signal 9) and was stopped")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Failed("no node".into())), false).as_deref(),
            Some("Its program couldn't start: no node")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Exited), true).as_deref(),
            Some("Ready (on demand)")
        );
        assert_eq!(
            process_text(Some(&ProcessState::Exited), false).as_deref(),
            Some("Its program finished")
        );
    }
}
