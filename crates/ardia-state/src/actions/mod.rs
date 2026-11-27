use crate::air_traffic::AirTrafficConfig;
use crate::bookmarks::{BookmarkError, BookmarkTree};
use crate::closed::{
    ClearedTabs, ClosedEntry, ClosedGroup, ClosedTab, ClosedWindow, ClosedWindowFrame,
    ClosedWindowGroup, ClosedWindowTab, ParkedGroup, ParkedPins, ParkedTab, SplitShape,
};
use crate::downloads::Download;
use crate::groups::{self, GroupColor, TabGroup};
use crate::history::History;
use crate::ids::{BookmarkId, EntryId, GroupId, IdGen, ProfileId, SplitId, TabId, WindowId};
use crate::model::{Frame, Millis, Orientation, PageEngine, PageKind, TabLayout, TabPage, TabPin};
use crate::omnibox::url::resolve_input;
use crate::profiles::{ColorChoice, Profile};
use crate::settings::{AfterClosingTab, NewTabPosition, SettingsPatch};
use crate::shortcuts::{Shortcut, reset_override, set_override};
use crate::splits::{MAX_SPLIT_PANES, PaneDirection, SplitSide, SplitView, even_slots};
use crate::state::{BrowserState, order_sections, section_rank};
use crate::tabs::{FindState, SecurityState, SitePrompt, Tab, TabSnapshot};
use crate::windows::{BrowserWindow, CommandBarState, PeekCard, Popover, Toast, WindowKind};
use ardia_theme::{IconTheme, ProfileColor, ProfileTheme, RgbaColor};
use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};
use std::ops::BitOr;
use std::sync::Arc;

mod action;
mod bookmarks_edit;
mod changes;
mod closing;
mod group_moves;
mod group_ops;
mod library;
mod peek;
mod pin_mirror;
mod placement;
mod profile_moves;
mod profile_ops;
mod reopen;
mod split_ops;
mod tab_mirror;
mod tab_ops;
mod tidy_ops;
mod tile_folders;
mod window_ops;

use crate::omnibox::url::same_page;
pub use action::{Action, GroupPatch, NewTab, PageUpdate, ProfilePatch};
use changes::push_unique;
pub use changes::{ChangeSet, Topics};
pub use group_moves::can_move_group;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ActionError {
    #[error("there is no window {0}")]
    NoWindow(String),
    #[error("there is no tab {0}")]
    NoTab(String),
    #[error("there is no profile {0}")]
    NoProfile(String),
    #[error("there is no group {0}")]
    NoGroup(String),
    #[error("there is no split {0}")]
    NoSplit(String),
    #[error("{0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Bookmark(#[from] BookmarkError),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    pub changes: ChangeSet,
    pub tab: Option<TabId>,
    pub window: Option<WindowId>,
    pub group: Option<GroupId>,
    pub split: Option<SplitId>,
    pub profile: Option<ProfileId>,
    pub closed_windows: Vec<WindowId>,
    pub bookmark: Option<BookmarkId>,
}

pub struct Tx<'a> {
    pub(crate) s: &'a mut BrowserState,
    pub(crate) now: Millis,
    pub(crate) ids: &'a IdGen,
    pub(crate) out: Outcome,
    pub(crate) keeps_top_apps: Option<bool>,
}

impl<'a> Tx<'a> {
    pub(crate) fn new(s: &'a mut BrowserState, now: Millis, ids: &'a IdGen) -> Self {
        Tx {
            s,
            now,
            ids,
            out: Outcome::default(),
            keeps_top_apps: None,
        }
    }

    pub(crate) fn keep_top_apps(&self) -> bool {
        self.keeps_top_apps
            .unwrap_or(self.s.settings.keep_top_apps_running)
    }

    fn note_tab(&mut self, id: &TabId, topics: Topics, cosmetic: bool) {
        self.out.changes.note(topics, cosmetic);
        push_unique(&mut self.out.changes.tabs, id);
    }

    fn note_window(&mut self, id: &WindowId, topics: Topics) {
        self.out.changes.note(topics, false);
        push_unique(&mut self.out.changes.windows, id);
    }

    fn tab_mut(&mut self, id: &TabId) -> Option<&mut Tab> {
        self.tab_mut_as(id, Topics::TABS, false)
    }

