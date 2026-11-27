use ardia_state::BookmarkId;
use ardia_state::bookmarks::{BookmarkNode, BookmarkTree};

pub const HEIGHT: f32 = 30.0;
pub const ITEM: f32 = 24.0;
pub const ITEM_MAX_WIDTH: f32 = 190.0;
pub const ITEM_GAP: f32 = 0.0;
pub const PADDING: f32 = 8.0;
pub const TITLE_GAP: f32 = 6.0;
pub const RADIUS: f32 = 4.0;
pub const FAVICON: f32 = 14.0;
pub const ICON: f32 = 12.0;
pub const ICON_BOX: f32 = 16.0;
pub const TEXT: f32 = 12.0;
pub const MENU_WIDTH: f32 = 260.0;
pub const MENU_ROW: f32 = 28.0;
pub const OVERFLOW_WIDTH: f32 = 28.0;
pub const DIVIDER_HEIGHT: f32 = 14.0;
pub const DROP_LINE: f32 = 2.0;
pub const DROP_LINE_INSET: f32 = 4.0;
pub const DROP_RING: f32 = 1.5;
pub const DRAG_START: f32 = 4.0;
pub const GHOST_OPACITY: f32 = 0.92;
pub const MENU_OFFSET_Y: f32 = 4.0;
pub const CASCADE_OVERLAP: f32 = 4.0;
pub const HOVER_OPEN_MS: u64 = 160;
pub const MENU_MARGIN: f32 = 8.0;
pub const MENU_FAVICON: f32 = 16.0;
pub const MENU_CHEVRON_BOX: f32 = 12.0;
pub const SPRING_OPEN_MS: u64 = 550;
pub const HOVER_IN_MS: u64 = 100;
pub const HOVER_OUT_MS: u64 = 150;
pub const SLIDE_OMEGA: f32 = 90.0;
pub const SLIDE_REST: f32 = 0.25;
pub const TOGGLE_CLOSE_MS: u64 = 300;
pub const ROW_INSET: f32 = 6.0;
pub const ROW_PADDING: f32 = 10.0;
pub const ROW_RADIUS: f32 = 6.0;
pub const ICON_SLOT: f32 = 20.0;
pub const ICON_GAP: f32 = 10.0;
pub const PANEL_ICON: f32 = 13.0;
pub const FAVICON_LEFT: f32 = ROW_INSET + ROW_PADDING;
pub const FOOTER_ROWS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub mounted: usize,
    pub shown: usize,
}

pub fn bar_fit(widths: &[f32], room: f32, chevron: f32, gap: f32) -> (Fit, Vec<f32>) {
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let mut x = 0.0;
    for width in widths {
        if x >= room {
            break;
        }
        starts.push(x);
        ends.push(x + width);
        x += width + gap;
    }
    let mounted = starts.len();
    if mounted == widths.len() && ends.iter().all(|end| *end <= room) {
        return (
            Fit {
                mounted,
                shown: mounted,
            },
            starts,
        );
    }
    let limit = room - chevron;
    let mut shown = 0;
    while shown < mounted && ends[shown] <= limit {
        shown += 1;
    }
    (Fit { mounted, shown }, starts)
}

