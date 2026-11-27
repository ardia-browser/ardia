use std::collections::BTreeMap;
use std::sync::Arc;

use ardia_state::{Millis, ProfileId, TabId};
use gpui::Image;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyncState {
    #[default]
    Off,
    Starting,
    Updating,
    Updated,
    Stalled,
    Offline,
    Locked,
    Reset,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DeviceKind {
    #[default]
    Mac,
    Phone,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FolderInfo {
    pub path: String,
    pub default_path: String,
    pub icloud_available: bool,
    pub in_icloud: bool,
    pub exists: bool,
    pub writable: bool,
    pub has_sync_data: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncedDevice {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    pub receives_tabs: bool,
    pub last_seen: Option<Millis>,
    pub current: bool,
    pub version: Option<String>,
    pub os: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SharesWith {
    pub name: String,
    pub added: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteProfile {
    pub sync_id: String,
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
    pub shares_with: Option<SharesWith>,
    pub waiting: bool,
    pub shared_by_others: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteTab {
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteTabs {
    pub device_id: String,
    pub name: String,
    pub kind: DeviceKind,
    pub tabs: Vec<RemoteTab>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendTarget {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncEngineView {
    pub state: SyncState,
    pub error: Option<String>,
    pub pending: u64,
    pub folder_info: Option<FolderInfo>,
    pub devices: Vec<SyncedDevice>,
    pub remote_profiles: Vec<RemoteProfile>,
    pub remote_tabs: BTreeMap<ProfileId, Vec<RemoteTabs>>,
    pub send_targets: BTreeMap<ProfileId, Vec<SendTarget>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PhraseProblem {
    WordCount(usize),
    UnknownWord(String),
    Checksum,
    Mismatch,
    NoData,
    Keychain,
    Unavailable,
}

#[derive(Clone)]
pub struct PhraseText(pub String);

impl std::fmt::Debug for PhraseText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PhraseText(..)")
    }
}

#[derive(Clone, Debug)]
pub enum SyncAction {
    TurnOn {
        folder: String,
    },
    EnterPhrase {
        folder: String,
        phrase: PhraseText,
    },
    Stop {
        delete_data: bool,
    },
    SyncNow,
    ChooseFolder,
    SetFolder(String),
    FolderInfo(Option<String>),
    AddRemoteProfile(String),
    RemoveRemoteProfile(String),
    RemoveDevice(String),
    RecoveryWords,
    RecoveryQrCode,
    RecoveryKitPreview {
        width: f32,
    },
    SaveRecoveryKit {
        text: bool,
    },
    CopyRecoveryKit,
    ShareRecoveryKit,
    CopyRecoveryPhrase,
    RevealFolder(String),
    OpenCloudSettings,
    SendTab {
        tab: TabId,
        device: String,
    },
    OpenRemoteTab {
        profile: ProfileId,
        device: String,
        index: usize,
    },
    AddSharedFolder {
        window: ardia_state::WindowId,
    },
    ShareFolder {
        window: ardia_state::WindowId,
        group: ardia_state::GroupId,
    },
    RevealSharedFolder {
        group: ardia_state::GroupId,
    },
    StopSyncingFolder {
        group: ardia_state::GroupId,
    },
}

#[derive(Clone, Debug)]
pub enum SyncAnswer {
    Done,
    Failed(String),
    Phrase(Result<(), PhraseProblem>),
    Path(Option<String>),
    Words(Option<Vec<String>>),
    Image(Option<Arc<Image>>),
    Folder(Option<FolderInfo>),
    Flag(bool),
}

pub type SyncReply = futures::channel::oneshot::Receiver<SyncAnswer>;

pub fn answered(answer: SyncAnswer) -> SyncReply {
    let (sender, reply) = futures::channel::oneshot::channel();
    let _ = sender.send(answer);
    reply
}

pub const WORDS: usize = 24;

pub fn phrase_word_count(text: &str) -> usize {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .count()
}

pub fn phrase_problem_text(problem: &PhraseProblem, secret_store: &str) -> String {
    match problem {
        PhraseProblem::WordCount(_) => "Recovery phrase must be exactly 24 words.".to_owned(),
        PhraseProblem::UnknownWord(word) => format!("“{word}” is not a valid recovery phrase word."),
        PhraseProblem::Checksum => "This recovery phrase is not valid. Please check for typos.".to_owned(),
        PhraseProblem::Mismatch => "This recovery phrase doesn’t match the synced data in this folder. Check the phrase, or choose the folder your other devices sync to.".to_owned(),
        PhraseProblem::NoData => "There’s no synced data in this folder yet. Choose the folder your other devices sync to, or wait for it to finish downloading.".to_owned(),
        PhraseProblem::Keychain => format!("Couldn’t save the sync key in {secret_store}."),
        PhraseProblem::Unavailable => "Sync isn’t available in this build.".to_owned(),
    }
}

fn model_of(name: &str) -> String {
    let parts: Vec<&str> = name.split("’s ").flat_map(|p| p.split("'s ")).collect();
    let rest = parts.get(1..).map(|r| r.join("'s ")).unwrap_or_default();
    let rest = rest.trim();
    if rest.is_empty() {
        name.to_owned()
    } else {
        rest.to_owned()
    }
}

pub fn device_label(kind: DeviceKind, name: &str) -> String {
    match kind {
        DeviceKind::Phone => "iPhone".to_owned(),
        DeviceKind::Mac => model_of(name),
    }
}

pub fn device_symbol(kind: DeviceKind, name: &str) -> &'static str {
    if kind == DeviceKind::Phone {
        return "iphone";
    }
    let lower = name.to_lowercase();
    let desktop = ["imac", "mac mini", "mac studio", "mac pro"]
        .iter()
        .any(|model| {
            lower.match_indices(model).any(|(at, _)| {
                let before = lower[..at].chars().next_back();
                let after = lower[at + model.len()..].chars().next();
                before.is_none_or(|c| !c.is_alphanumeric() && c != '_')
                    && after.is_none_or(|c| !c.is_alphanumeric() && c != '_')
            })
        });
    if desktop {
        "desktopcomputer"
    } else {
        "laptopcomputer"
    }
}

pub fn device_detail(device: &SyncedDevice, ago: impl Fn(Millis) -> String) -> String {
    let seen = match device.last_seen {
        Some(at) if at != 0 => format!("last synced {}", ago(at)),
        _ => "hasn’t synced yet".to_owned(),
    };
    let mut parts = vec![seen];
    if let Some(version) = device.version.as_ref().filter(|v| !v.is_empty()) {
        parts.push(format!("Ardia {version}"));
    }
    if let Some(os) = device.os.as_ref().filter(|v| !v.is_empty()) {
        parts.push(os.clone());
    }
    parts.join(" · ")
}

pub fn status_line(
    state: SyncState,
    last_synced_at: Option<Millis>,
    pending: u64,
    ago: impl Fn(Millis) -> String,
) -> String {
    let since = last_synced_at.map(&ago);
    let line = match state {
        SyncState::Starting => "Starting up".to_owned(),
        SyncState::Updating => "Updating".to_owned(),
        SyncState::Offline => "Offline".to_owned(),
        SyncState::Stalled | SyncState::Locked => match since {
            Some(since) => format!("Not syncing · last synced {since}"),
            None => "Not syncing".to_owned(),
        },
        _ => match since {
            Some(since) if since != "just now" => format!("Updated {since}"),
            _ => "Updated just now".to_owned(),
        },
    };
    if pending == 0 {
        line
    } else {
        format!("{line} · waiting for {} to download", files(pending))
    }
}

fn files(pending: u64) -> String {
    if pending == 1 {
        "1 file".to_owned()
    } else {
        format!("{pending} files")
    }
}

pub fn looking_for_profiles(pending: u64) -> String {
    let looking = "Looking for the profiles on your other devices…";
    if pending == 0 {
        looking.to_owned()
    } else {
        format!("{looking} Waiting for {} to download.", files(pending))
    }
}

pub fn sharing_description(profile: &RemoteProfile) -> String {
    if profile.waiting {
        return "On your other devices. Waiting for the profile it shares data with to sync."
            .to_owned();
    }
    match &profile.shares_with {
        None => "On your other devices".to_owned(),
        Some(SharesWith { name, added: true }) => {
            format!("On your other devices. Shares data with {name}, which is added too.")
        }
        Some(SharesWith { name, added: false }) => {
            format!("On your other devices. Shares data with {name}.")
        }
    }
}

pub fn remote_profile_description(profile: &RemoteProfile) -> String {
    let sharing = sharing_description(profile);
    if !profile.shared_by_others {
        return sharing;
    }
    let sharing = if sharing.ends_with('.') {
        sharing
    } else {
        format!("{sharing}.")
    };
    format!("{sharing} To remove it, first remove the profiles that share its data.")
}

pub fn joined_message(
    found: usize,
    joining: bool,
    pending: u64,
    error: Option<&str>,
    computer: &str,
    syncs_passwords: bool,
) -> String {
    if found > 0 {
        let passwords = if syncs_passwords {
            " and passwords"
        } else {
            ""
        };
        return format!(
            "These profiles are on your other devices. Add them to this {computer} to sync their pinned tabs, bookmarks, history{passwords} here too."
        );
    }
    if let Some(error) = error {
        return error.to_owned();
    }
    if joining {
        return looking_for_profiles(pending);
    }
    format!("Every profile on your other devices is on this {computer} too.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_matches_the_old_sync_sheets() {
        assert_eq!(phrase_word_count("1. Abandon, ability  able"), 3);
        assert_eq!(
            phrase_problem_text(&PhraseProblem::UnknownWord("zz".into()), "the Keychain"),
            "“zz” is not a valid recovery phrase word."
        );
        assert_eq!(
            device_label(DeviceKind::Mac, "Mantra’s MacBook Pro"),
            "MacBook Pro"
        );
        assert_eq!(device_label(DeviceKind::Mac, "Studio"), "Studio");
        assert_eq!(device_label(DeviceKind::Phone, "x"), "iPhone");
        assert_eq!(
            device_symbol(DeviceKind::Mac, "Office Mac mini"),
            "desktopcomputer"
        );
        assert_eq!(
            device_symbol(DeviceKind::Mac, "MacBook Air"),
            "laptopcomputer"
        );
        assert_eq!(
            status_line(SyncState::Updated, None, 2, |_| "x".into()),
            "Updated just now · waiting for 2 files to download"
        );
        assert_eq!(
            status_line(SyncState::Locked, Some(1), 0, |_| "5 minutes ago".into()),
            "Not syncing · last synced 5 minutes ago"
        );
        assert_eq!(
            looking_for_profiles(1),
            "Looking for the profiles on your other devices… Waiting for 1 file to download."
        );
        let mut profile = RemoteProfile {
            shares_with: Some(SharesWith {
                name: "Work".into(),
                added: true,
            }),
            ..RemoteProfile::default()
        };
        assert_eq!(
            remote_profile_description(&profile),
            "On your other devices. Shares data with Work, which is added too."
        );
        profile.shares_with = None;
        profile.shared_by_others = true;
        assert_eq!(
            remote_profile_description(&profile),
            "On your other devices. To remove it, first remove the profiles that share its data."
        );
        let device = SyncedDevice {
            last_seen: Some(5),
            version: Some("0.3.0".into()),
            os: Some("macOS 26.1".into()),
            ..SyncedDevice::default()
        };
        assert_eq!(
            device_detail(&device, |_| "just now".into()),
            "last synced just now · Ardia 0.3.0 · macOS 26.1"
        );
    }
}