    fn tab_mut_as(&mut self, id: &TabId, topics: Topics, cosmetic: bool) -> Option<&mut Tab> {
        if !self.s.tabs.contains_key(id) {
            return None;
        }
        self.note_tab(id, topics, cosmetic);
        Arc::make_mut(&mut self.s.tabs)
            .get_mut(id)
            .map(Arc::make_mut)
    }

    fn window_mut(&mut self, id: &WindowId) -> Option<&mut BrowserWindow> {
        self.window_mut_as(id, Topics::WINDOWS)
    }

    fn window_mut_as(&mut self, id: &WindowId, topics: Topics) -> Option<&mut BrowserWindow> {
        if !self.s.windows.contains_key(id) {
            return None;
        }
        self.note_window(id, topics);
        Arc::make_mut(&mut self.s.windows)
            .get_mut(id)
            .map(Arc::make_mut)
    }

    fn edit_tab(
        &mut self,
        id: &TabId,
        topics: Topics,
        cosmetic: bool,
        edit: impl FnOnce(&mut Tab),
    ) -> Result<bool, ActionError> {
        let current = self.require_tab(id)?;
        let mut next = (*current).clone();
        edit(&mut next);
        if next == *current {
            return Ok(false);
        }
        self.note_tab(id, topics, cosmetic);
        Arc::make_mut(&mut self.s.tabs).insert(id.clone(), Arc::new(next));
        Ok(true)
    }

    fn edit_window(
        &mut self,
        id: &WindowId,
        topics: Topics,
        edit: impl FnOnce(&mut BrowserWindow),
    ) -> Result<bool, ActionError> {
        let current = self.require_window(id)?;
        let mut next = (*current).clone();
        edit(&mut next);
        if next == *current {
            return Ok(false);
        }
        self.note_window(id, topics);
        Arc::make_mut(&mut self.s.windows).insert(id.clone(), Arc::new(next));
        Ok(true)
    }

    fn group_mut(&mut self, id: &GroupId) -> Option<&mut TabGroup> {
        if !self.s.groups.contains_key(id) {
            return None;
        }
        self.out.changes.note(Topics::GROUPS, false);
        push_unique(&mut self.out.changes.groups, id);
        Arc::make_mut(&mut self.s.groups)
            .get_mut(id)
            .map(Arc::make_mut)
    }

    fn set_groups(&mut self, groups: groups::Groups) {
        self.out.changes.note(Topics::GROUPS, false);
        self.s.groups = Arc::new(groups);
    }

    fn splits_mut(&mut self) -> &mut crate::state::SplitMap {
        self.out.changes.note(Topics::SPLITS, false);
        Arc::make_mut(&mut self.s.splits)
    }

    fn closed_mut(&mut self) -> &mut crate::closed::ClosedLists {
        self.out.changes.note(Topics::CLOSED, false);
        Arc::make_mut(&mut self.s.closed)
    }

    fn require_window(&self, id: &WindowId) -> Result<Arc<BrowserWindow>, ActionError> {
        self.s
            .windows
            .get(id)
            .cloned()
            .ok_or_else(|| ActionError::NoWindow(id.to_string()))
    }

    fn require_tab(&self, id: &TabId) -> Result<Arc<Tab>, ActionError> {
        self.s
            .tabs
            .get(id)
            .cloned()
            .ok_or_else(|| ActionError::NoTab(id.to_string()))
    }

    fn require_listed_tab(&self, id: &TabId) -> Result<Arc<Tab>, ActionError> {
        let tab = self.require_tab(id)?;
        if tab.live.peek {
            return Err(ActionError::Invalid("a peek isn't in the tab list yet"));
        }
        Ok(tab)
    }

    fn is_listed(&self, id: &TabId) -> bool {
        self.s.tabs.get(id).is_some_and(|t| !t.live.peek)
    }

    fn resolve_url(&self, input: &str) -> String {
        resolve_input(input, &self.s.default_search_engine().url)
    }

    fn history_mut(&mut self, profile: &ProfileId) -> &mut History {
        let key = self.s.engine_profile(profile);
        self.out.changes.note(Topics::HISTORY, false);
        Arc::make_mut(Arc::make_mut(&mut self.s.history).entry(key).or_default())
    }

    fn bookmarks_mut(&mut self, profile: &ProfileId) -> &mut BookmarkTree {
        let key = self.s.engine_profile(profile);
        let now = self.now;
        self.out.changes.note(Topics::BOOKMARKS, false);
        Arc::make_mut(
            Arc::make_mut(&mut self.s.bookmarks)
                .entry(key.clone())
                .or_insert_with(|| Arc::new(BookmarkTree::new(&key, now))),
        )
    }

