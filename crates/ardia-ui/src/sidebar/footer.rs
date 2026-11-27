use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::windows::WindowKind;
use ardia_state::{Action, ProfileId};
use ardia_theme::layout::sidebar;
use gpui::{
    Animation, AnimationExt, AnyElement, ElementId, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, div, prelude::*,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::EmptyDrag;
use crate::sidebar::header::{
    DOWNLOADS_SIZE, downloads_button, downloads_in_footer, footer_downloads_inset, has_downloads,
    window_drag,
};
use crate::sidebar::pager::with_pager;
use crate::window::chrome::Chrome;

pub const SWITCHER_ICON_CELL: f32 = 26.0;
pub const SWITCHER_ICON: f32 = 11.0;
pub const FOOTER_BOTTOM_GAP: f32 = 3.0;
pub const DOT_TOOLTIP_LIFT: f32 = 18.25;
pub const TOOLTIP_DELAY: Duration = Duration::from_millis(500);
pub const TOOLTIP_FADE: Duration = Duration::from_millis(100);
pub const DOT_DRAG_START: f32 = 4.0;
pub const DOT_SETTLE: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwitcherLevels {
    pub selected: f32,
    pub hovered: f32,
    pub idle: f32,
}

impl SwitcherLevels {
    pub fn of(self, selected: bool) -> f32 {
        if selected { self.selected } else { self.idle }
    }

    pub fn at(self, distance: f32, rest: f32) -> f32 {
        let near = (1.0 - distance.abs()).clamp(0.0, 1.0);
        rest + (self.selected - rest) * near
    }
}

pub fn switcher_levels(icon: bool) -> SwitcherLevels {
    if icon {
        SwitcherLevels {
            selected: 1.0,
            hovered: 0.7,
            idle: 0.42,
        }
    } else {
        SwitcherLevels {
            selected: sidebar::SWITCHER_ALPHA_SELECTED,
            hovered: sidebar::SWITCHER_ALPHA_HOVERED,
            idle: sidebar::SWITCHER_ALPHA_REST,
        }
    }
}

pub fn switcher_cell(icon: bool) -> f32 {
    if icon {
        SWITCHER_ICON_CELL
    } else {
        sidebar::SWITCHER_ITEM
    }
}

pub fn switcher_band_top() -> f32 {
    (sidebar::FOOTER_HEIGHT - FOOTER_BOTTOM_GAP - sidebar::SWITCHER_BAND_HEIGHT) / 2.0
}

pub fn switcher_icons(icons: Vec<Option<String>>, room: f32) -> Vec<Option<String>> {
    let width: f32 = icons.iter().map(|i| switcher_cell(i.is_some())).sum();
    if width <= room {
        icons
    } else {
        icons.iter().map(|_| None).collect()
    }
}

pub fn dots_row_left_inset(width: f32, row: f32, side_room: f32) -> f32 {
    (row + 2.0 * side_room - width).clamp(0.0, side_room.max(0.0))
}

pub fn side_room_beside_downloads() -> f32 {
    footer_downloads_inset() + DOWNLOADS_SIZE + 4.0
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DotDrag {
    pub shift: f32,
    pub to: usize,
}

pub fn dot_drag(widths: &[f32], from: usize, dx: f32) -> DotDrag {
    let starts: Vec<f32> = widths
        .iter()
        .scan(0.0, |sum, w| {
            let start = *sum;
            *sum += w;
            Some(start)
        })
        .collect();
    let width = widths.get(from).copied().unwrap_or(0.0);
    let start = starts.get(from).copied().unwrap_or(0.0);
    let total: f32 = widths.iter().sum();
    let shift = dx.max(-start).min(total - start - width);
    let center = start + width / 2.0 + shift;
    let to = widths
        .iter()
        .enumerate()
        .filter(|(j, w)| {
            *j != from && {
                let mid = starts[*j] + *w / 2.0;
                if *j < from {
                    mid < center
                } else {
                    mid <= center
                }
            }
        })
        .count();
    DotDrag { shift, to }
}

pub fn dot_shifts(widths: &[f32], from: usize, to: usize) -> Vec<f32> {
    let gap = widths.get(from).copied().unwrap_or(0.0);
    (0..widths.len())
        .map(|j| {
            if j == from {
                0.0
            } else if from < j && j <= to {
                -gap
            } else if to <= j && j < from {
                gap
            } else {
                0.0
            }
        })
        .collect()
}

pub fn moved_order(ids: &[ProfileId], from: usize, to: usize) -> Vec<ProfileId> {
    let mut out = ids.to_vec();
    if from >= out.len() || from == to {
        return out;
    }
    let id = out.remove(from);
    out.insert(to.min(out.len()), id);
    out
}

#[derive(Clone, Debug)]
struct Reorder {
    id: ProfileId,
    started: bool,
    shift: f32,
    to: usize,
}

#[derive(Clone, Copy, Debug)]
struct Tween {
    from: f32,
    to: f32,
    start: Instant,
}

impl Tween {
    fn value(&self, now: Instant) -> f32 {
        let t = (now.saturating_duration_since(self.start).as_secs_f32()
            / DOT_SETTLE.as_secs_f32())
        .clamp(0.0, 1.0);
        let eased = 1.0 - (1.0 - t).powi(3);
        self.from + (self.to - self.from) * eased
    }

    fn done(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.start) >= DOT_SETTLE
    }
}

#[derive(Default)]
struct FooterState {
    down_x: f32,
    reorder: Option<Reorder>,
    tweens: HashMap<ProfileId, Tween>,
    hovered: Option<(ProfileId, Instant)>,
    pressed: Option<ProfileId>,
}

thread_local! {
    static FOOTERS: RefCell<HashMap<String, FooterState>> = RefCell::new(HashMap::new());
}

fn with_footer<R>(window: &str, f: impl FnOnce(&mut FooterState) -> R) -> R {
    FOOTERS.with(|footers| f(footers.borrow_mut().entry(window.to_owned()).or_default()))
}

pub fn footer_moving(window: &str, now: Instant) -> bool {
    with_footer(window, |s| s.tweens.values().any(|t| !t.done(now)))
}

#[derive(Clone)]
struct DotPayload;

fn shifted(state: &mut FooterState, id: &ProfileId, target: f32, now: Instant) -> f32 {
    let current = state.tweens.get(id).map_or(0.0, |t| t.value(now));
    let retarget = state
        .tweens
        .get(id)
        .is_none_or(|t| (t.to - target).abs() > f32::EPSILON);
    if retarget {
        state.tweens.insert(
            id.clone(),
            Tween {
                from: current,
                to: target,
                start: now,
            },
        );
    }
    state.tweens.get(id).map_or(target, |t| t.value(now))
}

fn tooltip_above(c: &Chrome, name: SharedString, cell: f32, key: String) -> AnyElement {
    let p = *c.p;
    let delay = TOOLTIP_DELAY.as_secs_f32();
    let total = delay + TOOLTIP_FADE.as_secs_f32();
    div()
        .absolute()
        .left(px(cell / 2.0 - 140.0))
        .w(px(280.0))
        .bottom(px(sidebar::SWITCHER_BAND_HEIGHT / 2.0 + DOT_TOOLTIP_LIFT))
        .flex()
        .justify_center()
        .child(crate::primitives::controls::tooltip_above_plate(name, &p))
        .with_animation(
            ElementId::Name(SharedString::from(key)),
            Animation::new(Duration::from_secs_f32(total)),
            move |this, delta| {
                let at = delta * total;
                this.opacity(((at - delay) / (total - delay)).clamp(0.0, 1.0))
            },
        )
        .into_any_element()
}

fn mark(
    host: &dyn crate::host::UiHost,
    icon: Option<&str>,
    color: gpui::Hsla,
    opacity: f32,
) -> AnyElement {
    if let Some(name) = crate::icon_picker::symbols::icon_symbol(icon) {
        return div()
            .opacity(opacity)
            .child(crate::icon_picker::symbols::symbol(
                host,
                name,
                SWITCHER_ICON,
                SWITCHER_ICON_CELL,
                crate::icon_picker::symbols::SymbolWeight::Semibold,
                color,
            ))
            .into_any_element();
    }
    match icon {
        Some(text) => div()
            .w(px(SWITCHER_ICON_CELL))
            .flex()
            .justify_center()
            .text_size(px(SWITCHER_ICON))
            .line_height(px(SWITCHER_ICON_CELL))
            .text_color(color)
            .opacity(opacity)
            .child(SharedString::from(text.to_owned()))
            .into_any_element(),
        None => div()
            .size(px(sidebar::SWITCHER_DOT))
            .rounded_full()
            .bg(color.opacity(opacity))
            .into_any_element(),
    }
}

pub fn dots_shown(c: &Chrome) -> bool {
    c.state.settings.show_profile_dots
        && !crate::sidebar::header::minimal_parts_hidden(c)
        && c.state.profile_order.len() > 1
        && c.window.kind != WindowKind::Incognito
}

fn dots(c: &Chrome, beside_downloads: bool, position: f32) -> AnyElement {
    let p = *c.p;
    let window_id = c.window.id.clone();
    let key = window_id.as_str().to_owned();
    let ids = c.state.profile_order.clone();
    let width = c.layout.sidebar_width;
    let side_room = if beside_downloads {
        side_room_beside_downloads()
    } else {
        sidebar::INSET
    };
    let saved: Vec<Option<String>> = ids
        .iter()
        .map(|id| {
            c.state
                .profile(id.as_str())
                .and_then(|profile| profile.switcher_icon().map(str::to_owned))
        })
        .collect();
    let icons = switcher_icons(saved, width - 2.0 * side_room);
    let widths: Vec<f32> = icons.iter().map(|i| switcher_cell(i.is_some())).collect();
    let row: f32 = widths.iter().sum();
    let now = Instant::now();
    let (reorder, hovered, pressed) = with_footer(&key, |s| {
        (s.reorder.clone(), s.hovered.clone(), s.pressed.clone())
    });
    let reordering = reorder.as_ref().is_some_and(|r| r.started);
    let shifts = reorder.as_ref().filter(|r| r.started).and_then(|r| {
        let from = ids.iter().position(|id| *id == r.id)?;
        Some((from, dot_shifts(&widths, from, r.to), r.shift))
    });
    let offsets: Vec<f32> = with_footer(&key, |s| {
        ids.iter()
            .enumerate()
            .map(|(j, id)| match &shifts {
                Some((from, _, own)) if *from == j => {
                    s.tweens.remove(id);
                    *own
                }
                Some((_, targets, _)) => shifted(s, id, targets[j], now),
                None => shifted(s, id, 0.0, now),
            })
            .collect()
    });
    let left = if beside_downloads {
        dots_row_left_inset(width, row, side_room)
    } else {
        0.0
    };
    let commit = {
        let emit = c.emit.clone();
        let key = key.clone();
        let ids = ids.clone();
        let widths = widths.clone();
        move |window: &mut gpui::Window, cx: &mut gpui::App| {
            let done = with_footer(&key, |s| s.reorder.take());
            let Some(done) = done.filter(|d| d.started) else {
                return;
            };
            let Some(from) = ids.iter().position(|id| *id == done.id) else {
                return;
            };
            let to = dot_drag(&widths, from, done.shift).to;
            if from != to {
                with_footer(&key, |s| s.tweens.clear());
                ardia_telemetry::counts::count("profile_dot_reorders");
                emit.send(
                    Msg::Store(Action::ReorderProfiles {
                        order: moved_order(&ids, from, to),
                    }),
                    window,
                    cx,
                );
            }
            window.refresh();
        }
    };
    let commit_up = commit.clone();
    let drag_move = {
        let key = key.clone();
        let ids = ids.clone();
        move |event: &gpui::DragMoveEvent<DotPayload>,
              window: &mut gpui::Window,
              _: &mut gpui::App| {
            let x = crate::scale::points(event.event.position.x);
            with_footer(&key, |s| {
                let down = s.down_x;
                let Some(reorder) = s.reorder.as_mut() else {
                    return;
                };
                let dx = x - down;
                if !reorder.started && dx.abs() <= DOT_DRAG_START {
                    return;
                }
                reorder.started = true;
                if let Some(from) = ids.iter().position(|id| *id == reorder.id) {
                    let drag = dot_drag(&widths, from, dx);
                    reorder.shift = drag.shift;
                    reorder.to = drag.to;
                }
            });
            window.refresh();
        }
    };
    let cells = ids.iter().enumerate().filter_map(|(index, id)| {
        let profile = c.state.profile(id.as_str())?;
        let icon = icons.get(index).cloned().flatten();
        let levels = switcher_levels(icon.is_some());
        let is_hovered = hovered.as_ref().is_some_and(|(h, _)| h == id);
        let rest = if is_hovered {
            levels.hovered
        } else {
            levels.idle
        };
        let opacity = levels.at(index as f32 - position, rest);
        let cell = switcher_cell(icon.is_some());
        let name = SharedString::from(profile.name.clone());
        let lifted = reorder.as_ref().is_some_and(|r| r.started && r.id == *id);
        let show_tip = is_hovered && !reordering && pressed.as_ref() != Some(id);
        let tip_key = hovered
            .as_ref()
            .map(|(_, at)| format!("dot-tip:{key}:{id}:{at:?}"))
            .unwrap_or_default();
        let hover_key = key.clone();
        let down_key = key.clone();
        let click_key = key.clone();
        let hover_id = id.clone();
        let down_id = id.clone();
        let click_id = id.clone();
        let emit = c.emit.clone();
        let window_for_click = window_id.clone();
        let has_icon = icon.is_some();
        Some(
            div()
                .id(SharedString::from(format!("profile-dot:{id}")))
                .relative()
                .flex_none()
                .left(px(offsets.get(index).copied().unwrap_or(0.0)))
                .when(lifted, |this| this.occlude())
                .w(px(cell))
                .h(px(sidebar::SWITCHER_BAND_HEIGHT))
                .flex()
                .items_center()
                .justify_center()
                .on_hover(move |hovered, window, _| {
                    with_footer(&hover_key, |s| {
                        if *hovered {
                            s.hovered = Some((hover_id.clone(), Instant::now()));
                        } else if s.hovered.as_ref().is_some_and(|(h, _)| *h == hover_id) {
                            s.hovered = None;
                            s.pressed = None;
                        }
                    });
                    window.refresh();
                })
                .on_mouse_down(MouseButton::Left, move |event, _, cx| {
                    cx.stop_propagation();
                    let x = crate::scale::points(event.position.x);
                    with_footer(&down_key, |s| {
                        s.down_x = x;
                        s.reorder = Some(Reorder {
                            id: down_id.clone(),
                            started: false,
                            shift: 0.0,
                            to: 0,
                        });
                    });
                })
                .on_drag(DotPayload, |_, _, _, cx| cx.new(|_| EmptyDrag))
                .on_mouse_down(MouseButton::Right, {
                    let emit = c.emit.clone();
                    let id = id.clone();
                    move |event, window, cx| {
                        cx.stop_propagation();
                        emit.send(
                            Msg::Menu(Some((MenuTarget::ProfileItem(id.clone()), event.position))),
                            window,
                            cx,
                        );
                    }
                })
                .on_click(move |_, window, cx| {
                    let started = with_footer(&click_key, |s| {
                        s.pressed = Some(click_id.clone());
                        s.reorder.take().is_some_and(|r| r.started)
                    });
                    if started {
                        return;
                    }
                    crate::press_telemetry::note_switcher_press(
                        window_for_click.as_str(),
                        click_id.as_str(),
                        has_icon,
                    );
                    page_to_profile(&window_for_click, &click_id, index, &emit, window, cx);
                })
                .when(show_tip, |this| {
                    this.child(tooltip_above(c, name.clone(), cell, tip_key))
                })
                .when(lifted, |this| {
                    this.child(crate::profiles::hold_plate(icon.is_some(), cell, p.dark))
                })
                .child(mark(c.host.as_ref(), icon.as_deref(), p.mark, opacity))
                .into_any_element(),
        )
    });
    div()
        .id("profile-switcher")
        .debug_selector(|| "profile-switcher".into())
        .w_full()
        .h(px(sidebar::FOOTER_HEIGHT))
        .flex()
        .flex_col()
        .items_center()
        .pl(px(left))
        .child(
            div()
                .mt(px(switcher_band_top()))
                .h(px(sidebar::SWITCHER_BAND_HEIGHT))
                .flex()
                .flex_row()
                .on_drag_move(drag_move)
                .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                    commit_up(window, cx)
                })
                .on_mouse_up_out(MouseButton::Left, move |_, window, cx| commit(window, cx))
                .children(cells),
        )
        .into_any_element()
}

