use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

use gpui::{
    AnyElement, Bounds, IntoElement, ParentElement, Pixels, ScrollHandle, SharedString, Styled,
    div, point,
};

use crate::scale::{points, px};

pub const OVERSCAN: f32 = 240.0;
pub const SMALL_LIST_ROWS: usize = 40;
const UNKNOWN_VIEWPORT: f32 = 1600.0;
const SETTLE_SLOP: f32 = 0.5;

#[derive(Clone, Debug, PartialEq)]
pub struct VirtualItem {
    pub key: SharedString,
    pub height: f32,
    pub header: bool,
}

impl VirtualItem {
    pub fn new(key: impl Into<SharedString>, height: f32) -> Self {
        VirtualItem {
            key: key.into(),
            height,
            header: false,
        }
    }

    pub fn header(key: impl Into<SharedString>, height: f32) -> Self {
        VirtualItem {
            key: key.into(),
            height,
            header: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Columns {
    Fixed(usize),
    Adaptive {
        min_width: f32,
        width: f32,
        gap: f32,
    },
}

impl Columns {
    pub fn count(self) -> usize {
        match self {
            Columns::Fixed(n) => n.max(1),
            Columns::Adaptive {
                min_width,
                width,
                gap,
            } => {
                if min_width <= 0.0 {
                    return 1;
                }
                (((width + gap) / (min_width + gap)).floor() as usize).max(1)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    List {
        gap: f32,
    },
    Grid {
        columns: Columns,
        row_height: f32,
        column_gap: f32,
        row_gap: f32,
    },
}

impl Shape {
    fn gap(self) -> f32 {
        match self {
            Shape::List { gap } => gap,
            Shape::Grid { row_gap, .. } => row_gap,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Nearest,
    Top,
    Center,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub items: Range<usize>,
    pub top: f32,
    pub height: f32,
    pub header: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub rows: Vec<Row>,
    pub gap: f32,
    pub total: f32,
}

impl Plan {
    pub fn build(items: &[VirtualItem], shape: Shape, height_of: impl Fn(usize) -> f32) -> Plan {
        let gap = shape.gap();
        let mut rows: Vec<Row> = Vec::new();
        let mut top = 0.0;
        let mut place = |rows: &mut Vec<Row>, items: Range<usize>, height: f32, header: bool| {
            if !rows.is_empty() {
                top += gap;
            }
            rows.push(Row {
                items,
                top,
                height,
                header,
            });
            top += height;
        };
        match shape {
            Shape::List { .. } => {
                for (ix, item) in items.iter().enumerate() {
                    place(&mut rows, ix..ix + 1, height_of(ix), item.header);
                }
            }
            Shape::Grid {
                columns,
                row_height,
                ..
            } => {
                let per_row = columns.count();
                let mut start = None::<usize>;
                for (ix, item) in items.iter().enumerate() {
                    if item.header {
                        if let Some(s) = start.take() {
                            place(&mut rows, s..ix, row_height, false);
                        }
                        place(&mut rows, ix..ix + 1, height_of(ix), true);
                        continue;
                    }
                    let s = *start.get_or_insert(ix);
                    if ix + 1 - s == per_row {
                        place(&mut rows, s..ix + 1, row_height, false);
                        start = None;
                    }
                }
                if let Some(s) = start {
                    place(&mut rows, s..items.len(), row_height, false);
                }
            }
        }
        let total = rows.last().map_or(0.0, |r| r.top + r.height);
        Plan { rows, gap, total }
    }

    pub fn rows_in(&self, top: f32, bottom: f32) -> Range<usize> {
        let first = self.rows.partition_point(|r| r.top + r.height < top);
        let end = self.rows.partition_point(|r| r.top <= bottom);
        first..end.max(first)
    }

    pub fn row_of(&self, item: usize) -> Option<usize> {
        let ix = self.rows.partition_point(|r| r.items.end <= item);
        self.rows
            .get(ix)
            .filter(|r| r.items.contains(&item))
            .map(|_| ix)
    }

    pub fn segments(&self, shown: &[usize]) -> Vec<Segment> {
        let mut out = Vec::new();
        let mut next = 0usize;
        for &row in shown {
            if row > next {
                out.push(Segment::Gap(self.span(next..row)));
            }
            out.push(Segment::Row(row));
            next = row + 1;
        }
        if next < self.rows.len() {
            out.push(Segment::Gap(self.span(next..self.rows.len())));
        }
        out
    }

    fn span(&self, rows: Range<usize>) -> f32 {
        let first = &self.rows[rows.start];
        let last = &self.rows[rows.end - 1];
        last.top + last.height - first.top
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Segment {
    Gap(f32),
    Row(usize),
}

pub fn scroll_target(
    row_top: f32,
    row_height: f32,
    view_top: f32,
    view_height: f32,
    align: Align,
) -> Option<f32> {
    match align {
        Align::Top => Some(row_top),
        Align::Center => Some(row_top + row_height / 2.0 - view_height / 2.0),
        Align::Nearest => {
            if row_top < view_top {
                Some(row_top)
            } else if row_top + row_height > view_top + view_height {
                Some(row_top + row_height - view_height)
            } else {
                None
            }
        }
    }
}

#[derive(Default)]
struct Memory {
    content_top: Option<f32>,
    items: Vec<VirtualItem>,
    index: HashMap<SharedString, usize>,
    measured: Vec<Option<(f32, f32)>>,
    revision: Option<u64>,
    shape: Option<Shape>,
    plan_stale: bool,
    plan: Plan,
    scroll: Option<ScrollHandle>,
    shown: Vec<usize>,
    tops: HashMap<SharedString, f32>,
    previous_tops: HashMap<SharedString, f32>,
    painted_all: bool,
    scope: Option<SharedString>,
    rendered_at: Option<std::time::Instant>,
}

thread_local! {
    static LISTS: RefCell<HashMap<SharedString, Memory>> = RefCell::new(HashMap::new());
    static HANDLES: RefCell<HashMap<SharedString, ScrollHandle>> = RefCell::new(HashMap::new());
}

fn with_memory<R>(key: &SharedString, f: impl FnOnce(&mut Memory) -> R) -> R {
    LISTS.with(|lists| f(lists.borrow_mut().entry(key.clone()).or_default()))
}

pub fn scroll_handle(key: impl Into<SharedString>) -> ScrollHandle {
    let key = key.into();
    HANDLES.with(|h| h.borrow_mut().entry(key).or_default().clone())
}

pub fn forget(key: &str) {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|l| l.borrow_mut().remove(&key));
    HANDLES.with(|h| h.borrow_mut().remove(&key));
}

pub fn painted_all(scope: &str) -> bool {
    LISTS.with(|lists| {
        let lists = lists.borrow();
        let in_scope = || {
            lists
                .values()
                .filter(move |m| m.scope.as_deref() == Some(scope))
        };
        let Some(newest) = in_scope().filter_map(|m| m.rendered_at).max() else {
            return true;
        };
        in_scope()
            .filter(|m| {
                m.rendered_at.is_some_and(|at| {
                    newest.duration_since(at) < std::time::Duration::from_millis(50)
                })
            })
            .all(|m| m.painted_all)
    })
}

pub fn visible_items(key: &str) -> Vec<SharedString> {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|lists| {
        lists.borrow().get(&key).map_or_else(Vec::new, |m| {
            m.shown
                .iter()
                .flat_map(|&row| m.plan.rows[row].items.clone())
                .filter_map(|ix| m.items.get(ix).map(|i| i.key.clone()))
                .collect()
        })
    })
}

pub fn item_top(key: &str, item: &str) -> Option<f32> {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|lists| {
        let lists = lists.borrow();
        let m = lists.get(&key)?;
        let ix = *m.index.get(item)?;
        let row = m.plan.row_of(ix)?;
        Some(m.plan.rows[row].top)
    })
}

pub fn band(key: &str, item: &str) -> Option<(f32, f32)> {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|lists| {
        let lists = lists.borrow();
        let m = lists.get(&key)?;
        if m.painted_all {
            return None;
        }
        let handle = m.scroll.as_ref()?;
        let ix = *m.index.get(item)?;
        let top = m.plan.rows[m.plan.row_of(ix)?].top;
        let viewport = points(handle.bounds().size.height);
        if viewport <= 0.0 {
            return None;
        }
        let view_top = -points(handle.offset().y) - m.content_top?;
        Some((
            view_top - top - OVERSCAN,
            view_top + viewport - top + OVERSCAN,
        ))
    })
}

pub fn outside_band(band: Option<(f32, f32)>, top: f32, height: f32) -> bool {
    band.is_some_and(|(lo, hi)| top + height < lo || top > hi)
}

pub fn moved(key: &str, item: &str) -> Option<f32> {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|lists| {
        let lists = lists.borrow();
        let m = lists.get(&key)?;
        let now = m.tops.get(item)?;
        let before = m.previous_tops.get(item)?;
        let delta = before - now;
        (delta.abs() > SETTLE_SLOP).then_some(delta)
    })
}

pub fn step(key: &str, from: Option<&str>, delta: isize) -> Option<SharedString> {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|lists| {
        let lists = lists.borrow();
        let m = lists.get(&key)?;
        let selectable = |ix: &usize| m.items.get(*ix).is_some_and(|i| !i.header);
        let count = m.items.len() as isize;
        let start = from.and_then(|f| m.index.get(f).copied());
        let mut at = match start {
            Some(at) => at as isize,
            None if delta < 0 => count,
            None => -1,
        };
        let step = if delta < 0 { -1 } else { 1 };
        let mut remaining = delta.unsigned_abs().max(1);
        let mut last = start;
        while remaining > 0 {
            at += step;
            if at < 0 || at >= count {
                break;
            }
            if selectable(&(at as usize)) {
                last = Some(at as usize);
                remaining -= 1;
            }
        }
        last.map(|ix| m.items[ix].key.clone())
    })
}

pub fn scroll_to(key: &str, item: &str, align: Align) -> bool {
    let key = SharedString::from(key.to_owned());
    LISTS.with(|lists| {
        let lists = lists.borrow();
        let Some(m) = lists.get(&key) else {
            return false;
        };
        let Some(handle) = m.scroll.as_ref() else {
            return false;
        };
        let Some(&ix) = m.index.get(item) else {
            return false;
        };
        let Some(row) = m.plan.row_of(ix).map(|r| &m.plan.rows[r]) else {
            return false;
        };
        let content_top = m.content_top.unwrap_or(0.0);
        let offset = handle.offset();
        let view_height = points(handle.bounds().size.height);
        let view_top = -points(offset.y) - content_top;
        let Some(target) = scroll_target(row.top, row.height, view_top, view_height, align) else {
            return true;
        };
        let max = points(handle.max_offset().y).max(0.0);
        let next = (target + content_top).clamp(0.0, max.max(target + content_top).min(max));
        handle.set_offset(point(offset.x, px(-next)));
        true
    })
}

type Empty<'a> = Box<dyn FnOnce() -> AnyElement + 'a>;

type ItemsWith<'a> = Box<dyn Fn(usize) -> VirtualItem + 'a>;

pub struct VirtualList<'a> {
    key: SharedString,
    scroll: ScrollHandle,
    items: Option<Vec<VirtualItem>>,
    items_with: Option<(u64, usize, ItemsWith<'a>)>,
    shape: Shape,
    overscan: f32,
    keep: HashSet<SharedString>,
    render_all: bool,
    small_list_rows: usize,
    scope: Option<SharedString>,
    empty: Option<Empty<'a>>,
}

pub fn virtual_list<'a>(key: impl Into<SharedString>, scroll: &ScrollHandle) -> VirtualList<'a> {
    VirtualList {
        key: key.into(),
        scroll: scroll.clone(),
        items: None,
        items_with: None,
        shape: Shape::List { gap: 0.0 },
        overscan: OVERSCAN,
        keep: HashSet::new(),
        render_all: false,
        small_list_rows: SMALL_LIST_ROWS,
        scope: None,
        empty: None,
    }
}

impl<'a> VirtualList<'a> {
    pub fn items(mut self, items: impl IntoIterator<Item = VirtualItem>) -> Self {
        self.items = Some(items.into_iter().collect());
        self
    }

    pub fn items_with(
        mut self,
        revision: u64,
        count: usize,
        item: impl Fn(usize) -> VirtualItem + 'a,
    ) -> Self {
        self.items_with = Some((revision, count, Box::new(item)));
        self
    }

    pub fn gap(mut self, gap: f32) -> Self {
        self.shape = Shape::List { gap };
        self
    }

    pub fn grid(
        mut self,
        columns: Columns,
        row_height: f32,
        column_gap: f32,
        row_gap: f32,
    ) -> Self {
        self.shape = Shape::Grid {
            columns,
            row_height,
            column_gap,
            row_gap,
        };
        self
    }

    pub fn overscan(mut self, overscan: f32) -> Self {
        self.overscan = overscan.max(0.0);
        self
    }

    pub fn keep<K: Into<SharedString>>(mut self, keys: impl IntoIterator<Item = K>) -> Self {
        self.keep.extend(keys.into_iter().map(Into::into));
        self
    }

    pub fn render_all(mut self, all: bool) -> Self {
        self.render_all = all;
        self
    }

    pub fn small_list_rows(mut self, rows: usize) -> Self {
        self.small_list_rows = rows;
        self
    }

    pub fn scope(mut self, scope: impl Into<SharedString>) -> Self {
        self.scope = Some(scope.into());
        self
    }

    pub fn empty(mut self, empty: impl FnOnce() -> AnyElement + 'a) -> Self {
        self.empty = Some(Box::new(empty));
        self
    }

    pub fn render(self, mut item: impl FnMut(usize, &VirtualItem) -> AnyElement) -> AnyElement {
        let VirtualList {
            key,
            scroll,
            items,
            items_with,
            shape,
            overscan,
            keep,
            render_all,
            small_list_rows,
            scope,
            empty,
        } = self;
        let mut memory = LISTS.with(|lists| lists.borrow_mut().remove(&key).unwrap_or_default());
        sync_items(&mut memory, items, items_with, shape);
        let m = &mut memory;
        m.scroll = Some(scroll.clone());
        m.scope = scope;
        m.rendered_at = Some(std::time::Instant::now());
        if m.items.is_empty() {
            m.shown.clear();
            m.painted_all = true;
            LISTS.with(|lists| lists.borrow_mut().insert(key.clone(), memory));
            return match empty {
                Some(empty) => empty(),
                None => div().into_any_element(),
            };
        }
        let viewport = points(scroll.bounds().size.height);
        let viewport = if viewport > 0.0 {
            viewport
        } else {
            UNKNOWN_VIEWPORT
        };
        let everything = render_all
            || (m.plan.rows.len() <= small_list_rows
                && m.plan.total <= viewport + 2.0 * overscan);
        let (shown, window_span) = if everything {
            (
                (0..m.plan.rows.len()).collect::<Vec<usize>>(),
                (0.0, m.plan.total),
            )
        } else {
            let view_top = -points(scroll.offset().y) - m.content_top.unwrap_or(0.0);
            let range = m
                .plan
                .rows_in(view_top - overscan, view_top + viewport + overscan);
            let span = match (range.start < range.end)
                .then(|| (&m.plan.rows[range.start], &m.plan.rows[range.end - 1]))
            {
                Some((first, last)) => (first.top, last.top + last.height),
                None => (0.0, 0.0),
            };
            let mut shown: Vec<usize> = range.collect();
            let kept = keep
                .iter()
                .filter_map(|k| m.index.get(k))
                .filter_map(|&ix| m.plan.row_of(ix));
            let before = shown.len();
            shown.extend(kept);
            if shown.len() > before {
                shown.sort_unstable();
                shown.dedup();
            }
            (shown, span)
        };
        let plan = &m.plan;
        let items = &m.items;
        let segments = plan.segments(&shown);
        let mut children: Vec<AnyElement> = Vec::with_capacity(segments.len());
        let mut probes: Vec<Option<Probe>> = Vec::with_capacity(segments.len());
        for segment in &segments {
            match *segment {
                Segment::Gap(height) => {
                    children.push(div().flex_none().h(px(height)).into_any_element());
                    probes.push(None);
                }
                Segment::Row(row) => {
                    let r = &plan.rows[row];
                    let single = r.header || matches!(shape, Shape::List { .. });
                    let element = if single {
                        item(r.items.start, &items[r.items.start])
                    } else {
                        let column_gap = match shape {
                            Shape::Grid { column_gap, .. } => column_gap,
                            Shape::List { .. } => 0.0,
                        };
                        div()
                            .flex()
                            .flex_row()
                            .flex_none()
                            .h(px(r.height))
                            .gap(px(column_gap))
                            .children(r.items.clone().map(|ix| item(ix, &items[ix])))
                            .into_any_element()
                    };
                    children.push(element);
                    probes.push(single.then(|| Probe {
                        index: r.items.start,
                        key: items[r.items.start].key.clone(),
                        estimate: items[r.items.start].height,
                        used: r.height,
                    }));
                }
            }
        }
        let tops: HashMap<SharedString, f32> = shown
            .iter()
            .flat_map(|&row| {
                let r = &plan.rows[row];
                r.items.clone().map(move |ix| (ix, r.top))
            })
            .map(|(ix, top)| (items[ix].key.clone(), top))
            .collect();
        let gap = plan.gap;
        m.previous_tops = std::mem::replace(&mut m.tops, tops);
        m.shown = shown;
        m.painted_all = everything;
        LISTS.with(|lists| lists.borrow_mut().insert(key.clone(), memory));
        let probe_key = key;
        let probe_scroll = scroll;
        div()
            .flex()
            .flex_col()
            .flex_none()
            .gap(px(gap))
            .children(children)
            .on_children_prepainted(move |bounds: Vec<Bounds<Pixels>>, window, _| {
                let Some(first) = bounds.first() else {
                    return;
                };
                let view = probe_scroll.bounds();
                let offset = points(probe_scroll.offset().y);
                let content_top = points(first.origin.y) - points(view.origin.y) - offset;
                let mut settle = false;
                with_memory(&probe_key, |m| {
                    let moved = m
                        .content_top
                        .is_none_or(|old| (old - content_top).abs() > 1.0);
                    m.content_top = Some(content_top);
                    for (b, probe) in bounds.iter().zip(&probes) {
                        let Some(probe) = probe else {
                            continue;
                        };
                        let real = points(b.size.height);
                        if (real - probe.used).abs() <= SETTLE_SLOP {
                            continue;
                        }
                        if m.items.get(probe.index).is_some_and(|i| i.key == probe.key)
                            && let Some(slot) = m.measured.get_mut(probe.index)
                        {
                            *slot = Some((probe.estimate, real));
                            m.plan_stale = true;
                        }
                        settle = true;
                    }
                    if !m.painted_all {
                        let viewport = points(view.size.height);
                        let view_top = -offset - content_top;
                        let need_lo = view_top.max(0.0);
                        let need_hi = (view_top + viewport).min(m.plan.total);
                        if need_hi > need_lo
                            && (need_lo < window_span.0 - SETTLE_SLOP
                                || need_hi > window_span.1 + SETTLE_SLOP)
                        {
                            settle = true;
                        }
                        if moved {
                            settle = true;
                        }
                    }
                });
                if settle {
                    window.on_next_frame(|window, _| window.refresh());
                }
            })
            .into_any_element()
    }
}

fn sync_items(
    m: &mut Memory,
    items: Option<Vec<VirtualItem>>,
    items_with: Option<(u64, usize, ItemsWith<'_>)>,
    shape: Shape,
) {
    let fresh = match (items, items_with) {
        (Some(items), _) => {
            m.revision = None;
            (items != m.items).then_some(items)
        }
        (None, Some((revision, count, item))) => {
            if m.revision == Some(revision) && m.items.len() == count {
                None
            } else {
                m.revision = Some(revision);
                let items: Vec<VirtualItem> = (0..count).map(item).collect();
                (items != m.items).then_some(items)
            }
        }
        (None, None) => (!m.items.is_empty()).then(Vec::new),
    };
    if let Some(items) = fresh {
        let old_index = std::mem::take(&mut m.index);
        let old_measured = std::mem::take(&mut m.measured);
        m.index = items
            .iter()
            .enumerate()
            .map(|(ix, item)| (item.key.clone(), ix))
            .collect();
        m.measured = items
            .iter()
            .map(|item| {
                old_index
                    .get(&item.key)
                    .and_then(|&old| old_measured.get(old).copied().flatten())
                    .filter(|(estimate, _)| (estimate - item.height).abs() <= SETTLE_SLOP)
            })
            .collect();
        m.items = items;
        m.plan_stale = true;
    }
    if m.shape != Some(shape) {
        m.shape = Some(shape);
        m.plan_stale = true;
    }
    if m.plan_stale {
        let items = &m.items;
        let measured = &m.measured;
        m.plan = Plan::build(items, shape, |ix| match measured[ix] {
            Some((estimate, real)) if (estimate - items[ix].height).abs() <= SETTLE_SLOP => real,
            _ => items[ix].height,
        });
        m.plan_stale = false;
    }
}

struct Probe {
    index: usize,
    key: SharedString,
    estimate: f32,
    used: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(n: usize, h: f32) -> Vec<VirtualItem> {
        (0..n)
            .map(|i| VirtualItem::new(format!("r{i}"), h))
            .collect()
    }

    fn plan(items: &[VirtualItem], shape: Shape) -> Plan {
        Plan::build(items, shape, |ix| items[ix].height)
    }

    #[test]
    fn a_list_stacks_rows_with_gaps() {
        let items = rows(3, 30.0);
        let p = plan(&items, Shape::List { gap: 2.0 });
        let tops: Vec<f32> = p.rows.iter().map(|r| r.top).collect();
        assert_eq!(tops, vec![0.0, 32.0, 64.0]);
        assert_eq!(p.total, 94.0);
    }

    #[test]
    fn variable_heights_add_up() {
        let items = vec![
            VirtualItem::new("a", 30.0),
            VirtualItem::new("b", 100.0),
            VirtualItem::new("c", 30.0),
        ];
        let p = plan(&items, Shape::List { gap: 0.0 });
        assert_eq!(p.rows[2].top, 130.0);
        assert_eq!(p.total, 160.0);
    }

    #[test]
    fn only_rows_in_the_view_are_picked() {
        let items = rows(800, 30.0);
        let p = plan(&items, Shape::List { gap: 2.0 });
        let range = p.rows_in(3200.0, 3200.0 + 600.0);
        assert_eq!(range, 100..119);
        assert!(range.len() < 25);
    }

    #[test]
    fn segments_fill_skipped_rows_with_spacers_of_the_same_height() {
        let items = rows(10, 30.0);
        let p = plan(&items, Shape::List { gap: 2.0 });
        let segs = p.segments(&[3, 4, 8]);
        assert_eq!(
            segs,
            vec![
                Segment::Gap(94.0),
                Segment::Row(3),
                Segment::Row(4),
                Segment::Gap(94.0),
                Segment::Row(8),
                Segment::Gap(30.0),
            ]
        );
        let gaps = segs.len() as f32 - 1.0;
        let sum: f32 = segs
            .iter()
            .map(|s| match s {
                Segment::Gap(h) => *h,
                Segment::Row(r) => p.rows[*r].height,
            })
            .sum();
        assert_eq!(sum + gaps * 2.0, p.total);
    }

    #[test]
    fn a_fixed_grid_wraps_cells_into_rows() {
        let items = rows(7, 0.0);
        let p = plan(
            &items,
            Shape::Grid {
                columns: Columns::Fixed(3),
                row_height: 50.0,
                column_gap: 4.0,
                row_gap: 6.0,
            },
        );
        let spans: Vec<Range<usize>> = p.rows.iter().map(|r| r.items.clone()).collect();
        assert_eq!(spans, vec![0..3, 3..6, 6..7]);
        assert_eq!(p.total, 162.0);
        assert_eq!(p.row_of(4), Some(1));
    }

    #[test]
    fn an_adaptive_grid_fits_columns_to_the_width() {
        let columns = Columns::Adaptive {
            min_width: 50.0,
            width: 230.0,
            gap: 8.0,
        };
        assert_eq!(columns.count(), 4);
        assert_eq!(
            Columns::Adaptive {
                min_width: 50.0,
                width: 20.0,
                gap: 8.0
            }
            .count(),
            1
        );
    }

    #[test]
    fn section_headers_start_a_new_grid_row() {
        let items = vec![
            VirtualItem::header("h1", 20.0),
            VirtualItem::new("a", 0.0),
            VirtualItem::new("b", 0.0),
            VirtualItem::header("h2", 20.0),
            VirtualItem::new("c", 0.0),
        ];
        let p = plan(
            &items,
            Shape::Grid {
                columns: Columns::Fixed(3),
                row_height: 50.0,
                column_gap: 0.0,
                row_gap: 0.0,
            },
        );
        let spans: Vec<(Range<usize>, bool)> =
            p.rows.iter().map(|r| (r.items.clone(), r.header)).collect();
        assert_eq!(
            spans,
            vec![(0..1, true), (1..3, false), (3..4, true), (4..5, false)]
        );
        assert_eq!(p.total, 140.0);
    }

    #[test]
    fn scrolling_to_an_item_moves_only_as_far_as_needed() {
        assert_eq!(scroll_target(50.0, 30.0, 0.0, 400.0, Align::Nearest), None);
        assert_eq!(
            scroll_target(500.0, 30.0, 0.0, 400.0, Align::Nearest),
            Some(130.0)
        );
        assert_eq!(
            scroll_target(50.0, 30.0, 100.0, 400.0, Align::Nearest),
            Some(50.0)
        );
        assert_eq!(
            scroll_target(500.0, 30.0, 0.0, 400.0, Align::Top),
            Some(500.0)
        );
        assert_eq!(
            scroll_target(500.0, 30.0, 0.0, 400.0, Align::Center),
            Some(315.0)
        );
    }

    #[test]
    fn an_empty_list_has_no_rows() {
        let p = plan(&[], Shape::List { gap: 2.0 });
        assert!(p.rows.is_empty());
        assert_eq!(p.total, 0.0);
        assert_eq!(p.segments(&[]), vec![]);
    }

    #[test]
    fn keyboard_steps_skip_headers_and_stop_at_the_ends() {
        let items = vec![
            VirtualItem::header("h", 20.0),
            VirtualItem::new("a", 30.0),
            VirtualItem::new("b", 30.0),
        ];
        let key = SharedString::from("step-test");
        with_memory(&key, |m| {
            sync_items(m, Some(items.clone()), None, Shape::List { gap: 0.0 });
        });
        assert_eq!(step("step-test", None, 1).as_deref(), Some("a"));
        assert_eq!(step("step-test", Some("a"), 1).as_deref(), Some("b"));
        assert_eq!(step("step-test", Some("b"), 1).as_deref(), Some("b"));
        assert_eq!(step("step-test", Some("a"), -1).as_deref(), Some("a"));
        forget("step-test");
    }

    struct Long {
        handle: ScrollHandle,
        drawn: std::rc::Rc<RefCell<Vec<usize>>>,
        count: usize,
    }

    impl gpui::Render for Long {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            use gpui::{InteractiveElement, StatefulInteractiveElement};
            let drawn = self.drawn.clone();
            drawn.borrow_mut().clear();
            div().size_full().child(
                div()
                    .id("long")
                    .h(gpui::px(400.0))
                    .w(gpui::px(200.0))
                    .flex()
                    .flex_col()
                    .overflow_y_scroll()
                    .track_scroll(&self.handle)
                    .child(div().flex_none().h(gpui::px(100.0)))
                    .child(
                        virtual_list("long-test", &self.handle)
                            .items((0..self.count).map(|i| VirtualItem::new(format!("r{i}"), 30.0)))
                            .gap(2.0)
                            .keep(["r700"])
                            .render(|ix, _| {
                                drawn.borrow_mut().push(ix);
                                div().h(gpui::px(30.0)).into_any_element()
                            }),
                    ),
            )
        }
    }

    #[gpui::test]
    fn a_long_list_draws_only_the_rows_in_view(cx: &mut gpui::TestAppContext) {
        crate::scale::set(1.0);
        let drawn = std::rc::Rc::new(RefCell::new(Vec::new()));
        let handle = ScrollHandle::new();
        let (_, cx) = cx.add_window_view(|_, _| Long {
            handle: handle.clone(),
            drawn: drawn.clone(),
            count: 800,
        });
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        let first = drawn.borrow().clone();
        assert!(first.len() < 40, "drew {} rows", first.len());
        assert!(first.contains(&0) && first.contains(&700));
        assert!(
            (f32::from(handle.max_offset().y) - (100.0 + 800.0 * 32.0 - 2.0 - 400.0)).abs() < 1.0
        );
        handle.set_offset(point(gpui::px(0.0), gpui::px(-12100.0)));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        let later = drawn.borrow().clone();
        assert!(later.len() < 40, "drew {} rows", later.len());
        assert!(later.contains(&375) && later.contains(&390), "{later:?}");
        assert!(!later.contains(&0));
        assert_eq!(visible_items("long-test").len(), later.len());
        assert!(scroll_to("long-test", "r10", Align::Top));
        assert_eq!(f32::from(handle.offset().y), -(100.0 + 320.0));
        forget("long-test");
    }

    struct Huge {
        handle: ScrollHandle,
        count: usize,
        revision: u64,
        lazy: bool,
    }

    impl gpui::Render for Huge {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            use gpui::{InteractiveElement, StatefulInteractiveElement};
            let count = self.count;
            let list = virtual_list("huge-test", &self.handle).gap(2.0);
            let list = if self.lazy {
                list.items_with(self.revision, count, |i| {
                    VirtualItem::new(SharedString::from(format!("r{i}")), 30.0)
                })
            } else {
                list.items((0..count).map(|i| VirtualItem::new(format!("r{i}"), 30.0)))
            };
            div().size_full().child(
                div()
                    .id("huge")
                    .h(gpui::px(600.0))
                    .w(gpui::px(300.0))
                    .flex()
                    .flex_col()
                    .overflow_y_scroll()
                    .track_scroll(&self.handle)
                    .child(list.render(|_, item| {
                        div()
                            .h(gpui::px(30.0))
                            .child(item.key.clone())
                            .into_any_element()
                    })),
            )
        }
    }

    #[gpui::test]
    #[ignore]
    fn ten_thousand_rows_cost_the_same_as_a_screenful(cx: &mut gpui::TestAppContext) {
        crate::scale::set(1.0);
        for lazy in [true, false] {
            let handle = ScrollHandle::new();
            let (view, vcx) = cx.add_window_view(|_, _| Huge {
                handle: handle.clone(),
                count: 10_000,
                revision: 1,
                lazy,
            });
            for count in [10_000usize, 30] {
                view.update(vcx, |v, _| v.count = count);
                view.update(vcx, |v, _| v.revision += 1);
                vcx.update(|window, _| window.refresh());
                vcx.run_until_parked();
                let frames = 200u32;
                let start = std::time::Instant::now();
                for i in 0..frames {
                    handle.set_offset(point(gpui::px(0.0), gpui::px(-((i % 100) as f32) * 37.0)));
                    vcx.update(|window, _| window.refresh());
                    vcx.run_until_parked();
                }
                let per = start.elapsed() / frames;
                println!(
                    "virtual_list {} rows, {}: {:?} per frame",
                    count,
                    if lazy { "items_with" } else { "items" },
                    per
                );
            }
            forget("huge-test");
        }
    }
}