    fn settle_groups(&mut self) {
        if !self.out.changes.topics.intersects(Topics::GROUPS) {
            return;
        }
        let nested = groups::nest_groups(&self.s.groups);
        if nested == *self.s.groups {
            return;
        }
        let windows: HashSet<WindowId> = nested
            .values()
            .chain(self.s.groups.values())
            .map(|g| g.window_id.clone())
            .collect();
        self.s.groups = Arc::new(nested);
        for window in windows {
            self.reorder_window(&window);
        }
    }

    fn settle_windows(&mut self) {
        let touched: Vec<WindowId> = self
            .out
            .changes
            .windows
            .iter()
            .filter(|w| self.s.windows.get(*w).is_some_and(|w| w.kind.has_tabs()))
            .cloned()
            .collect();
        for window in touched {
            let w = self.s.windows[&window].clone();
            if w.active_tab().is_some_and(|t| {
                self.s
                    .tabs
                    .get(t)
                    .is_some_and(|t| t.window_id == window && t.profile_id == w.profile_id)
            }) {
                continue;
            }
            let shown = w
                .tab_ids
                .iter()
                .find(|t| {
                    self.s
                        .tabs
                        .get(*t)
                        .is_some_and(|t| t.profile_id == w.profile_id)
                })
                .cloned();
            match shown {
                Some(tab) => self.activate(&tab),
                None if w.tab_ids.is_empty() => self.close_window(&window, false),
                None => {
                    let _ = self.new_tab(
                        &window,
                        NewTab {
                            profile: Some(w.profile_id.clone()),
                            ..NewTab::default()
                        },
                    );
                }
            }
        }
    }