pub fn chip_width(title_width: Option<f32>, icon: f32) -> f32 {
    match title_width {
        Some(text) => (PADDING * 2.0 + icon + TITLE_GAP + text).min(ITEM_MAX_WIDTH),
        None => ITEM,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Spot {
    Slot { parent: BookmarkId, slot: usize },
    Into(BookmarkId),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ZoneItem {
    pub id: BookmarkId,
    pub start: f32,
    pub size: f32,
    pub folder: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemHit {
    Slot(usize),
    Into(BookmarkId),
}

pub fn zone_hit(items: &[ZoneItem], at: f32, dragged: Option<&BookmarkId>, gap: f32) -> ItemHit {
    let from = dragged.and_then(|d| items.iter().position(|i| &i.id == d));
    let removed = from.map_or(0.0, |from| items[from].size + gap);
    for (index, item) in items.iter().enumerate() {
        if Some(index) == from {
            continue;
        }
        let start = item.start
            - if from.is_some_and(|f| index > f) {
                removed
            } else {
                0.0
            };
        if item.folder && at > start + item.size * 0.25 && at < start + item.size * 0.75 {
            return ItemHit::Into(item.id.clone());
        }
        if at < start + item.size / 2.0 {
            return ItemHit::Slot(index);
        }
    }
    ItemHit::Slot(items.len())
}

pub fn is_within(tree: &BookmarkTree, id: &BookmarkId, ancestors: &BookmarkId) -> bool {
    id == ancestors || tree.ancestors(id.as_str()).iter().any(|a| a == ancestors)
}

pub fn move_target(
    tree: &BookmarkTree,
    id: &BookmarkId,
    spot: &Spot,
) -> Option<(BookmarkId, usize)> {
    let node = tree.get(id.as_str())?;
    let current = node.parent()?.clone();
    let parent = match spot {
        Spot::Into(folder) => folder.clone(),
        Spot::Slot { parent, .. } => parent.clone(),
    };
    if !matches!(tree.get(parent.as_str()), Some(BookmarkNode::Folder { .. }))
        || is_within(tree, &parent, id)
    {
        return None;
    }
    let children = tree.children(parent.as_str());
    match spot {
        Spot::Into(_) => (parent != current).then(|| (parent.clone(), children.len())),
        Spot::Slot { slot, .. } => {
            let from = (parent == current)
                .then(|| children.iter().position(|c| c == id))
                .flatten();
            let slot = (*slot).min(children.len());
            if let Some(from) = from
                && (slot == from || slot == from + 1)
            {
                return None;
            }
            let index = match from {
                Some(from) if slot > from => slot - 1,
                _ => slot,
            };
            Some((parent, index))
        }
    }
}

pub fn insert_target(tree: &BookmarkTree, spot: &Spot) -> Option<(BookmarkId, usize)> {
    let parent = match spot {
        Spot::Into(folder) => folder,
        Spot::Slot { parent, .. } => parent,
    };
    if !matches!(tree.get(parent.as_str()), Some(BookmarkNode::Folder { .. })) {
        return None;
    }
    let count = tree.children(parent.as_str()).len();
    Some((
        parent.clone(),
        match spot {
            Spot::Into(_) => count,
            Spot::Slot { slot, .. } => (*slot).min(count),
        },
    ))
}

pub fn link_title(url: &str, text: Option<&str>) -> String {
    if let Some(title) = text.map(str::trim).filter(|t| !t.is_empty() && *t != url) {
        return title.to_owned();
    }
    let host = ardia_state::omnibox::url::host_of(url);
    if host.is_empty() {
        url.to_owned()
    } else {
        host.strip_prefix("www.").unwrap_or(&host).to_owned()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

pub fn place_menu(
    anchor: Rect,
    level: usize,
    layer: Rect,
    width: f32,
    height: Option<f32>,
) -> (f32, f32, f32) {
    let m = MENU_MARGIN;
    let (left, mut top);
    if level == 0 {
        left = (anchor.x - FAVICON_LEFT + PADDING)
            .min(layer.x + layer.w - width - m)
            .max(m);
        top = anchor.y + anchor.h + MENU_OFFSET_Y;
    } else {
        let mut x = anchor.x + anchor.w + ROW_INSET - CASCADE_OVERLAP;
        if x + width > layer.x + layer.w - m {
            x = (anchor.x - ROW_INSET - width + CASCADE_OVERLAP).max(m);
        }
        left = x;
        top = anchor.y - ROW_INSET;
        if let Some(height) = height {
            top = top.min(layer.y + layer.h - m - height).max(layer.y + m);
        }
    }
    let max_height = (layer.y + layer.h - top - m).max(MENU_ROW * 3.0);
    (left, top, max_height)
}

pub fn room_offsets(
    count: usize,
    dragged: Option<usize>,
    slot: Option<usize>,
    width: f32,
) -> Vec<f32> {
    (0..count)
        .map(|i| {
            if Some(i) == dragged {
                return 0.0;
            }
            let pulled = if dragged.is_some_and(|from| i > from) {
                -width
            } else {
                0.0
            };
            let pushed = if slot.is_some_and(|slot| i >= slot) {
                width
            } else {
                0.0
            };
            pulled + pushed
        })
        .collect()
}

pub fn drop_line_x(
    frames: &[Option<(f32, f32)>],
    offsets: &[f32],
    dragged: Option<usize>,
    slot: usize,
    room: f32,
) -> f32 {
    for (i, frame) in frames.iter().enumerate().skip(slot) {
        if Some(i) == dragged {
            continue;
        }
        if let Some((x, _)) = frame {
            return x + offsets.get(i).copied().unwrap_or(0.0) - room / 2.0;
        }
    }
    for i in (0..slot.min(frames.len())).rev() {
        if Some(i) == dragged {
            continue;
        }
        if let Some((x, w)) = frames[i] {
            return x + w + offsets.get(i).copied().unwrap_or(0.0) + room / 2.0;
        }
    }
    room / 2.0
}

#[derive(Clone, Copy, Debug)]
pub struct Slide {
    from: f32,
    to: f32,
    start: std::time::Instant,
}

impl Slide {
    pub fn at(value: f32, now: std::time::Instant) -> Slide {
        Slide {
            from: value,
            to: value,
            start: now,
        }
    }

    pub fn value(&self, now: std::time::Instant) -> f32 {
        let t = now.saturating_duration_since(self.start).as_secs_f32();
        let wt = SLIDE_OMEGA * t;
        let left = (self.from - self.to) * (1.0 + wt) * (-wt).exp();
        if left.abs() < SLIDE_REST {
            self.to
        } else {
            self.to + left
        }
    }

    pub fn running(&self, now: std::time::Instant) -> bool {
        self.value(now) != self.to
    }

    pub fn retarget(&mut self, to: f32, now: std::time::Instant) {
        if to != self.to {
            self.from = self.value(now);
            self.to = to;
            self.start = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::ids::IdGen;

    #[test]
    fn items_fit_with_an_overflow_chevron() {
        let (fit, starts) = bar_fit(&[50.0, 50.0, 50.0], 200.0, OVERFLOW_WIDTH, 0.0);
        assert_eq!(
            fit,
            Fit {
                mounted: 3,
                shown: 3
            }
        );
        assert_eq!(starts, [0.0, 50.0, 100.0]);
        let (fit, _) = bar_fit(&[50.0, 50.0, 50.0, 50.0, 50.0], 120.0, OVERFLOW_WIDTH, 0.0);
        assert_eq!(
            fit,
            Fit {
                mounted: 3,
                shown: 1
            }
        );
        assert_eq!(chip_width(None, ICON_BOX), ITEM);
        assert_eq!(chip_width(Some(1000.0), FAVICON), ITEM_MAX_WIDTH);
        assert_eq!(
            chip_width(Some(40.0), FAVICON),
            8.0 + 14.0 + 6.0 + 40.0 + 8.0
        );
    }

    #[test]
    fn hits_pick_slots_and_folders_like_the_old_bar() {
        let item = |id: &str, start: f32, folder: bool| ZoneItem {
            id: BookmarkId::new(id),
            start,
            size: 40.0,
            folder,
        };
        let items = vec![
            item("a", 0.0, false),
            item("f", 40.0, true),
            item("c", 80.0, false),
        ];
        assert_eq!(zone_hit(&items, 5.0, None, 0.0), ItemHit::Slot(0));
        assert_eq!(zone_hit(&items, 30.0, None, 0.0), ItemHit::Slot(1));
        assert_eq!(
            zone_hit(&items, 60.0, None, 0.0),
            ItemHit::Into(BookmarkId::new("f"))
        );
        assert_eq!(zone_hit(&items, 200.0, None, 0.0), ItemHit::Slot(3));
        assert_eq!(
            zone_hit(&items, 20.0, Some(&BookmarkId::new("a")), 0.0),
            ItemHit::Into(BookmarkId::new("f"))
        );
    }

    #[test]
    fn moves_skip_no_ops_and_cycles() {
        let ids = IdGen::with_launch("fit");
        let mut tree = BookmarkTree::new("p", 0);
        let bar = tree.bar();
        let a = tree
            .add_url(&ids, &bar, None, "a", "https://a/", 0)
            .unwrap();
        let b = tree
            .add_url(&ids, &bar, None, "b", "https://b/", 0)
            .unwrap();
        let f = tree.add_folder(&ids, &bar, None, "f", 0).unwrap();
        let slot = |slot| Spot::Slot {
            parent: bar.clone(),
            slot,
        };
        assert_eq!(move_target(&tree, &a, &slot(0)), None);
        assert_eq!(move_target(&tree, &a, &slot(1)), None);
        assert_eq!(move_target(&tree, &a, &slot(3)), Some((bar.clone(), 2)));
        assert_eq!(move_target(&tree, &b, &slot(0)), Some((bar.clone(), 0)));
        assert_eq!(
            move_target(&tree, &a, &Spot::Into(f.clone())),
            Some((f.clone(), 0))
        );
        assert_eq!(move_target(&tree, &f, &Spot::Into(f.clone())), None);
        assert_eq!(insert_target(&tree, &slot(9)), Some((bar.clone(), 3)));
        assert_eq!(link_title("https://www.x.example/a", None), "x.example");
        assert_eq!(link_title("https://x.example/a", Some(" Title ")), "Title");
    }

    #[test]
    fn menus_place_below_and_cascade_right_or_left() {
        let layer = Rect {
            x: 0.0,
            y: 0.0,
            w: 1000.0,
            h: 600.0,
        };
        let anchor = Rect {
            x: 100.0,
            y: 40.0,
            w: 80.0,
            h: 24.0,
        };
        let (x, y, _) = place_menu(anchor, 0, layer, MENU_WIDTH, None);
        assert_eq!((x, y), (100.0 - FAVICON_LEFT + PADDING, 68.0));
        let row = Rect {
            x: 900.0,
            y: 100.0,
            w: 260.0,
            h: 28.0,
        };
        let (x, _, _) = place_menu(row, 1, layer, MENU_WIDTH, Some(200.0));
        assert_eq!(x, 900.0 - ROW_INSET - MENU_WIDTH + CASCADE_OVERLAP);
    }

    #[test]
    fn room_opens_behind_the_slot_and_closes_behind_the_dragged_item() {
        assert_eq!(
            room_offsets(4, Some(1), Some(3), 50.0),
            [0.0, 0.0, -50.0, 0.0]
        );
        assert_eq!(room_offsets(3, None, Some(1), 48.0), [0.0, 48.0, 48.0]);
        assert_eq!(room_offsets(3, Some(0), None, 40.0), [0.0, -40.0, -40.0]);
    }

    #[test]
    fn the_drop_line_sits_in_the_middle_of_the_room() {
        let frames = [Some((0.0, 40.0)), Some((40.0, 60.0)), Some((100.0, 30.0))];
        let offsets = room_offsets(3, None, Some(1), 48.0);
        assert_eq!(drop_line_x(&frames, &offsets, None, 1, 48.0), 64.0);
        assert_eq!(drop_line_x(&frames, &offsets, None, 3, 48.0), 202.0);
    }

    #[test]
    fn slides_settle_on_their_target_within_a_tenth_of_a_second() {
        let now = std::time::Instant::now();
        let mut slide = Slide::at(0.0, now);
        slide.retarget(48.0, now);
        assert!(slide.running(now));
        let mid = slide.value(now + std::time::Duration::from_millis(16));
        assert!(mid > 0.0 && mid < 48.0);
        assert!(!slide.running(now + std::time::Duration::from_millis(120)));
    }
}
