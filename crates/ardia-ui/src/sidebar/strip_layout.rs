use std::collections::HashMap;

use ardia_state::{BrowserState, GroupId, TabId};

pub const STRIP_HEIGHT: f32 = 42.0;
pub const MID: f32 = 21.0;
pub const ITEM_HEIGHT: f32 = 32.0;
pub const ITEM_TOP: f32 = MID - ITEM_HEIGHT / 2.0;
pub const TAB_TOP: f32 = 3.0;
pub const FLARE: f32 = 15.0;
pub const RIM_HEIGHT: f32 = 27.5;
pub const RIM_WIDTH: f32 = 0.5;
pub const PINNED_CELL: f32 = 34.0;
pub const PINNED_SPACING: f32 = 2.0;
pub const PINNED_FACE_INSET: f32 = 2.0;
pub const DOCK_GAP: f32 = 4.5;
pub const COMPACT_CHIP: f32 = 32.0;
pub const TITLED_CHIP: f32 = 96.0;
pub const TITLE_MIN_CHIP: f32 = 80.0;
pub const TITLE_FADE_MIN: f32 = 8.0;
pub const TITLE_FADE_MAX: f32 = 24.0;
pub const CLOSE_MIN_CHIP: f32 = 84.0;
pub const MAX_CHIP: f32 = 173.0;
pub const SELECTED_STEPS: [f32; 3] = [MAX_CHIP, 150.0, 128.0];
pub const GAP: f32 = 4.0;
pub const CHIP_PAD_LEFT: f32 = 9.5;
pub const CHIP_PAD_RIGHT: f32 = 6.0;
pub const FAVICON: f32 = 16.0;
pub const AUDIO_BADGE: f32 = 12.0;
pub const CHIP_LABEL_GAP: f32 = 5.0;
pub const CHIP_HAIRLINE: f32 = 0.5;
pub const GROUP_CHIP_PAD_LEFT: f32 = 8.5;
pub const GROUP_CHIP_PAD_RIGHT: f32 = 7.0;
pub const GROUP_TITLE_GAP: f32 = 12.5;
pub const GROUP_TITLE_MAX: f32 = 120.0;
pub const GROUP_TITLE_TIGHT: f32 = 80.0;
pub const GROUP_DIVIDER_LENGTH: f32 = 15.0;
pub const GROUP_TRAY_ALPHA: f32 = 0.18;
pub const GROUP_TRAY_HOVER_ALPHA: f32 = 0.24;
pub const GROUP_NAME_INSET: f32 = 2.0;
pub const GROUP_ICON: f32 = 13.0;
pub const GROUP_MARGIN_LEFT: f32 = 3.5;
pub const GROUP_MARGIN_RIGHT: f32 = 4.0;
pub const MEMBERS_INSET: f32 = 6.5;
pub const TAIL_COLLAPSED: f32 = 4.5;
pub const TAIL_EXPANDED: f32 = 30.25;
pub const FOLDER_HEIGHT: f32 = 24.0;
pub const FOLDER_PAD_LEFT: f32 = 8.0;
pub const FOLDER_PAD_RIGHT: f32 = 6.0;
pub const FOLDER_TITLE_GAP: f32 = 8.0;
pub const FOLDER_TITLE_MAX: f32 = 80.0;
pub const NEW_TAB_ICON: f32 = 13.0;
pub const OVERFLOW_BOX: f32 = 22.0;
pub const OVERFLOW_GLYPH: f32 = 10.0;
pub const NEW_TAB_ROOM: f32 = ITEM_HEIGHT + GAP + OVERFLOW_BOX;

pub fn new_tab_room(show_tab_menu_button: bool) -> f32 {
    if show_tab_menu_button {
        NEW_TAB_ROOM
    } else {
        ITEM_HEIGHT
    }
}

pub fn tab_radius() -> f32 {
    crate::sidebar::row_look::chrome_radius()
}

pub fn overflow_radius() -> f32 {
    (tab_radius() - (ITEM_HEIGHT - OVERFLOW_BOX) / 2.0).max(0.0)
}
pub const CLOSE_BOX: f32 = 20.0;
pub const CLOSE_GLYPH: f32 = 9.0;
pub const EDGE_FADE: f32 = 88.0;
pub const LIGHTS_GAP: f32 = 8.0;
pub const TRAFFIC_LIGHTS_WIDTH: f32 = 78.0;
pub const PROFILE_ROOM: f32 = 140.0;
pub const DOWNLOADS_BOX: f32 = 34.0;
pub const CONTROLS_GAP: f32 = 2.0;
pub const DROP_RING_WIDTH: f32 = 1.5;