    fn run(&mut self, action: Action) -> Result<(), ActionError> {
        match action {
            Action::OpenWindow {
                kind,
                profile,
                url,
                frame,
            } => self.open_window(kind, profile, url, frame).map(|_| ()),
            Action::CloseWindow { window } => {
                self.require_window(&window)?;
                self.close_window(&window, true);
                Ok(())
            }
            Action::OpenLastWindowOrNew => self.open_last_window_or_new().map(|_| ()),
            Action::FocusWindow { window } => self.focus_window(&window),
            Action::SetWindowFrame {
                window,
                frame,
                maximized,
            } => self
                .edit_window(&window, Topics::WINDOWS, |w| {
                    if maximized && !w.maximized {
                        w.restored_frame = w.frame;
                    }
                    w.frame = frame.filter(Frame::is_valid);
                    w.maximized = maximized;
                })
                .map(|_| ()),
            Action::SetFullScreen {
                window,
                on,
                display,
            } => {
                let now = self.now;
                self.edit_window(&window, Topics::WINDOWS, |w| {
                    w.full_screen = on.then_some(w.full_screen.unwrap_or(now));
                    w.display = if on {
                        display.or(w.display.take())
                    } else {
                        None
                    };
                })
                .map(|_| ())
            }
            Action::ToggleSidebar { window } => {
                let hidden = self.s.auto_hides_tabs(window.as_str());
                self.edit_window(&window, Topics::WINDOWS, |w| {
                    w.auto_hide_tabs = Some(!hidden)
                })
                .map(|_| ())
            }
            Action::SetSidebarPeeking { window, peeking } => self
                .edit_window(&window, Topics::CHROME, |w| {
                    w.chrome.sidebar_peeking = peeking
                })
                .map(|_| ()),
            Action::SetTabLayout {
                window: Some(window),
                layout,
            } => self
                .edit_window(&window, Topics::WINDOWS, |w| w.tab_layout = Some(layout))
                .map(|_| ()),
            Action::SetTabLayout {
                window: None,
                layout,
            } => {
                self.update_settings(&SettingsPatch::new().set("tabLayout", layout), false);
                Ok(())
            }
            Action::SwitchProfile { window, profile } => self.switch_profile(&window, &profile),
            Action::PromoteLittleArdia { window } => self.promote_little(&window).map(|_| ()),
            Action::NewTab { window, tab } => self.new_tab(&window, tab).map(|_| ()),
            Action::ActivateTab { tab } => {
                self.require_tab(&tab)?;
                self.switch_to(&tab);
                Ok(())
            }
            Action::SelectTabAt { window, index } => self.select_at(&window, index),
            Action::CycleTab { window, delta } => self.cycle(&window, delta),
            Action::CloseTabs {
                tabs,
                last_closes_window,
            } => {
                self.close_tabs(&tabs, last_closes_window);
                Ok(())
            }
            Action::CloseSyncedTabs { tabs } => {
                self.close_tabs_recording(&tabs, false, false);
                Ok(())
            }
            Action::ReopenClosed { window } => self.reopen(window.as_ref()),
            Action::RestoreClosed { id, window } => self.restore_entry(&id, window.as_ref()),
            Action::ClearRecentlyClosed { window } => {
                self.clear_recently_closed(window.as_ref());
                Ok(())
            }
            Action::MoveTab { tab, window, index } => self.move_tab(&tab, &window, index),
            Action::SetPin { tab, pin } => self.set_pin(&tab, pin),
            Action::MoveTabsToProfile {
                tabs,
                profile,
                before,
                background,
            } => self.move_tabs_to_profile(&tabs, &profile, before.as_ref(), background),
            Action::RenameTab { tab, title } => {
                let title = title
                    .map(|s| crate::tabs::single_line(s.trim()))
                    .filter(|s| !s.is_empty());
                self.edit_tab(&tab, Topics::TABS, false, |t| t.custom_title = title)
                    .map(|_| ())
            }
            Action::SetTileLetters { tab, letters } => self
                .edit_tab(&tab, Topics::TABS, false, |t| t.tile_letters = letters)
                .map(|_| ()),
            Action::SetTabLiveItem {
                tab,
                live_item,
                home,
            } => self
                .edit_tab(&tab, Topics::TABS, false, |t| {
                    t.live_item = live_item;
                    if let Some(home) = home {
                        t.pinned_url = home.filter(|h| !h.is_empty());
                    }
                })
                .map(|_| ()),
            Action::SetTabIcon { tab, icon } => self
                .edit_tab(&tab, Topics::TABS, false, |t| {
                    t.custom_icon = icon.filter(|s| !s.is_empty())
                })
                .map(|_| ()),
            Action::SetMuted { tab, muted } => self
                .edit_tab(&tab, Topics::TABS, false, |t| t.muted = muted)
                .map(|_| ()),
            Action::SetSiteMuted { tab, muted } => self.set_site_muted(&tab, muted),
            Action::SetZoom { tab, zoom } => {
                if !(zoom.is_finite() && (0.25..=5.0).contains(&zoom)) {
                    return Err(ActionError::Invalid("zoom must be between 25% and 500%"));
                }
                self.edit_tab(&tab, Topics::TABS, false, |t| t.zoom = zoom)
                    .map(|_| ())
            }
            Action::SetEngine { tab, engine } => self
                .edit_tab(&tab, Topics::TABS, false, |t| t.engine = engine)
                .map(|_| ()),
            Action::Navigate { tab, input } => self.navigate(&tab, &input),
            Action::UpdatePage { tab, update } => self.update_page(&tab, update),
            Action::SetPrompts { tab, prompts } => self
                .edit_tab(&tab, Topics::LIVE, true, |t| t.live.prompts = prompts)
                .map(|_| ()),
            Action::SleepTabs { tabs } => {
                self.sleep_tabs(&tabs);
                Ok(())
            }
            Action::UnloadTopApp { tab } => {
                self.unload_top_app(&tab);
                Ok(())
            }
            Action::ForgetPages { tabs } => {
                self.forget_pages(&tabs);
                Ok(())
            }
            Action::DuplicateTab { tab } => self.duplicate(&tab).map(|_| ()),
            Action::SelectTabs { window, tabs } => {
                let valid: Vec<TabId> = tabs
                    .into_iter()
                    .filter(|t| {
                        self.s
                            .tabs
                            .get(t)
                            .is_some_and(|tab| tab.window_id == window)
                    })
                    .collect();
                let w = self
                    .window_mut_as(&window, Topics::CHROME)
                    .ok_or_else(|| ActionError::NoWindow(window.to_string()))?;
                w.chrome.selection_anchor = valid.first().cloned();
                w.chrome.selection = valid;
                Ok(())
            }
            Action::ReturnToPinnedUrl { tab } => self.return_to_pinned(&tab),
            Action::SetPinnedUrl { tab, url } => self.set_pinned_url(&tab, url),
            Action::ClearUnpinned { window } => self.clear_unpinned(&window).map(|_| ()),
            Action::CloseDuplicateTabs { window } => self.close_duplicate_tabs(&window).map(|_| ()),
            Action::ArrangeTabs { window, tabs } => self.arrange_tabs(&window, &tabs),
            Action::CleanUpTabs { tabs } => {
                self.clean_up_tabs(&tabs);
                Ok(())
            }
            Action::UndoClear { window } => self.undo_clear(&window).map(|_| ()),
            Action::TidyTabs { window, profile } => self.tidy_tabs(&window, profile.as_ref()),
            Action::TidyPins { window } => {
                self.tidy_in(&window, None, crate::tidy::TidyScope::Pins)
            }
            Action::UntidyTabs { tidied } => self.untidy_tabs(&tidied),
            Action::CreateGroup { tabs, name } => self.create_group(&tabs, &name).map(|_| ()),
            Action::UpdateGroup { group, patch } => self.update_group(group, patch),
            Action::AddToGroup { group, tabs } => self.add_to_group(group, tabs),
            Action::RemoveFromGroups { tabs } => self.remove_from_groups(tabs),
            Action::Ungroup { group } => self.ungroup(group),
            Action::CloseGroup { group } => self.close_group(&group),
            Action::DeleteGroup { group } => self.delete_group(&group),
            Action::DuplicateGroup { group } => self.duplicate_group(&group).map(|_| ()),
            Action::NewNestedGroup { parent } => self.new_nested_group(&parent).map(|_| ()),
            Action::MoveGroupToWindow { group, window } => {
                self.move_group_to_window(&group, &window)
            }
            Action::SplitTabs { tabs, orientation } => {
                self.split_tabs(&tabs, orientation).map(|_| ())
            }
            Action::OpenSplitPane { window, side, url } => {
                self.open_split_pane(&window, side, url).map(|_| ())
            }
            Action::RemoveFromSplit { tab } => self.remove_from_split(tab),
            Action::Unsplit { split } => self.unsplit(split),
            Action::SwapPanes { a, b } => self.swap_panes(a, b),
            Action::ResizeSplit { split, sizes } => self.resize_split(split, sizes),
            Action::RestackSplit { split, stack_sizes } => self.restack_split(split, stack_sizes),
            Action::FlipSplit { split } => self.flip_split(split),
            Action::FocusPane { window, delta } => self.focus_pane(&window, delta),
            Action::MovePane { tab, direction } => self.move_pane(&tab, direction),
            Action::MoveGroup {
                group,
                before,
                pinned,
                parent,
            } => self.move_group(&group, before.as_ref(), pinned, parent.as_ref()),
            Action::AddToTileFolder { tabs, onto, before } => {
                self.add_to_tile_folder(&tabs, &onto, before.as_ref())
            }
            Action::LeaveTileFolder { tabs } => self.leave_tile_folder(&tabs),
            Action::RenameTileFolder {
                window,
                folder,
                name,
            } => self.rename_tile_folder(&window, &folder, &name),
            Action::DropIntoSplit { tab, anchor, side } => {
                self.drop_into_split(&tab, &anchor, side)
            }
            Action::ReplaceSplitPane { pane, tab } => self.replace_split_pane(&pane, &tab),
            Action::RemoveEmptySplitPane { tab } => self.remove_empty_split_pane(&tab),
            Action::CreateProfile { name, color, icon } => {
                self.create_profile(&name, color, icon).map(|_| ())
            }
            Action::UpdateProfile { profile, patch } => self.update_profile(&profile, patch),
            Action::ShareProfileData { profile, with } => self.share_profile_data(&profile, &with),
            Action::DeleteProfile { profile } => self.delete_profile(&profile),
            Action::ReorderProfiles { order } => self.reorder_profiles(order),
            Action::UpdateSettings { patch, from_sync } => {
                self.update_settings(&patch, from_sync);
                Ok(())
            }
            Action::SetShortcut { id, shortcut } => self.set_shortcut(id, shortcut),
            Action::ResetShortcut { id } => self.reset_shortcut(id),
            Action::SetFind { tab, find } => self
                .edit_tab(&tab, Topics::LIVE, true, |t| t.live.find = find)
                .map(|_| ()),
            Action::SetPopover { window, popover } => self
                .edit_window(&window, Topics::CHROME, |w| w.chrome.popover = popover)
                .map(|_| ()),
            Action::SetCommandBar { window, state } => self
                .edit_window(&window, Topics::CHROME, |w| w.chrome.command_bar = state)
                .map(|_| ()),
            Action::OpenPeek {
                window,
                url,
                source,
            } => self.open_peek(&window, &url, source).map(|_| ()),
            Action::OpenPeekAt {
                window,
                url,
                source,
                click_px,
            } => self
                .open_peek_at(&window, &url, source, click_px)
                .map(|_| ()),
            Action::ClosePeek { window } => self.close_peek(&window),
            Action::PromotePeek { window } => self.promote_peek(&window).map(|_| ()),
            Action::PushToast { window, toast } => self.push_toast(window, toast),
            Action::DismissToast { window, id } => self.dismiss_toast(window, id),
            Action::UpsertDownload { download } => self.upsert_download(download),
            Action::RemoveDownload { id } => self.remove_download(id),
            Action::ClearDownloads => self.clear_downloads(),
            Action::RecordVisit {
                profile,
                url,
                title,
                favicon,
            } => self.record_visit(profile, url, title, favicon),
            Action::RemoveHistory { profile, url } => self.remove_history(profile, url),
            Action::RemoveHistoryPages { profile, urls } => {
                self.remove_history_pages(profile, urls)
            }
            Action::ClearHistory {
                profile,
                since,
                until,
            } => self.clear_history(profile, since, until),
            Action::ReplaceHistory { profile, entries } => self.replace_history(profile, entries),
            Action::AddBookmark {
                profile,
                parent,
                title,
                url,
            } => self.add_bookmark(profile, parent, title, url),
            Action::RemoveBookmark { profile, id } => self.remove_bookmark(profile, id),
            Action::MoveBookmark {
                profile,
                id,
                parent,
                index,
            } => self.move_bookmark(profile, id, parent, index),
            Action::SetAirTraffic { config } => self.set_air_traffic(config),
            Action::RenameBookmark { profile, id, title } => {
                self.rename_bookmark(profile, id, title)
            }
            Action::UpdateBookmark {
                profile,
                id,
                title,
                url,
            } => self.update_bookmark(profile, id, title, url),
            Action::AddBookmarkFolder {
                profile,
                parent,
                title,
                index,
            } => self.add_bookmark_folder(profile, parent, title, index),
            Action::AddBookmarkAt {
                profile,
                parent,
                index,
                title,
                url,
            } => self.add_bookmark_at(profile, parent, index, title, url),
            Action::MoveBookmarks {
                profile,
                ids,
                parent,
                index,
            } => self.move_bookmarks(profile, ids, parent, index),
            Action::RemoveBookmarks { profile, ids } => self.remove_bookmarks(profile, ids),
            Action::RestoreBookmarks { profile, removed } => {
                self.restore_bookmarks(profile, removed)
            }
        }
    }
}

