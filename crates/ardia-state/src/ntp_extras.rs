use serde_json::{Value, json};

use crate::json::Fields;
use crate::model::Millis;
use crate::persistence::DataDir;
use crate::persistence::documents::{
    DocRead, load_onboarding, read_versioned, save_onboarding, write_versioned,
};

pub const CHECK_IN_AFTER_MS: Millis = 7 * 24 * 60 * 60 * 1000;
pub const POSTCARD_MS: Millis = 86_400 * 1000;
pub const RELEASE_NOTES_DOC: &str = "release-notes.json";
pub const RELEASE_NOTES_VERSION: u64 = 1;
pub const TELEMETRY_DOC: &str = "telemetry.json";
pub const TELEMETRY_VERSION: u64 = 2;
pub const TRIAL_FIELD: &str = "defaultBrowserTrialStartedAt";
pub const CHECK_IN_DONE_FIELD: &str = "defaultBrowserCheckInDoneAt";

pub const CHECK_IN_TITLE: &str = "How are you liking Ardia?";
pub const CHECK_IN_ACTION: &str = "Leave us feedback";
pub const ASK_TITLE: &str = "Help fix Ardia?";
pub const ASK_BODY: &str =
    "Share anonymous crash reports and usage stats. No sites, searches or typing. Ever.";
