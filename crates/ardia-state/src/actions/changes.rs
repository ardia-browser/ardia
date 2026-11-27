use super::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Topics(u32);

impl Topics {
    pub const NONE: Topics = Topics(0);
    pub const PROFILES: Topics = Topics(1);
    pub const WINDOWS: Topics = Topics(1 << 1);
    pub const TABS: Topics = Topics(1 << 2);
    pub const GROUPS: Topics = Topics(1 << 3);
    pub const SPLITS: Topics = Topics(1 << 4);
    pub const CLOSED: Topics = Topics(1 << 5);
    pub const SETTINGS: Topics = Topics(1 << 6);
    pub const FOCUS: Topics = Topics(1 << 7);
    pub const PINS: Topics = Topics(1 << 8);
    pub const DOWNLOADS: Topics = Topics(1 << 9);
    pub const HISTORY: Topics = Topics(1 << 10);
    pub const BOOKMARKS: Topics = Topics(1 << 11);
    pub const AIR_TRAFFIC: Topics = Topics(1 << 12);
    pub const LIVE: Topics = Topics(1 << 13);
    pub const CHROME: Topics = Topics(1 << 14);
    pub const SESSION: Topics = Topics(0x1FF);
    pub const ALL: Topics = Topics(0x7FFF);

    pub const fn contains(self, other: Topics) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn intersects(self, other: Topics) -> bool {
        self.0 & other.0 != 0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl BitOr for Topics {
    type Output = Topics;

    fn bitor(self, rhs: Topics) -> Topics {
        Topics(self.0 | rhs.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChangeSet {
    pub topics: Topics,
    pub tabs: Vec<TabId>,
    pub windows: Vec<WindowId>,
    pub profiles: Vec<ProfileId>,
    pub groups: Vec<GroupId>,
    pub splits: Vec<SplitId>,
    pub cosmetic_only: bool,
}

impl Default for ChangeSet {
    fn default() -> Self {
        ChangeSet {
            topics: Topics::NONE,
            tabs: Vec::new(),
            windows: Vec::new(),
            profiles: Vec::new(),
            groups: Vec::new(),
            splits: Vec::new(),
            cosmetic_only: true,
        }
    }
}

pub(super) fn push_unique<T: PartialEq + Clone>(list: &mut Vec<T>, id: &T) {
    if !list.contains(id) {
        list.push(id.clone());
    }
}

impl ChangeSet {
    pub(super) fn note(&mut self, topics: Topics, cosmetic: bool) {
        self.topics = self.topics | topics;
        if topics.intersects(Topics::SESSION) && !cosmetic {
            self.cosmetic_only = false;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.topics.is_empty()
    }

    pub(crate) fn note_settled(
        &mut self,
        before: &crate::state::BrowserState,
        after: &crate::state::BrowserState,
    ) {
        for (id, tab) in after.tabs.iter() {
            if before.tabs.get(id).is_none_or(|was| !std::sync::Arc::ptr_eq(was, tab)) {
                self.note(Topics::TABS, false);
                push_unique(&mut self.tabs, id);
            }
        }
        for (id, window) in after.windows.iter() {
            if before
                .windows
                .get(id)
                .is_none_or(|was| !std::sync::Arc::ptr_eq(was, window))
            {
                self.note(Topics::WINDOWS, false);
                push_unique(&mut self.windows, id);
            }
        }
        if !std::sync::Arc::ptr_eq(&before.groups, &after.groups) {
            self.note(Topics::GROUPS, false);
        }
    }

    pub fn touches_tab(&self, id: &str) -> bool {
        self.tabs.iter().any(|t| t == id)
    }

    pub fn touches_window(&self, id: &str) -> bool {
        self.windows.iter().any(|w| w == id)
    }

    pub fn persists_session(&self) -> bool {
        self.topics.intersects(Topics::SESSION)
    }

    pub fn merge(&mut self, other: &ChangeSet) {
        self.topics = self.topics | other.topics;
        self.cosmetic_only &= other.cosmetic_only;
        for t in &other.tabs {
            push_unique(&mut self.tabs, t);
        }
        for w in &other.windows {
            push_unique(&mut self.windows, w);
        }
        for p in &other.profiles {
            push_unique(&mut self.profiles, p);
        }
        for g in &other.groups {
            push_unique(&mut self.groups, g);
        }
        for s in &other.splits {
            push_unique(&mut self.splits, s);
        }
    }
}