impl BrowserState {
    pub fn reduce(
        &self,
        action: Action,
        now: Millis,
        ids: &IdGen,
    ) -> Result<(BrowserState, Outcome), ActionError> {
        let mut next = self.clone();
        let mut tx = Tx::new(&mut next, now, ids);
        tx.run(action)?;
        tx.settle_groups();
        tx.settle_windows();
        tx.mirror_pins(self);
        tx.pages_into_splits(self);
        tx.mirror_tabs(self);
        tx.unshare_tabs(self);
        let mut out = std::mem::take(&mut tx.out);
        if let Some(groups) = crate::shown_tabs::settle_shown_tabs(&next, self) {
            next.groups = Arc::new(groups);
            out.changes.note(Topics::GROUPS, false);
        }
        if let Some(settled) = crate::pin_share::settle_shared_pins(&next, self) {
            out.changes.note_settled(&next, &settled);
            next = settled;
        }
        if let Some(settled) = peek::settle_stranded_peeks(&next) {
            out.changes.note_settled(&next, &settled);
            next = settled;
        }
        crate::closed::fingerprint_fresh_clears(&mut next, self);
        Ok((next, out))
    }

    pub fn apply(
        &mut self,
        action: Action,
        now: Millis,
        ids: &IdGen,
    ) -> Result<Outcome, ActionError> {
        let (next, out) = self.reduce(action, now, ids)?;
        *self = next;
        Ok(out)
    }
}
