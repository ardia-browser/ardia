use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use ardia_state::TabId;
use ardia_theme::layout::sidebar;
use ardia_theme::motion::CubicBezier;
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, ParentElement, Pixels, SharedString, Styled, Window, canvas, div, point,
    prelude::*,
};

use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::{Favicon, render_favicon};
use crate::primitives::icons::{Icon, icon};
use crate::scale::px;

pub const SLIDE_MS: u64 = 140;
pub const CLOSE_FADE_MS: u64 = 100;
pub const APPEAR_MS: u64 = 140;
pub const MAX_APPEARING: usize = 4;

#[derive(Clone, Debug)]
pub struct RowSnap {
    pub title: SharedString,
    pub favicon: Favicon,
    pub indent: f32,
    pub hovered: bool,
    pub ink: Hsla,
    pub hover: Hsla,
    pub icon_size: f32,
    pub title_size: f32,
    pub icon_ink: Hsla,
    pub palette: crate::look::Palette,
}

#[derive(Clone, Debug)]
struct Ghost {
    snap: RowSnap,
    top: f32,
    left: f32,
    width: f32,
    since: Instant,
}

#[derive(Clone, Copy, Debug, Default)]
struct RowPlace {
    frame: u64,
    rel: f32,
    top: f32,
    left: f32,
    width: f32,
    slide_from: f32,
    since: Option<Instant>,
    seen: Option<Instant>,
}

thread_local! {
    static SNAPS: RefCell<HashMap<(String, TabId), RowSnap>> = RefCell::new(HashMap::new());
    static GHOSTS: RefCell<HashMap<String, Vec<Ghost>>> = RefCell::new(HashMap::new());
    static PLACES: RefCell<HashMap<(String, TabId), RowPlace>> = RefCell::new(HashMap::new());
    static ORIGINS: RefCell<HashMap<(String, String), (f32, u64)>> = RefCell::new(HashMap::new());
    static APPEARS: RefCell<HashMap<(String, TabId), Instant>> = RefCell::new(HashMap::new());
    static LIST_CHANGES: RefCell<HashMap<String, Instant>> = RefCell::new(HashMap::new());
}

