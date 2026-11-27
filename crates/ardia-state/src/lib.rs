#![cfg_attr(not(test), forbid(unsafe_code))]

mod macros;

pub mod actions;
pub mod air_traffic;
pub mod automation_rules;
pub mod bookmarks;
pub mod clean_up;
pub mod closed;
pub mod commands;
pub mod downloads;
pub mod duplicate_tabs;
pub mod extension_rules;
pub mod engines;
pub mod group_names;
pub mod group_panel;
pub mod groups;
pub mod history;
pub mod ids;
pub mod import;
pub mod json;
pub mod link_routing;
pub mod live;
pub mod migration;
pub mod new_tab_home;
pub mod model;
pub mod mute;
pub mod ntp_extras;
pub mod omnibox;
pub mod persistence;
pub mod pin_handoff;
pub mod pin_share;
pub mod profile_circles;
pub mod profiles;
pub mod settings;
pub mod shared_folders;
pub mod shortcuts;
pub mod shown_tabs;
pub mod splits;
pub mod state;
pub mod store;
pub mod sync;
pub mod sync_engine;
pub mod tab_share;
pub mod tabs;
pub mod tidy;
pub mod unread;
pub mod updates;
pub mod windows;

pub use actions::{
    Action, ActionError, ChangeSet, GroupPatch, NewTab, Outcome, PageUpdate, ProfilePatch, Topics,
};
pub use ids::{
    BookmarkId, DownloadId, EntryId, GroupId, IdGen, ProfileId, RuleId, SplitId, TabId, WindowId,
};
pub use model::Millis;
pub use persistence::{DataDir, PersistError};
pub use state::BrowserState;
pub use store::{BrowserStore, Interest, Subscription, Update};

pub fn state_version() -> &'static str {
    ardia_theme::theme_version()
}