pub const ASK_SHARE: &str = "Share";
pub const ASK_NOT_NOW: &str = "Not now";
pub const WHATS_SENT: &str = "What's Sent";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseNoteItem {
    pub title: &'static str,
    pub body: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseNotes {
    pub version: &'static str,
    pub date: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub items: &'static [ReleaseNoteItem],
}

const fn item(title: &'static str, body: &'static str) -> ReleaseNoteItem {
    ReleaseNoteItem { title, body }
}

pub const RELEASE_NOTES: &[ReleaseNotes] = &[ReleaseNotes {
    version: "1.0",
    date: "September 2026",
    title: "Hello, Ardia",
    summary: "The first release: a calm, fast browser that keeps your tabs, your pages and your focus in one place.",
    items: &[
        item(
            "A command bar for everything",
            "Search, type an address or jump to an open tab from the New Tab page, or from any page with ⌘L.",
        ),
        item(
            "Split view",
            "Drag a tab onto the page to see two or three side by side, stacked or in columns.",
        ),
        item(
            "Tab groups and pinned tabs",
            "Group related tabs, pin the ones you live in, and let Clean Up Tabs tidy the rest.",
        ),
        item(
            "Picture in Picture that stays out of the way",
            "Stash a video at the edge of the screen; click its site name to jump back to the tab.",
        ),
        item(
            "Bring everything with you",
            "Import bookmarks, history, passwords and open tabs from Chrome, Safari, Arc and more.",
        ),
        item(
            "Profiles with their own colour",
            "Keep work and personal apart, each with its own theme on the New Tab page.",
        ),
    ],
}];

pub fn notes_for(version: &str) -> Option<&'static ReleaseNotes> {
    RELEASE_NOTES.iter().find(|n| n.version == version)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingNotes {
    pub version: String,
    pub since: Millis,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseNotesDoc {
    pub last_version: String,
    pub pending: Option<PendingNotes>,
}

fn usable(read: DocRead) -> Option<Fields> {
    match read {
        DocRead::Usable { doc, .. } => Some(doc),
        _ => None,
    }
}

fn millis(value: Option<&Value>) -> Option<Millis> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .map(|v| v as Millis)
}

pub fn release_notes_from(doc: &Fields) -> Option<ReleaseNotesDoc> {
    let last_version = doc.get("lastVersion")?.as_str()?.to_owned();
    let pending = doc.get("pending").and_then(|p| {
        Some(PendingNotes {
            version: p.get("version")?.as_str()?.to_owned(),
            since: millis(p.get("since"))?,
        })
    });
    Some(ReleaseNotesDoc {
        last_version,
        pending,
    })
}

pub fn load_release_notes(dir: &DataDir) -> Option<ReleaseNotesDoc> {
    usable(read_versioned(
        dir,
        RELEASE_NOTES_DOC,
        "version",
        RELEASE_NOTES_VERSION,
    ))
    .and_then(|doc| release_notes_from(&doc))
}

pub fn save_release_notes(dir: &DataDir, doc: &ReleaseNotesDoc) -> bool {
    let pending = doc.pending.as_ref().map_or(
        Value::Null,
        |p| json!({ "version": p.version, "since": p.since }),
    );
    write_versioned(
        dir,
        RELEASE_NOTES_DOC,
        "version",
        RELEASE_NOTES_VERSION,
        json!({ "lastVersion": doc.last_version, "pending": pending }),
    )
    .unwrap_or(false)
}

pub fn track_app_version(
    saved: Option<ReleaseNotesDoc>,
    version: &str,
    has_saved_session: bool,
    now: Millis,
) -> ReleaseNotesDoc {
    let updated = saved
        .as_ref()
        .map_or(has_saved_session, |s| s.last_version != version);
    let mut pending = saved.and_then(|s| s.pending);
    if updated {
        pending = notes_for(version).map(|_| PendingNotes {
            version: version.to_owned(),
            since: now,
        });
    }
    if pending
        .as_ref()
        .is_some_and(|p| now - p.since > POSTCARD_MS)
    {
        pending = None;
    }
    ReleaseNotesDoc {
        last_version: version.to_owned(),
        pending,
    }
}

pub fn check_in_due(trial_started: Option<Millis>, done: Option<Millis>, now: Millis) -> bool {
    matches!((trial_started, done), (Some(start), None) if now - start >= CHECK_IN_AFTER_MS)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CheckIn {
    pub trial_started: Option<Millis>,
    pub done: Option<Millis>,
    pub onboarding_completed: bool,
}

pub fn load_check_in(dir: &DataDir) -> CheckIn {
    let Some(doc) = load_onboarding(dir) else {
        return CheckIn::default();
    };
    CheckIn {
        trial_started: millis(doc.extra.get(TRIAL_FIELD)),
        done: millis(doc.extra.get(CHECK_IN_DONE_FIELD)),
        onboarding_completed: doc.completed(),
    }
}

pub fn record_check_in_done(dir: &DataDir, now: Millis) -> bool {
    let mut doc = load_onboarding(dir).unwrap_or_default();
    doc.extra.insert(CHECK_IN_DONE_FIELD.to_owned(), json!(now));
    save_onboarding(dir, &doc).unwrap_or(false)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TelemetryChoice {
    pub sharing: bool,
    pub decided: bool,
    pub ask_done: bool,
}

pub fn telemetry_from(doc: &Fields) -> TelemetryChoice {
    TelemetryChoice {
        sharing: doc.get("sharing").and_then(Value::as_bool) == Some(true),
        decided: millis(doc.get("decidedAt")).is_some(),
        ask_done: millis(doc.get("askDoneAt")).is_some(),
    }
}

fn load_telemetry_doc(dir: &DataDir) -> Fields {
    usable(read_versioned(
        dir,
        TELEMETRY_DOC,
        "version",
        TELEMETRY_VERSION,
    ))
    .unwrap_or_default()
}

pub fn load_telemetry(dir: &DataDir) -> TelemetryChoice {
    telemetry_from(&load_telemetry_doc(dir))
}

pub fn sharing_patch(
    current: &Fields,
    on: bool,
    now: Millis,
    install_id: impl FnOnce() -> String,
    app_version: &str,
) -> Fields {
    let was = telemetry_from(current);
    let ask_done = millis(current.get("askDoneAt")).unwrap_or(now);
    let mut patch = Fields::new();
    patch.insert("decidedAt".into(), json!(now));
    patch.insert("askDoneAt".into(), json!(ask_done));
    if on == was.sharing {
        return patch;
    }
    patch.insert("sharing".into(), json!(on));
    if on {
        let id = current
            .get("installId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map_or_else(install_id, str::to_owned);
        patch.insert("installId".into(), json!(id));
        patch.insert("crashCursor".into(), json!(now));
        patch.insert("lastVersion".into(), json!(app_version));
        patch.insert("settingsDay".into(), Value::Null);
        patch.insert("sessionOpen".into(), json!(true));
    } else {
        patch.insert("context".into(), Value::Null);
        for field in [
            "watchReport",
            "watchStartedAt",
            "watchUntil",
            "sharingUntil",
        ] {
            patch.insert(field.into(), Value::Null);
        }
    }
    patch
}

pub fn ask_dismissed_patch(now: Millis) -> Fields {
    let mut patch = Fields::new();
    patch.insert("askDoneAt".into(), json!(now));
    patch
}

pub fn apply_telemetry_patch(dir: &DataDir, patch: Fields) -> bool {
    let mut doc = load_telemetry_doc(dir);
    doc.shift_remove("version");
    for (key, value) in patch {
        doc.insert(key, value);
    }
    write_versioned(
        dir,
        TELEMETRY_DOC,
        "version",
        TELEMETRY_VERSION,
        Value::Object(doc),
    )
    .unwrap_or(false)
}

pub fn set_sharing(
    dir: &DataDir,
    on: bool,
    now: Millis,
    app_version: &str,
    install_id: impl FnOnce() -> String,
) -> bool {
    let current = load_telemetry_doc(dir);
    let patch = sharing_patch(&current, on, now, install_id, app_version);
    apply_telemetry_patch(dir, patch)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NtpExtras {
    pub check_in: bool,
    pub telemetry: TelemetryChoice,
    pub existing_user: bool,
    pub release_notes: Option<&'static ReleaseNotes>,
}

impl Default for NtpExtras {
    fn default() -> Self {
        NtpExtras {
            check_in: false,
            telemetry: TelemetryChoice {
                sharing: false,
                decided: true,
                ask_done: true,
            },
            existing_user: false,
            release_notes: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NtpExtrasChange {
    CheckInFeedback,
    CheckInDismissed,
    TelemetryShare,
    TelemetryNotNow,
    TelemetryAskDismissed,
    ReleaseNotesRetired,
}

impl NtpExtras {
    pub fn telemetry_ask_due(&self, incognito: bool, onboarding: bool) -> bool {
        !self.telemetry.decided
            && !self.telemetry.ask_done
            && self.existing_user
            && !incognito
            && !onboarding
            && !self.check_in
            && self.release_notes.is_none()
    }

    pub fn apply(&mut self, change: NtpExtrasChange) {
        match change {
            NtpExtrasChange::CheckInFeedback | NtpExtrasChange::CheckInDismissed => {
                self.check_in = false
            }
            NtpExtrasChange::TelemetryShare => {
                self.telemetry = TelemetryChoice {
                    sharing: true,
                    decided: true,
                    ask_done: true,
                }
            }
            NtpExtrasChange::TelemetryNotNow => {
                self.telemetry = TelemetryChoice {
                    sharing: false,
                    decided: true,
                    ask_done: true,
                }
            }
            NtpExtrasChange::TelemetryAskDismissed => self.telemetry.ask_done = true,
            NtpExtrasChange::ReleaseNotesRetired => self.release_notes = None,
        }
    }
}

pub fn load_ntp_extras(
    dir: &DataDir,
    app_version: &str,
    has_saved_session: bool,
    now: Millis,
) -> NtpExtras {
    let saved = load_release_notes(dir);
    let tracked = track_app_version(saved.clone(), app_version, has_saved_session, now);
    if saved.as_ref() != Some(&tracked) {
        save_release_notes(dir, &tracked);
    }
    let check_in = load_check_in(dir);
    NtpExtras {
        check_in: check_in_due(check_in.trial_started, check_in.done, now),
        telemetry: load_telemetry(dir),
        existing_user: check_in.onboarding_completed,
        release_notes: tracked.pending.and_then(|p| notes_for(&p.version)),
    }
}

pub fn persist_change(
    dir: &DataDir,
    change: NtpExtrasChange,
    now: Millis,
    app_version: &str,
    install_id: impl FnOnce() -> String,
) {
    match change {
        NtpExtrasChange::CheckInFeedback | NtpExtrasChange::CheckInDismissed => {
            record_check_in_done(dir, now);
        }
        NtpExtrasChange::TelemetryShare => {
            set_sharing(dir, true, now, app_version, install_id);
        }
        NtpExtrasChange::TelemetryNotNow => {
            set_sharing(dir, false, now, app_version, install_id);
        }
        NtpExtrasChange::TelemetryAskDismissed => {
            apply_telemetry_patch(dir, ask_dismissed_patch(now));
        }
        NtpExtrasChange::ReleaseNotesRetired => {
            if let Some(mut doc) = load_release_notes(dir) {
                doc.pending = None;
                save_release_notes(dir, &doc);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> (std::path::PathBuf, DataDir) {
        let root = std::env::temp_dir().join(format!(
            "ardia-ntp-extras-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        std::fs::create_dir_all(&root).expect("dir");
        (root.clone(), DataDir::new(root))
    }

    #[test]
    fn the_check_in_waits_a_week_after_the_trial_and_stops_once_done() {
        assert!(!check_in_due(None, None, 10));
        assert!(!check_in_due(Some(0), None, CHECK_IN_AFTER_MS - 1));
        assert!(check_in_due(Some(0), None, CHECK_IN_AFTER_MS));
        assert!(!check_in_due(Some(0), Some(5), CHECK_IN_AFTER_MS * 2));
    }

    #[test]
    fn release_notes_are_pending_only_after_an_update_with_notes_and_expire_after_a_day() {
        let fresh = track_app_version(None, "1.0", true, 100);
        assert_eq!(
            fresh.pending.as_ref().map(|p| p.version.as_str()),
            Some("1.0")
        );
        let none = track_app_version(None, "0.2.49", true, 100);
        assert_eq!(none.pending, None);
        let first_launch = track_app_version(None, "1.0", false, 100);
        assert_eq!(first_launch.pending, None);
        let later = track_app_version(Some(fresh.clone()), "1.0", true, 100 + POSTCARD_MS + 1);
        assert_eq!(later.pending, None);
        let same_day = track_app_version(Some(fresh), "1.0", true, 200);
        assert!(same_day.pending.is_some());
    }

    #[test]
    fn the_ask_shows_only_for_undecided_existing_users_with_nothing_else_on_the_page() {
        let mut extras = NtpExtras {
            check_in: false,
            telemetry: TelemetryChoice::default(),
            existing_user: true,
            release_notes: None,
        };
        assert!(extras.telemetry_ask_due(false, false));
        assert!(!extras.telemetry_ask_due(true, false));
        extras.check_in = true;
        assert!(!extras.telemetry_ask_due(false, false));
        extras.check_in = false;
        extras.apply(NtpExtrasChange::TelemetryAskDismissed);
        assert!(!extras.telemetry_ask_due(false, false));
    }

    #[test]
    fn sharing_and_dismissals_persist_like_the_old_documents() {
        let (root, dir) = temp();
        std::fs::write(
            root.join(TELEMETRY_DOC),
            r#"{"sharing":false,"installId":"abc","crashCursor":1,"version":2}"#,
        )
        .expect("write");
        assert!(set_sharing(&dir, true, 50, "9.9", || "fresh".into()));
        let doc = load_telemetry_doc(&dir);
        assert_eq!(doc.get("installId").and_then(Value::as_str), Some("abc"));
        assert_eq!(
            load_telemetry(&dir),
            TelemetryChoice {
                sharing: true,
                decided: true,
                ask_done: true
            }
        );
        assert!(record_check_in_done(&dir, 70));
        assert_eq!(load_check_in(&dir).done, Some(70));
        let tracked = track_app_version(None, "1.0", true, 5);
        assert!(save_release_notes(&dir, &tracked));
        persist_change(
            &dir,
            NtpExtrasChange::ReleaseNotesRetired,
            6,
            "1.0",
            String::new,
        );
        assert_eq!(load_release_notes(&dir).and_then(|d| d.pending), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