pub fn tab_close_radius() -> f32 {
    (tab_radius() - (ITEM_HEIGHT - CLOSE_BOX) / 2.0).max(0.0)
}

pub fn pinned_face_radius() -> f32 {
    (tab_radius() - PINNED_FACE_INSET).max(0.0)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Member {
    Tab(TabId),
    Split { id: String, tabs: Vec<TabId> },
    Folder { id: GroupId, tabs: Vec<TabId> },
}

impl Member {
    pub fn tabs(&self) -> Vec<TabId> {
        match self {
            Member::Tab(id) => vec![id.clone()],
            Member::Split { tabs, .. } | Member::Folder { tabs, .. } => tabs.clone(),
        }
    }

    pub fn holds(&self, tab: &TabId) -> bool {
        match self {
            Member::Tab(id) => id == tab,
            Member::Split { tabs, .. } | Member::Folder { tabs, .. } => tabs.contains(tab),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Dock(Vec<TabId>),
    Group {
        id: GroupId,
        collapsed: bool,
        members: Vec<Member>,
    },
    Member(Member),
}

pub fn strip_entries(state: &BrowserState, window: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let mut dock: Vec<TabId> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut group_at: HashMap<GroupId, usize> = HashMap::new();
    for tab in state.view_tabs(window, None) {
        if tab.live.peek || state.hidden_empty_card(tab) {
            continue;
        }
        if tab.pin.is_some() {
            match &tab.pin {
                Some(ardia_state::model::TabPin::Tile {
                    folder: Some(folder),
                }) => {
                    let key = format!("tile-folder:{}", folder.id);
                    if !seen.contains(&key) {
                        seen.push(key);
                        dock.push(tab.id.clone());
                    }
                }
                _ => dock.push(tab.id.clone()),
            }
            continue;
        }
        let innermost = ardia_state::groups::innermost_group_of(&state.groups, tab.id.as_str());
        let chain: Vec<GroupId> = innermost
            .as_ref()
            .map(|inner| {
                let mut chain = ardia_state::groups::ancestors(&state.groups, inner.as_str());
                chain.reverse();
                if chain.last() != Some(inner) {
                    chain.push(inner.clone());
                }
                chain
            })
            .unwrap_or_default();
        let root = chain.first().cloned();
        let folder = chain.get(1).cloned();
        let member = if let Some(folder) = folder {
            let key = format!("folder:{folder}");
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            let tabs = state
                .group(folder.as_str())
                .map(|g| g.tab_ids.clone())
                .unwrap_or_default();
            Member::Folder { id: folder, tabs }
        } else if let Some(split) = state.split_of(tab.id.as_str()) {
            let key = format!("split:{}", split.id);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            Member::Split {
                id: split.id.to_string(),
                tabs: split.tab_ids(),
            }
        } else {
            Member::Tab(tab.id.clone())
        };
        match root {
            Some(root) => {
                let at = match group_at.get(&root) {
                    Some(at) => *at,
                    None => {
                        let collapsed = state.group(root.as_str()).is_some_and(|g| g.collapsed);
                        out.push(Entry::Group {
                            id: root.clone(),
                            collapsed,
                            members: Vec::new(),
                        });
                        group_at.insert(root.clone(), out.len() - 1);
                        out.len() - 1
                    }
                };
                if let Some(Entry::Group { members, .. }) = out.get_mut(at) {
                    members.push(member);
                }
            }
            None => out.push(Entry::Member(member)),
        }
    }
    if !dock.is_empty() {
        out.insert(0, Entry::Dock(dock));
    }
    out
}

pub fn needing_titles(icons: &[(TabId, String)]) -> Vec<TabId> {
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for (_, icon) in icons {
        if !icon.is_empty() {
            *seen.entry(icon.as_str()).or_default() += 1;
        }
    }
    icons
        .iter()
        .filter(|(_, icon)| icon.is_empty() || seen.get(icon.as_str()).copied().unwrap_or(0) > 1)
        .map(|(id, _)| id.clone())
        .collect()
}

pub fn title_needs(state: &BrowserState, window: &str) -> Vec<TabId> {
    let icons: Vec<(TabId, String)> = state
        .view_tabs(window, None)
        .into_iter()
        .filter(|t| t.pin.is_none())
        .map(|t| {
            (
                t.id.clone(),
                t.custom_icon
                    .clone()
                    .or_else(|| t.favicon.clone())
                    .unwrap_or_default(),
            )
        })
        .collect();
    needing_titles(&icons)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabWidths {
    pub chip: f32,
    pub titled: f32,
    pub selected: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct GroupRoom {
    pub chip: f32,
    pub expanded: bool,
    pub shown: bool,
}

pub struct WidthInput<'a> {
    pub page_width: f32,
    pub dock_width: f32,
    pub groups: &'a [GroupRoom],
    pub compact_units: usize,
    pub titled_units: usize,
    pub selected_shown: bool,
    pub fixed: f32,
    pub min: f32,
    pub titled_min: f32,
    pub selected_min: f32,
    pub new_tab_room: f32,
}

fn half_point(w: f32) -> f32 {
    (w * 2.0).round() / 2.0
}

pub fn strip_tab_widths(o: &WidthInput) -> TabWidths {
    let mut room = o.page_width - o.dock_width - o.new_tab_room - GAP - o.fixed;
    for g in o.groups {
        let parts = if g.expanded {
            MEMBERS_INSET + TAIL_EXPANDED
        } else if g.shown {
            MEMBERS_INSET + TAIL_COLLAPSED
        } else {
            0.0
        };
        room -= GROUP_MARGIN_LEFT + GROUP_MARGIN_RIGHT + g.chip + parts + GAP;
    }
    let units = o.compact_units + o.titled_units + usize::from(o.selected_shown);
    if units == 0 {
        return TabWidths {
            chip: MAX_CHIP,
            titled: MAX_CHIP,
            selected: MAX_CHIP,
        };
    }
    let at = |level: f32, min: f32| min.max(MAX_CHIP.min(level));
    let selected_min = MAX_CHIP.min(o.selected_min);
    let used = |level: f32| {
        o.compact_units as f32 * at(level, o.min)
            + o.titled_units as f32 * at(level, o.titled_min)
            + if o.selected_shown {
                at(level, selected_min)
            } else {
                0.0
            }
            + units as f32 * GAP
    };
    let mut level = MAX_CHIP;
    if used(level) > room {
        let (mut lo, mut hi) = (0.0f32, MAX_CHIP);
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            if used(mid) > room {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        level = lo + 1e-6;
    }
    TabWidths {
        chip: half_point(at(level, o.min)),
        titled: half_point(at(level, o.titled_min)),
        selected: half_point(at(
            level,
            if o.selected_shown {
                selected_min
            } else {
                o.min
            },
        )),
    }
}

pub fn group_chip_width(frame: f32, natural: Option<f32>, cap: f32) -> f32 {
    frame + GROUP_TITLE_GAP - GROUP_NAME_INSET
        + natural.map_or(0.0, |n| n.min(cap) + GROUP_NAME_INSET * 2.0)
}

pub fn group_chip_frame() -> f32 {
    ((GROUP_ICON + GROUP_CHIP_PAD_LEFT + GROUP_CHIP_PAD_RIGHT) * 2.0).ceil() / 2.0
}

pub struct GroupLayout {
    pub offsets: Vec<f32>,
    pub width: f32,
}

pub fn group_layout(
    chip: f32,
    widths: &[f32],
    expanded: bool,
    shown: Option<usize>,
) -> GroupLayout {
    let mut offsets = Vec::with_capacity(widths.len());
    let mut x = 0.0;
    for w in widths {
        offsets.push(x);
        x += w + GAP;
    }
    let members = if widths.is_empty() { 0.0 } else { x - GAP };
    let width = if expanded && !widths.is_empty() {
        chip + MEMBERS_INSET + members + TAIL_EXPANDED
    } else if let Some(w) = shown.and_then(|i| widths.get(i)) {
        chip + MEMBERS_INSET + w + TAIL_COLLAPSED
    } else {
        chip
    };
    GroupLayout { offsets, width }
}

pub fn dock_width(cells: usize) -> f32 {
    if cells == 0 {
        0.0
    } else {
        cells as f32 * (PINNED_CELL + PINNED_SPACING) - PINNED_SPACING
    }
}

pub fn dock_span(cells: usize) -> f32 {
    if cells == 0 {
        0.0
    } else {
        dock_width(cells) + DOCK_GAP
    }
}

pub struct Measures<'a> {
    pub group_chip: &'a dyn Fn(&GroupId) -> f32,
    pub folder_chip: &'a dyn Fn(&GroupId) -> f32,
    pub needs_title: &'a dyn Fn(&TabId) -> bool,
    pub new_tab_room: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub selected_min: f32,
    pub titled_min: f32,
    pub compact_min: f32,
}

impl Default for Fit {
    fn default() -> Self {
        Fit {
            selected_min: MAX_CHIP,
            titled_min: TITLED_CHIP,
            compact_min: COMPACT_CHIP,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Slot {
    pub tabs: Vec<TabId>,
    pub width: f32,
    pub left: f32,
}

#[derive(Clone, Debug)]
pub struct StripLayout {
    pub widths: TabWidths,
    pub slots: Vec<Slot>,
    pub tabs_end: f32,
    pub tabs_shrink: bool,
    pub wide_shown: bool,
    pub compact_shown: usize,
    pub titled_shown: usize,
}

fn shown_tabs(m: &Member, active: &TabId) -> Vec<TabId> {
    match m {
        Member::Split { tabs, .. } => {
            if tabs.contains(active) {
                std::iter::once(active.clone())
                    .chain(tabs.iter().filter(|t| *t != active).cloned())
                    .take(2)
                    .collect()
            } else {
                tabs.iter().take(2).cloned().collect()
            }
        }
        Member::Folder { tabs, .. } => {
            if tabs.contains(active) {
                vec![active.clone()]
            } else {
                Vec::new()
            }
        }
        Member::Tab(id) => vec![id.clone()],
    }
}

impl StripLayout {
    pub fn tab_width(
        &self,
        tab: &TabId,
        active: &TabId,
        needs_title: &dyn Fn(&TabId) -> bool,
    ) -> f32 {
        if tab == active {
            self.widths.selected
        } else if needs_title(tab) {
            self.widths.titled
        } else {
            self.widths.chip
        }
    }
}

pub fn member_width(m: &Member, widths: TabWidths, active: &TabId, measures: &Measures) -> f32 {
    let tab_width = |t: &TabId| {
        if t == active {
            widths.selected
        } else if (measures.needs_title)(t) {
            widths.titled
        } else {
            widths.chip
        }
    };
    match m {
        Member::Folder { id, .. } => {
            (measures.folder_chip)(id)
                + if m.holds(active) {
                    MEMBERS_INSET + tab_width(active)
                } else {
                    0.0
                }
        }
        _ => shown_tabs(m, active).iter().map(tab_width).sum(),
    }
}

pub fn layout_strip(
    entries: &[Entry],
    active: &TabId,
    page_width: f32,
    measures: &Measures,
    fit: Fit,
    held: Option<TabWidths>,
) -> StripLayout {
    let dock_cells = entries
        .iter()
        .find_map(|e| match e {
            Entry::Dock(ids) => Some(ids.len()),
            _ => None,
        })
        .unwrap_or(0);
    let rows: Vec<&Entry> = entries
        .iter()
        .filter(|e| !matches!(e, Entry::Dock(_)))
        .collect();
    let mut visible: Vec<&Member> = Vec::new();
    for e in &rows {
        match e {
            Entry::Member(m) => visible.push(m),
            Entry::Group {
                collapsed, members, ..
            } => {
                if *collapsed {
                    visible.extend(members.iter().filter(|m| m.holds(active)));
                } else {
                    visible.extend(members.iter());
                }
            }
            Entry::Dock(_) => {}
        }
    }
    let visible_tabs: Vec<TabId> = visible.iter().flat_map(|m| shown_tabs(m, active)).collect();
    let wide_shown = visible_tabs.contains(active);
    let others: Vec<&TabId> = visible_tabs.iter().filter(|t| *t != active).collect();
    let compact_shown = others.iter().filter(|t| !(measures.needs_title)(t)).count();
    let titled_shown = others.len() - compact_shown;
    let groups: Vec<GroupRoom> = rows
        .iter()
        .filter_map(|e| match e {
            Entry::Group {
                id,
                collapsed,
                members,
            } => Some(GroupRoom {
                chip: (measures.group_chip)(id),
                expanded: !collapsed && !members.is_empty(),
                shown: members.iter().any(|m| m.holds(active)),
            }),
            _ => None,
        })
        .collect();
    let fixed: f32 = visible
        .iter()
        .map(|m| match m {
            Member::Folder { id, .. } => {
                (measures.folder_chip)(id) + if m.holds(active) { MEMBERS_INSET } else { GAP }
            }
            _ => 0.0,
        })
        .sum();
    let widths = held.unwrap_or_else(|| {
        strip_tab_widths(&WidthInput {
            page_width,
            dock_width: dock_span(dock_cells),
            groups: &groups,
            compact_units: compact_shown,
            titled_units: titled_shown,
            selected_shown: wide_shown,
            fixed,
            min: fit.compact_min,
            titled_min: fit.titled_min,
            selected_min: fit.selected_min,
            new_tab_room: measures.new_tab_room,
        })
    });
    let mut slots = Vec::new();
    let mut x = 0.0;
    for e in &rows {
        let (tabs, width, margin_left, margin_right) = match e {
            Entry::Member(m) => (
                m.tabs(),
                member_width(m, widths, active, measures),
                0.0,
                0.0,
            ),
            Entry::Group {
                id,
                collapsed,
                members,
            } => {
                let ws: Vec<f32> = members
                    .iter()
                    .map(|m| member_width(m, widths, active, measures))
                    .collect();
                let shown = members.iter().position(|m| m.holds(active));
                let g = group_layout((measures.group_chip)(id), &ws, !collapsed, shown);
                (
                    members.iter().flat_map(Member::tabs).collect(),
                    g.width,
                    GROUP_MARGIN_LEFT,
                    GROUP_MARGIN_RIGHT,
                )
            }
            Entry::Dock(_) => continue,
        };
        x += margin_left;
        slots.push(Slot {
            tabs,
            width,
            left: x,
        });
        x += width + margin_right + GAP;
    }
    let end = slots.last().map_or(0.0, |s| s.left + s.width);
    StripLayout {
        widths,
        slots,
        tabs_end: dock_span(dock_cells) + end,
        tabs_shrink: !visible_tabs.is_empty(),
        wide_shown,
        compact_shown,
        titled_shown,
    }
}

pub fn strip_fit(entries: &[Entry], active: &TabId, page_width: f32, measures: &Measures) -> Fit {
    let limit = page_width + 0.5 - GAP - measures.new_tab_room;
    let tight = SELECTED_STEPS[SELECTED_STEPS.len() - 1];
    let layout = |selected_min: f32, held: Option<TabWidths>, titled_min: f32, compact_min: f32| {
        layout_strip(
            entries,
            active,
            page_width,
            measures,
            Fit {
                selected_min,
                titled_min,
                compact_min,
            },
            held,
        )
    };
    let fits = |selected: f32| layout(selected, None, TITLED_CHIP, COMPACT_CHIP).tabs_end <= limit;
    let least = layout(
        tight,
        Some(TabWidths {
            chip: COMPACT_CHIP,
            titled: TITLED_CHIP,
            selected: tight,
        }),
        TITLED_CHIP,
        COMPACT_CHIP,
    );
    let tight_end = least.tabs_end;
    let step = |end: f32, selected: f32| {
        end + if least.wide_shown {
            selected - tight
        } else {
            0.0
        }
    };
    let readable_end = tight_end + least.compact_shown as f32 * (TITLE_MIN_CHIP - COMPACT_CHIP);
    let even_end = readable_end - least.titled_shown as f32 * (TITLED_CHIP - TITLE_MIN_CHIP);
    let readable = |selected: f32, titled: f32| {
        layout(selected, None, titled, TITLE_MIN_CHIP).tabs_end <= limit
    };
    let even = || even_end <= limit && readable(tight, TITLE_MIN_CHIP);
    if least.compact_shown > 0 {
        if let Some(selected) = SELECTED_STEPS
            .iter()
            .copied()
            .find(|s| step(readable_end, *s) <= limit && readable(*s, TITLED_CHIP))
        {
            return Fit {
                selected_min: selected,
                titled_min: TITLED_CHIP,
                compact_min: TITLE_MIN_CHIP,
            };
        }
        if even() {
            return Fit {
                selected_min: tight,
                titled_min: TITLE_MIN_CHIP,
                compact_min: TITLE_MIN_CHIP,
            };
        }
    }
    if let Some(selected) = SELECTED_STEPS
        .iter()
        .copied()
        .find(|s| step(tight_end, *s) <= limit && fits(*s))
    {
        return Fit {
            selected_min: selected,
            titled_min: TITLED_CHIP,
            compact_min: COMPACT_CHIP,
        };
    }
    if least.compact_shown == 0 && even() {
        return Fit {
            selected_min: tight,
            titled_min: TITLE_MIN_CHIP,
            compact_min: TITLE_MIN_CHIP,
        };
    }
    Fit {
        selected_min: tight,
        titled_min: TITLED_CHIP,
        compact_min: COMPACT_CHIP,
    }
}

pub fn under_pressure(fit: Fit) -> bool {
    fit.selected_min < MAX_CHIP || fit.titled_min < TITLED_CHIP
}

pub fn new_tab_pinned(
    chip: f32,
    tabs_end: f32,
    page_width: f32,
    tabs_shrink: bool,
    new_tab_room: f32,
) -> bool {
    (chip <= COMPACT_CHIP || !tabs_shrink) && tabs_end + GAP + new_tab_room > page_width + 0.5
}

pub fn title_fade(width: f32) -> f32 {
    ((width - CHIP_PAD_LEFT - FAVICON - CHIP_LABEL_GAP - CHIP_PAD_RIGHT) / 3.0)
        .clamp(TITLE_FADE_MIN, TITLE_FADE_MAX)
}

pub fn reveal_offset(left: f32, width: f32, scrolled: f32, viewport: f32, pad: f32) -> Option<f32> {
    let to_start = left - pad;
    let to_end = left + width + pad - viewport;
    let target = if to_start < scrolled {
        to_start
    } else if to_end > scrolled {
        to_start.min(to_end)
    } else {
        scrolled
    };
    let clamped = target.max(0.0);
    ((clamped - scrolled).abs() >= 0.5).then_some(clamped)
}

pub fn drop_index(slots: &[Slot], from: usize, dx: f32) -> usize {
    let Some(moving) = slots.get(from) else {
        return 0;
    };
    let left = moving.left + dx;
    let right = left + moving.width;
    slots
        .iter()
        .enumerate()
        .filter(|(i, slot)| {
            let centre = slot.left + slot.width / 2.0;
            if *i < from {
                centre < left
            } else {
                *i > from && centre < right
            }
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none(_: &TabId) -> bool {
        false
    }

    fn chip(_: &GroupId) -> f32 {
        50.0
    }

    fn tabs(n: usize) -> Vec<Entry> {
        (0..n)
            .map(|i| Entry::Member(Member::Tab(TabId::new(format!("t{i}")))))
            .collect()
    }

    #[test]
    fn roomy_strips_give_every_tab_the_full_width() {
        let measures = Measures {
            group_chip: &chip,
            folder_chip: &chip,
            needs_title: &none,
            new_tab_room: NEW_TAB_ROOM,
        };
        let entries = tabs(3);
        let layout = layout_strip(
            &entries,
            &TabId::new("t0"),
            1400.0,
            &measures,
            Fit::default(),
            None,
        );
        assert_eq!(layout.widths.selected, MAX_CHIP);
        assert_eq!(layout.widths.chip, MAX_CHIP);
        assert_eq!(layout.slots[1].left, MAX_CHIP + GAP);
        assert!(!new_tab_pinned(
            layout.widths.chip,
            layout.tabs_end,
            1400.0,
            layout.tabs_shrink,
            NEW_TAB_ROOM
        ));
    }

    #[test]
    fn crowded_strips_shrink_others_first_and_keep_the_selected_tab_readable() {
        let measures = Measures {
            group_chip: &chip,
            folder_chip: &chip,
            needs_title: &none,
            new_tab_room: NEW_TAB_ROOM,
        };
        let entries = tabs(30);
        let active = TabId::new("t3");
        let fit = strip_fit(&entries, &active, 1000.0, &measures);
        let layout = layout_strip(&entries, &active, 1000.0, &measures, fit, None);
        assert!(layout.widths.selected >= 128.0);
        assert_eq!(layout.widths.chip, COMPACT_CHIP);
        assert!(new_tab_pinned(
            layout.widths.chip,
            layout.tabs_end,
            1000.0,
            layout.tabs_shrink,
            NEW_TAB_ROOM
        ));
        assert!(under_pressure(fit));
    }

    #[test]
    fn hiding_the_tab_menu_button_gives_its_room_back_to_the_tabs() {
        assert_eq!(new_tab_room(true), NEW_TAB_ROOM);
        assert_eq!(new_tab_room(false), ITEM_HEIGHT);
        assert_eq!(overflow_radius(), 5.0);
        let with_button = Measures {
            group_chip: &chip,
            folder_chip: &chip,
            needs_title: &none,
            new_tab_room: new_tab_room(true),
        };
        let without = Measures {
            new_tab_room: new_tab_room(false),
            ..with_button
        };
        let entries = tabs(30);
        let active = TabId::new("t3");
        let wide = layout_strip(&entries, &active, 1000.0, &without, Fit::default(), None);
        let narrow = layout_strip(
            &entries,
            &active,
            1000.0,
            &with_button,
            Fit::default(),
            None,
        );
        assert!(wide.widths.chip >= narrow.widths.chip);
        let end = 1000.0 - GAP - ITEM_HEIGHT - 1.0;
        assert!(!new_tab_pinned(
            COMPACT_CHIP,
            end,
            1000.0,
            true,
            new_tab_room(false)
        ));
        assert!(new_tab_pinned(
            COMPACT_CHIP,
            end,
            1000.0,
            true,
            new_tab_room(true)
        ));
    }

    #[test]
    fn groups_take_their_chip_members_and_tail() {
        let g = group_layout(50.0, &[173.0, 173.0], true, Some(0));
        assert_eq!(
            g.width,
            50.0 + MEMBERS_INSET + 173.0 + GAP + 173.0 + TAIL_EXPANDED
        );
        let g = group_layout(50.0, &[173.0, 100.0], false, Some(1));
        assert_eq!(g.width, 50.0 + MEMBERS_INSET + 100.0 + TAIL_COLLAPSED);
        assert_eq!(group_layout(50.0, &[173.0], false, None).width, 50.0);
        assert_eq!(group_chip_frame(), 28.5);
        assert_eq!(
            group_chip_width(28.5, Some(12.0), GROUP_TITLE_MAX),
            28.5 + 10.5 + 16.0
        );
    }

    #[test]
    fn shared_or_missing_icons_need_titles() {
        let icons = vec![
            (TabId::new("a"), "x.png".to_owned()),
            (TabId::new("b"), "x.png".to_owned()),
            (TabId::new("c"), "y.png".to_owned()),
            (TabId::new("d"), String::new()),
        ];
        assert_eq!(
            needing_titles(&icons),
            vec![TabId::new("a"), TabId::new("b"), TabId::new("d")]
        );
    }

    #[test]
    fn dock_math_matches_the_measured_pinned_group() {
        assert_eq!(dock_width(2), 70.0);
        assert_eq!(dock_span(2), 74.5);
        assert_eq!(dock_span(0), 0.0);
        assert_eq!(tab_close_radius(), 4.0);
        assert_eq!(title_fade(173.0), 24.0);
        assert_eq!(title_fade(40.0), TITLE_FADE_MIN);
    }

    #[test]
    fn dragging_past_a_neighbours_centre_moves_the_slot() {
        let slots: Vec<Slot> = (0..3)
            .map(|i| Slot {
                tabs: vec![TabId::new(format!("t{i}"))],
                width: 100.0,
                left: i as f32 * 104.0,
            })
            .collect();
        assert_eq!(drop_index(&slots, 0, 0.0), 0);
        assert_eq!(drop_index(&slots, 0, 60.0), 1);
        assert_eq!(drop_index(&slots, 0, 170.0), 2);
        assert_eq!(drop_index(&slots, 2, -170.0), 0);
        assert_eq!(reveal_offset(500.0, 100.0, 0.0, 400.0, 92.0), Some(292.0));
        assert_eq!(reveal_offset(50.0, 100.0, 0.0, 400.0, 10.0), None);
    }
}