pub fn origin_probe(window: &str, profile: &str) -> AnyElement {
    let key = (window.to_owned(), profile.to_owned());
    canvas(
        move |bounds, _, _| {
            let top = f32::from(bounds.origin.y);
            ORIGINS.with(|o| {
                let mut o = o.borrow_mut();
                let entry = o.entry(key.clone()).or_insert((top, 0));
                *entry = (top, entry.1 + 1);
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_0()
    .into_any_element()
}

fn origin(window: &str, profile: &str) -> Option<(f32, u64)> {
    ORIGINS.with(|o| {
        o.borrow()
            .get(&(window.to_owned(), profile.to_owned()))
            .copied()
    })
}

pub fn origin_key(profile: &str, group: Option<&str>) -> String {
    match group {
        Some(group) => format!("group:{group}"),
        None => profile.to_owned(),
    }
}

pub fn painted_last_frame(place_frame: u64, frame: u64) -> bool {
    place_frame != 0 && place_frame + 1 == frame
}

pub fn opened_rows(before: &[TabId], after: &[TabId]) -> Vec<TabId> {
    if before.is_empty() {
        return Vec::new();
    }
    let had: std::collections::HashSet<&TabId> = before.iter().collect();
    let opened: Vec<TabId> = after
        .iter()
        .filter(|id| !had.contains(id))
        .cloned()
        .collect();
    let kept = after.iter().any(|id| had.contains(id));
    if !kept || opened.len() > MAX_APPEARING {
        return Vec::new();
    }
    opened
}

pub const LIST_CHANGE_REACH_MS: u64 = 150;

pub fn note_list_change(window: &str) {
    LIST_CHANGES.with(|c| c.borrow_mut().insert(window.to_owned(), Instant::now()));
}

fn list_changed(window: &str) -> bool {
    LIST_CHANGES.with(|c| {
        c.borrow()
            .get(window)
            .is_some_and(|at| at.elapsed() < Duration::from_millis(LIST_CHANGE_REACH_MS))
    })
}

pub fn order_changed<T: PartialEq>(before: (&[TabId], &T), after: (&[TabId], &T)) -> bool {
    before.0 != after.0 || before.1 != after.1
}

pub fn note_opens(window: &str, opened: &[TabId]) {
    if opened.is_empty() {
        return;
    }
    let now = Instant::now();
    APPEARS.with(|a| {
        let mut a = a.borrow_mut();
        a.retain(|_, at| at.elapsed() < Duration::from_millis(APPEAR_MS));
        for id in opened {
            a.insert((window.to_owned(), id.clone()), now);
        }
    });
}

pub fn appear_progress(elapsed: Duration) -> f32 {
    let t = elapsed.as_secs_f64() / Duration::from_millis(APPEAR_MS).as_secs_f64();
    CubicBezier::EASE_OUT.ease(t.clamp(0.0, 1.0)) as f32
}

pub fn appearing(window: &str, tab: &TabId) -> Option<f32> {
    APPEARS.with(|a| {
        let at = *a.borrow().get(&(window.to_owned(), tab.clone()))?;
        let elapsed = at.elapsed();
        (elapsed < Duration::from_millis(APPEAR_MS)).then(|| appear_progress(elapsed))
    })
}

pub fn slide_from(current: f32, delta: f32) -> f32 {
    current + delta
}

pub fn slide_progress(elapsed: Duration) -> f32 {
    let t = elapsed.as_secs_f64() / Duration::from_millis(SLIDE_MS).as_secs_f64();
    CubicBezier::CORE_ANIMATION_DEFAULT.ease(t.clamp(0.0, 1.0)) as f32
}

fn fresh(places: &HashMap<(String, TabId), RowPlace>, window: &str, place: &RowPlace) -> bool {
    let newest = places
        .iter()
        .filter(|((w, _), _)| w == window)
        .filter_map(|(_, p)| p.seen)
        .max();
    match (newest, place.seen) {
        (Some(newest), Some(seen)) => newest.duration_since(seen) <= Duration::from_millis(50),
        _ => false,
    }
}

pub fn row_top(window: &str, tab: &TabId) -> Option<f32> {
    PLACES.with(|places| {
        let places = places.borrow();
        let place = places.get(&(window.to_owned(), tab.clone()))?;
        if !fresh(&places, window, place) {
            return None;
        }
        Some(place.top)
    })
}

pub fn row_frames(window: &str) -> Vec<(TabId, f32, f32, f32)> {
    PLACES.with(|places| {
        let places = places.borrow();
        let newest = places
            .iter()
            .filter(|((w, _), _)| w == window)
            .filter_map(|(_, p)| p.seen)
            .max();
        let Some(newest) = newest else {
            return Vec::new();
        };
        places
            .iter()
            .filter(|((w, _), p)| {
                w == window
                    && p.seen.is_some_and(|seen| {
                        newest.duration_since(seen) <= Duration::from_millis(50)
                    })
            })
            .map(|((_, id), p)| (id.clone(), p.top, p.left, p.width))
            .collect()
    })
}

fn offset_of(place: &RowPlace) -> Option<f32> {
    let since = place.since?;
    let elapsed = since.elapsed();
    if elapsed >= Duration::from_millis(SLIDE_MS) {
        return None;
    }
    Some(place.slide_from * (1.0 - slide_progress(elapsed)))
}

pub fn offset(window: &str, tab: &TabId) -> Option<f32> {
    PLACES.with(|places| {
        let places = places.borrow();
        let place = places.get(&(window.to_owned(), tab.clone()))?;
        let since = place.since?;
        let elapsed = since.elapsed();
        if elapsed >= Duration::from_millis(SLIDE_MS) {
            return None;
        }
        Some(place.slide_from * (1.0 - slide_progress(elapsed)))
    })
}

fn observe(
    key: &(String, TabId),
    profile: &str,
    bounds: Bounds<Pixels>,
    animate: bool,
) -> Option<f32> {
    let top = f32::from(bounds.origin.y);
    let left = f32::from(bounds.origin.x);
    let (base, frame) = origin(&key.0, profile).unwrap_or((0.0, 0));
    let rel = top - base;
    let busy = crate::sidebar::drag_motion::busy(&key.0);
    PLACES.with(|places| {
        let mut places = places.borrow_mut();
        let fresh_place = places
            .get(key)
            .is_some_and(|p| painted_last_frame(p.frame, frame));
        let place = places.entry(key.clone()).or_insert(RowPlace {
            rel,
            top,
            left,
            ..RowPlace::default()
        });
        let delta = place.rel - rel;
        let moved = delta.abs() > 0.5 && (place.left - left).abs() < 0.5 && fresh_place;
        let current = offset_of(place).unwrap_or(0.0);
        place.rel = rel;
        place.top = top;
        place.left = left;
        place.width = f32::from(bounds.size.width);
        place.seen = Some(Instant::now());
        place.frame = frame;
        if busy {
            place.since = None;
        } else if animate && moved && list_changed(&key.0) {
            place.slide_from = slide_from(current, delta);
            place.since = Some(Instant::now());
        }
        offset_of(place)
    })
}

pub struct Sliding {
    key: (String, TabId),
    profile: String,
    animate: bool,
    child: AnyElement,
}

pub fn sliding(
    window: &str,
    tab: &TabId,
    profile: &str,
    animate: bool,
    child: AnyElement,
) -> Sliding {
    Sliding {
        key: (window.to_owned(), tab.clone()),
        profile: profile.to_owned(),
        animate,
        child,
    }
}

impl Element for Sliding {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let shift = observe(&self.key, &self.profile, bounds, self.animate);
        match shift {
            Some(dy) => {
                window.request_animation_frame();
                window.with_element_offset(point(Pixels::ZERO, Pixels::from(dy)), |window| {
                    self.child.prepaint(window, cx)
                });
            }
            None => {
                self.child.prepaint(window, cx);
            }
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}

pub fn note_row(window: &str, tab: &TabId, snap: RowSnap) {
    SNAPS.with(|snaps| {
        snaps
            .borrow_mut()
            .insert((window.to_owned(), tab.clone()), snap)
    });
}

pub fn closed_rows(
    before: &[TabId],
    after: &[TabId],
    still_open: impl Fn(&TabId) -> bool,
) -> Vec<TabId> {
    let kept: std::collections::HashSet<&TabId> = after.iter().collect();
    before
        .iter()
        .filter(|id| !kept.contains(id) && !still_open(id))
        .cloned()
        .collect()
}

pub fn note_closes(window: &str, closed: &[TabId]) {
    if closed.is_empty() {
        return;
    }
    let now = Instant::now();
    #[expect(
        clippy::needless_collect,
        reason = "the filter_map takes snapshots out eagerly, before the ghost list is borrowed"
    )]
    let found: Vec<Ghost> = closed
        .iter()
        .filter_map(|tab| {
            let key = (window.to_owned(), tab.clone());
            let snap = SNAPS.with(|snaps| snaps.borrow_mut().remove(&key))?;
            let place = PLACES.with(|places| {
                let mut places = places.borrow_mut();
                let place = places.get(&key).copied()?;
                let fresh = fresh(&places, window, &place);
                places.remove(&key);
                fresh.then_some(place)
            })?;
            Some(Ghost {
                snap,
                top: place.top,
                left: place.left,
                width: place.width,
                since: now,
            })
        })
        .collect();
    if found.is_empty() {
        return;
    }
    GHOSTS.with(|ghosts| {
        ghosts
            .borrow_mut()
            .entry(window.to_owned())
            .or_default()
            .extend(found)
    });
}

pub fn close_fade(elapsed: Duration) -> f32 {
    let t = elapsed.as_secs_f64() / Duration::from_millis(CLOSE_FADE_MS).as_secs_f64();
    1.0 - CubicBezier::EASE_OUT.ease(t.clamp(0.0, 1.0)) as f32
}

pub fn ghosts_under(window: &str, anchor: &TabId) -> Option<AnyElement> {
    let (top, left) = PLACES.with(|places| {
        places
            .borrow()
            .get(&(window.to_owned(), anchor.clone()))
            .map(|p| (p.top + offset_of(p).unwrap_or(0.0), p.left))
    })?;
    let live: Vec<Ghost> = GHOSTS.with(|ghosts| {
        let mut ghosts = ghosts.borrow_mut();
        let list = ghosts.entry(window.to_owned()).or_default();
        list.retain(|g| g.since.elapsed() < Duration::from_millis(CLOSE_FADE_MS));
        list.clone()
    });
    if live.is_empty() {
        return None;
    }
    let row_height = sidebar::row_height();
    Some(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_0()
            .child(crate::sidebar::tab_row::frame_pump())
            .children(live.into_iter().map(|ghost| {
                let snap = ghost.snap;
                div()
                    .absolute()
                    .top(Pixels::from(ghost.top - top))
                    .left(Pixels::from(ghost.left - left))
                    .w(Pixels::from(ghost.width))
                    .h(px(row_height))
                    .opacity(close_fade(ghost.since.elapsed()))
                    .rounded(px(sidebar::row_radius(row_height)))
                    .when(snap.hovered, |d| d.bg(snap.hover))
                    .pl(px(sidebar::ROW_CONTENT_LEFT + snap.indent))
                    .pr(px(sidebar::ROW_TRAILING))
                    .flex()
                    .items_center()
                    .gap(px(crate::sidebar::tab_row::TITLE_GAP))
                    .child(render_favicon(&snap.favicon, snap.icon_size, &snap.palette))
                    .child(fade_label(snap.title.clone(), snap.ink, snap.title_size))
                    .when(snap.hovered, |d| {
                        d.child(
                            div()
                                .flex_none()
                                .size(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(icon(Icon::XMark, 13., snap.icon_ink)),
                        )
                    })
                    .into_any_element()
            }))
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_rows_painted_in_the_frame_before_slide() {
        assert!(painted_last_frame(4, 5));
        assert!(!painted_last_frame(3, 5));
        assert!(!painted_last_frame(0, 1));
    }

    #[test]
    fn only_a_reorder_or_regroup_counts_as_a_list_change() {
        let id = |s: &str| TabId::from(s);
        let a = vec![id("a"), id("b")];
        let b = vec![id("b"), id("a")];
        assert!(!order_changed((&a, &1), (&a, &1)));
        assert!(order_changed((&a, &1), (&b, &1)));
        assert!(order_changed((&a, &1), (&a, &2)));
        assert!(!list_changed("nobody"));
        note_list_change("w");
        assert!(list_changed("w"));
    }

    #[test]
    fn a_slide_restarts_from_where_the_row_is_drawn() {
        assert_eq!(slide_from(0.0, 74.0), 74.0);
        assert_eq!(slide_from(-12.0, 37.0), 25.0);
    }

    #[test]
    fn new_rows_fade_in_only_for_a_few_fresh_tabs() {
        let id = |s: &str| TabId::from(s);
        assert!(opened_rows(&[], &[id("a")]).is_empty());
        assert_eq!(opened_rows(&[id("a")], &[id("a"), id("b")]), vec![id("b")]);
        assert!(opened_rows(&[id("a")], &[id("x"), id("y")]).is_empty());
        let many: Vec<TabId> = (0..6)
            .map(|i| id(&format!("n{i}")))
            .chain([id("a")])
            .collect();
        assert!(opened_rows(&[id("a")], &many).is_empty());
        assert_eq!(appear_progress(Duration::ZERO), 0.0);
        assert!((appear_progress(Duration::from_millis(APPEAR_MS)) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn the_slide_eases_to_rest_in_140_ms() {
        assert_eq!(slide_progress(Duration::ZERO), 0.0);
        assert!((slide_progress(Duration::from_millis(140)) - 1.0).abs() < 1e-4);
        assert!(slide_progress(Duration::from_millis(70)) > 0.5);
    }
}