pub fn page_to_profile(
    window_id: &ardia_state::WindowId,
    profile: &ProfileId,
    index: usize,
    emit: &crate::msg::Emit,
    window: &mut gpui::Window,
    cx: &mut gpui::App,
) {
    with_pager(window_id.as_str(), |pager| {
        pager.page_to(profile, index, Instant::now(), true)
    });
    emit.send(
        Msg::Store(Action::SwitchProfile {
            window: window_id.clone(),
            profile: profile.clone(),
        }),
        window,
        cx,
    );
    window.refresh();
}

pub fn footer_height(c: &Chrome) -> f32 {
    if dots_shown(c) || (has_downloads(c) && downloads_in_footer(c)) {
        sidebar::FOOTER_HEIGHT
    } else {
        0.0
    }
}

pub fn footer(c: &Chrome, position: f32) -> Option<AnyElement> {
    let height = footer_height(c);
    if height <= 0.0 {
        return None;
    }
    let footer_downloads = has_downloads(c) && downloads_in_footer(c);
    let emit = c.emit.clone();
    Some(
        window_drag(div())
            .id("sidebar-footer")
            .debug_selector(|| "sidebar-footer".into())
            .flex_none()
            .relative()
            .mx(px(-sidebar::INSET))
            .h(px(height))
            .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                emit.send(
                    Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                    window,
                    cx,
                )
            })
            .when(dots_shown(c), |this| {
                this.child(div().absolute().left_0().right_0().bottom_0().child(dots(
                    c,
                    footer_downloads,
                    position,
                )))
            })
            .when(footer_downloads, |this| {
                this.child(
                    div()
                        .absolute()
                        .left(px(footer_downloads_inset()))
                        .bottom(px(footer_downloads_inset()))
                        .child(downloads_button(c)),
                )
            })
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switcher_band_sits_above_the_footer_gap() {
        assert_eq!(switcher_band_top(), 5.0);
        assert_eq!(
            switcher_band_top() + sidebar::SWITCHER_BAND_HEIGHT + FOOTER_BOTTOM_GAP + 5.0,
            sidebar::FOOTER_HEIGHT
        );
    }

    #[test]
    fn switcher_marks_use_the_legacy_cells_and_levels() {
        assert_eq!(switcher_cell(false), 12.0);
        assert_eq!(switcher_cell(true), 26.0);
        let dots = switcher_levels(false);
        assert_eq!((dots.selected, dots.hovered, dots.idle), (0.85, 0.4, 0.2));
        let icons = switcher_levels(true);
        assert_eq!(icons.of(true), 1.0);
        assert_eq!(icons.of(false), 0.42);
    }

    #[test]
    fn a_dot_brightens_as_its_page_comes_into_view() {
        let dots = switcher_levels(false);
        assert_eq!(dots.at(0.0, 0.2), 0.85);
        assert_eq!(dots.at(1.0, 0.2), 0.2);
        assert!((dots.at(0.5, 0.2) - 0.525).abs() < 1e-6);
        assert_eq!(dots.at(-3.0, 0.4), 0.4);
    }

    #[test]
    fn icons_fall_back_to_dots_when_they_do_not_fit() {
        let icons = vec![Some("🏠".to_owned()), None];
        assert_eq!(switcher_icons(icons.clone(), 100.0), icons);
        assert_eq!(switcher_icons(icons, 30.0), vec![None, None]);
    }

    #[test]
    fn the_row_beside_downloads_moves_right_only_when_it_must() {
        assert_eq!(side_room_beside_downloads(), 43.0);
        assert_eq!(dots_row_left_inset(240.0, 48.0, 43.0), 0.0);
        assert_eq!(dots_row_left_inset(160.0, 104.0, 43.0), 30.0);
        assert_eq!(dots_row_left_inset(100.0, 104.0, 43.0), 43.0);
    }

    #[test]
    fn dragging_a_dot_reorders_by_its_centre() {
        let widths = [12.0, 12.0, 12.0, 12.0];
        assert_eq!(dot_drag(&widths, 0, 0.0), DotDrag { shift: 0.0, to: 0 });
        assert_eq!(dot_drag(&widths, 0, 13.0).to, 1);
        assert_eq!(dot_drag(&widths, 0, 100.0), DotDrag { shift: 36.0, to: 3 });
        assert_eq!(
            dot_drag(&widths, 3, -100.0),
            DotDrag {
                shift: -36.0,
                to: 0
            }
        );
        assert_eq!(dot_shifts(&widths, 0, 2), vec![0.0, -12.0, -12.0, 0.0]);
        assert_eq!(dot_shifts(&widths, 3, 1), vec![0.0, 12.0, 12.0, 0.0]);
        let ids: Vec<ProfileId> = ["a", "b", "c"].into_iter().map(ProfileId::new).collect();
        let moved = moved_order(&ids, 0, 2);
        assert_eq!(moved, vec![ids[1].clone(), ids[2].clone(), ids[0].clone()]);
    }
}
