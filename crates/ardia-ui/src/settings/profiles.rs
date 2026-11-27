use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use ardia_state::profile_circles::{self, list_of};
use ardia_state::profiles::Profile;
use ardia_state::{Action, ProfileId};
use ardia_theme::motion::Spring;
use gpui::{
    AnyElement, App, Bounds, DispatchPhase, Entity, FontWeight, Hsla, IntoElement, MouseButton,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, RenderOnce, ScrollHandle, SharedString,
    Styled, Window, canvas, deferred, div, point, prelude::*, rgba,
};

use crate::host::UiHost;
use crate::icon_picker::Anchor;
use crate::icon_picker::symbols::icon_symbol;
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{IconButton, PushButton, Toggle};
use crate::primitives::icons::Icon;
use crate::primitives::theme_bridge::hsla;
use crate::primitives::tokens::{Curve, SpringPair, Tween, duration};
use crate::profiles::layer::{PeopleMsg, ProfilePlace};
use crate::profiles::{PROFILE_SYMBOLS, profile_badge, tokens as profile_tokens};
use crate::scale::px;
use crate::settings::SettingsWindowView;
use crate::settings::panes::{ROW_MIN_HEIGHT, ROW_PAD_X, ROW_PAD_Y, selected_profile};

pub const PILL_HEIGHT: f32 = 28.0;
pub const PILL_BADGE: f32 = 18.0;
pub const PILL_PLUS_GLYPH: f32 = 13.0;
pub const PILL_GAP: f32 = 2.0;
pub const PILL_NAME_MAX: f32 = 160.0;
pub const TRAY_PAD: f32 = 2.0;
pub const BAR_TOP: f32 = 20.0;
pub const DRAG_SLOP: f32 = 3.0;
pub const HEAD_BADGE: f32 = 64.0;
pub const HEAD_GAP: f32 = 10.0;
pub const HEAD_NAME_LINE: f32 = 18.0;
pub const HEAD_LINE_GAP: f32 = 1.0;
pub const STACK_DOT: f32 = 14.0;
pub const THUMB_SPRING: Spring = Spring::new(0.2, 0.9);
pub const BADGE_ANCHOR: &str = "profile-head-badge";
pub const CHANGE_ANCHOR: &str = "profile-icon-change";
const TRAY_KEY: &str = "settings-profile-tray";

thread_local! {
    static SAVED_STRIP_X: Cell<f32> = const { Cell::new(0.0) };
    static ANCHORS: RefCell<HashMap<String, Anchor>> = RefCell::new(HashMap::new());
}

pub fn pill_anchor_key(profile: &str) -> String {
    format!("profile-pill:{profile}")
}

pub fn anchor_of(key: &str) -> Option<Anchor> {
    ANCHORS.with(|anchors| anchors.borrow().get(key).copied())
}

fn remember_anchor(key: String, bounds: Bounds<Pixels>) {
    let anchor = Anchor {
        x: crate::scale::points(bounds.origin.x),
        y: crate::scale::points(bounds.origin.y),
        width: crate::scale::points(bounds.size.width),
        height: crate::scale::points(bounds.size.height),
    };
    ANCHORS.with(|anchors| {
        anchors.borrow_mut().insert(key, anchor);
    });
}

fn measured(key: String) -> impl IntoElement {
    canvas(
        move |bounds, _, _| remember_anchor(key, bounds),
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
}

pub fn icon_picker_msgs(profile: &ProfileId, anchor: Option<Anchor>) -> Vec<Msg> {
    vec![
        Msg::People(PeopleMsg::AnchorAt(anchor)),
        Msg::People(PeopleMsg::OpenIconPicker {
            profile: profile.clone(),
            place: ProfilePlace::Settings,
        }),
    ]
}

fn send_all(emit: &Emit, msgs: Vec<Msg>, window: &mut Window, cx: &mut App) {
    for msg in msgs {
        emit.send(msg, window, cx);
    }
}

pub fn icon_title(icon: Option<&str>) -> String {
    if let Some(symbol) = icon_symbol(icon) {
        return PROFILE_SYMBOLS
            .iter()
            .find(|s| s.name == symbol)
            .map(|s| s.title.to_owned())
            .unwrap_or_else(|| "Symbol".to_owned());
    }
    icon.map(str::to_owned).unwrap_or_else(|| "None".to_owned())
}

pub fn description(view: &SettingsWindowView, id: &str) -> Option<String> {
    let state = &view.state;
    let profile = selected_profile(view)?;
    let sharing = profile_circles::shared_with(state, &profile).len() > 1;
    match id {
        "profiles.icon" => Some(icon_title(state.profile(profile.as_str())?.icon.as_deref())),
        "profiles.syncThisProfile" if sharing => Some(
            "Its tabs sync here; the data it shares syncs with the profile that owns it."
                .to_owned(),
        ),
        "profiles.clearBrowsingData" => Some(if sharing {
            "History, cookies, site data and cached files, for every profile that shares them."
                .to_owned()
        } else {
            "History, cookies, site data and cached files for this profile.".to_owned()
        }),
        "profiles.deleteProfile" => Some(if state.profile_order.len() <= 1 {
            "You can't delete your only profile.".to_owned()
        } else if sharing {
            "Removes its tabs. The data it shares stays.".to_owned()
        } else {
            "Removes its tabs, history, bookmarks and site data.".to_owned()
        }),
        "profiles.shareTopApps" => Some(
            if profile_circles::data_sharing_profile_ids(state).is_empty() {
                "For profiles that share data with another. None do yet.".to_owned()
            } else {
                "For profiles that share data: the same Top Apps, one live page each.".to_owned()
            },
        ),
        _ => None,
    }
}

fn color_stack(colors: &[Hsla], dark: bool) -> AnyElement {
    let shown = &colors[..colors.len().min(4)];
    let ring: Hsla = rgba(if dark {
        profile_tokens::STACK_RING_DARK
    } else {
        profile_tokens::STACK_RING_LIGHT
    })
    .into();
    div()
        .flex_none()
        .flex()
        .w(px(
            STACK_DOT + shown.len().saturating_sub(1) as f32 * STACK_DOT * 0.6
        ))
        .children(shown.iter().enumerate().map(|(i, color)| {
            div()
                .flex_none()
                .size(px(STACK_DOT))
                .rounded_full()
                .bg(*color)
                .border(px(1.))
                .border_color(ring)
                .when(i > 0, |this| this.ml(px(-STACK_DOT * 0.4)))
        }))
        .into_any_element()
}

fn extra_row(
    p: &Palette,
    id: String,
    leading: Option<AnyElement>,
    title: SharedString,
    detail: Option<String>,
    control: Option<AnyElement>,
) -> AnyElement {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector)
        .min_h(px(ROW_MIN_HEIGHT))
        .px(px(ROW_PAD_X))
        .py(px(ROW_PAD_Y))
        .flex()
        .items_center()
        .gap(px(12.))
        .children(leading)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .text_color(p.text)
                        .child(title),
                )
                .when_some(detail, |this, detail| {
                    this.child(
                        div()
                            .mt(px(2.))
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(p.text_secondary)
                            .child(detail),
                    )
                }),
        )
        .children(control.map(|control| div().flex_none().child(control)))
        .into_any_element()
}

fn row_toggle(
    view: &SettingsWindowView,
    key: String,
    on: bool,
    disabled: bool,
    msgs: impl Fn(bool) -> Vec<Msg> + 'static,
) -> AnyElement {
    let emit = view.emit.clone();
    let selector = format!("toggle:{key}");
    div()
        .debug_selector(move || selector)
        .child(
            Toggle::new(
                SharedString::from(format!("toggle:{key}")),
                on,
                &view.look.p,
            )
            .native(true)
            .disabled(disabled)
            .on_toggle(move |value, window, cx| send_all(&emit, msgs(value), window, cx)),
        )
        .into_any_element()
}

pub fn icon_control(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let Some(profile) = selected_profile(view) else {
        return div().into_any_element();
    };
    let has_icon = view
        .state
        .profile(profile.as_str())
        .is_some_and(|found| found.icon.is_some());
    let remove = has_icon.then(|| {
        let profile = profile.clone();
        div().debug_selector(|| "profile-icon-remove".into()).child(
            PushButton::new("profile-icon-remove", "Remove", &p).on_click(view.emit.click(
                Msg::Store(Action::UpdateProfile {
                    profile,
                    patch: ardia_state::ProfilePatch {
                        icon: Some(None),
                        ..ardia_state::ProfilePatch::default()
                    },
                }),
            )),
        )
    });
    let emit = view.emit.clone();
    let change = div()
        .relative()
        .debug_selector(|| "profile-icon-change".into())
        .child(measured(CHANGE_ANCHOR.to_owned()))
        .child(
            PushButton::new(
                "profile-icon-change",
                if has_icon { "Change…" } else { "Add…" },
                &p,
            )
            .on_click(move |_, window, cx| {
                send_all(
                    &emit,
                    icon_picker_msgs(&profile, anchor_of(CHANGE_ANCHOR)),
                    window,
                    cx,
                )
            }),
        );
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .children(remove)
        .child(change)
        .into_any_element()
}

pub fn shared_data_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let Some(profile) = selected_profile(view) else {
        return Vec::new();
    };
    let shared = profile_circles::shared_with(&view.state, &profile);
    if shared.len() < 2 {
        return Vec::new();
    }
    let profiles: Vec<&Arc<Profile>> = shared
        .iter()
        .filter_map(|id| view.state.profile(id.as_str()))
        .collect();
    let names: Vec<String> = profiles.iter().map(|found| found.name.clone()).collect();
    let colors: Vec<Hsla> = profiles
        .iter()
        .map(|found| hsla(ardia_theme::profile_accent(found.look())))
        .collect();
    vec![extra_row(
        &p,
        "profile-shared-data".to_owned(),
        Some(color_stack(&colors, p.dark)),
        SharedString::new_static("Shared data"),
        Some(format!(
            "{} share Cookies, Passwords, Extensions, Bookmarks, and History. Each keeps its own tabs.",
            list_of(&names, "and")
        )),
        None,
    )]
}

pub fn sync_toggle(view: &SettingsWindowView) -> AnyElement {
    let Some(profile) = selected_profile(view) else {
        return div().into_any_element();
    };
    let link = view
        .sync_status
        .profiles
        .iter()
        .find(|link| link.profile_id == profile);
    let on = link.is_some_and(|link| link.enabled);
    let host = Arc::clone(&view.host);
    let emit_profile = profile.clone();
    row_toggle(
        view,
        "profiles.syncThisProfile".to_owned(),
        on,
        link.is_none(),
        move |on| {
            host.set_profile_synced(emit_profile.clone(), on);
            Vec::new()
        },
    )
}

pub fn sync_tab_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    let Some(profile) = selected_profile(view) else {
        return Vec::new();
    };
    let status = &view.sync_status;
    let synced = status.enabled
        && status
            .profiles
            .iter()
            .any(|link| link.profile_id == profile && link.enabled);
    if !synced {
        return Vec::new();
    }
    let on = view
        .state
        .profile(profile.as_str())
        .is_some_and(|found| found.sync_tabs);
    let tabs_type = status.data_types.get("tabs").copied().unwrap_or(true);
    let host = Arc::clone(&view.host);
    let target = profile;
    let toggle = row_toggle(
        view,
        "profiles.syncTabs".to_owned(),
        on,
        !tabs_type,
        move |on| {
            host.set_profile_tabs_synced(target.clone(), on);
            Vec::new()
        },
    );
    vec![extra_row(
        &p,
        "setting:profiles.syncTabs".to_owned(),
        None,
        SharedString::new_static("Sync All Open Tabs"),
        Some(
            "Every open tab in this profile, not just pinned ones, is the same on all your Macs."
                .to_owned(),
        ),
        Some(toggle),
    )]
}

pub fn share_top_apps_rows(view: &SettingsWindowView) -> Vec<AnyElement> {
    let p = view.look.p;
    profile_circles::data_sharing_profile_ids(&view.state)
        .into_iter()
        .filter_map(|id| {
            let found = view.state.profile(id.as_str())?;
            let on = found.share_top_apps;
            let target = id.clone();
            let toggle = row_toggle(view, format!("shareTopApps:{id}"), on, false, move |on| {
                vec![Msg::Store(Action::UpdateProfile {
                    profile: target.clone(),
                    patch: ardia_state::ProfilePatch {
                        share_top_apps: Some(on),
                        ..ardia_state::ProfilePatch::default()
                    },
                })]
            });
            Some(extra_row(
                &p,
                format!("share-top-apps:{id}"),
                Some(profile_badge(&*view.host, found, 20.)),
                SharedString::from(found.name.clone()),
                Some(profile_circles::top_apps_description(&view.state, &id)),
                Some(toggle),
            ))
        })
        .collect()
}

pub fn head(view: &SettingsWindowView) -> Option<AnyElement> {
    let p = view.look.p;
    let profile = selected_profile(view)?;
    let found = view.state.profile(profile.as_str())?;
    let emit = view.emit.clone();
    let target = profile.clone();
    Some(
        div()
            .mt(px(BAR_TOP))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(HEAD_GAP))
            .child(
                div()
                    .id("profile-head-badge")
                    .debug_selector(|| "profile-head-badge".into())
                    .relative()
                    .cursor_pointer()
                    .tooltip(crate::primitives::controls::tooltip(
                        SharedString::new_static("Change Icon"),
                        &p,
                    ))
                    .child(measured(BADGE_ANCHOR.to_owned()))
                    .child(profile_badge(&*view.host, found, HEAD_BADGE))
                    .on_click(move |_, window, cx| {
                        send_all(
                            &emit,
                            icon_picker_msgs(&target, anchor_of(BADGE_ANCHOR)),
                            window,
                            cx,
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(HEAD_LINE_GAP))
                    .child(
                        div()
                            .text_size(px(crate::primitives::tokens::type_size::TITLE))
                            .line_height(px(HEAD_NAME_LINE))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.text)
                            .child(found.name.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(crate::primitives::tokens::type_size::SMALL))
                            .line_height(px(crate::primitives::tokens::line_height::SMALL))
                            .text_color(p.text_secondary)
                            .child(crate::settings::panes::profile_stats(&view.state, &profile)),
                    ),
            )
            .into_any_element(),
    )
}

#[derive(Clone, Debug, PartialEq)]
struct Press {
    id: ProfileId,
    start_x: f32,
    from: usize,
    to: usize,
    dragging: bool,
}

struct TrayMotion {
    slots: HashMap<ProfileId, (f32, f32)>,
    content_left: Rc<Cell<f32>>,
    view_width: Rc<Cell<f32>>,
    shown: Option<ProfileId>,
    thumb: SpringPair,
    offsets: HashMap<ProfileId, Tween>,
    press: Option<Press>,
    order_seen: Vec<ProfileId>,
    scroll: ScrollHandle,
    revealed: Option<ProfileId>,
    restored: bool,
}

impl TrayMotion {
    fn new() -> Self {
        TrayMotion {
            slots: HashMap::new(),
            content_left: Rc::new(Cell::new(0.0)),
            view_width: Rc::new(Cell::new(0.0)),
            shown: None,
            thumb: SpringPair::at((0.0, 0.0)),
            offsets: HashMap::new(),
            press: None,
            order_seen: Vec::new(),
            scroll: ScrollHandle::new(),
            revealed: None,
            restored: false,
        }
    }

    fn slot(&self, id: &ProfileId) -> Option<(f32, f32)> {
        self.slots.get(id).copied()
    }

    fn offset(&self, id: &ProfileId, now: Instant) -> f32 {
        self.offsets.get(id).map_or(0.0, |tween| tween.value(now))
    }

    fn settling(&self, now: Instant) -> bool {
        self.thumb.running(now, THUMB_SPRING)
            || self.offsets.values().any(|tween| tween.running(now))
    }

    fn sync(
        &mut self,
        ids: &[ProfileId],
        selected: Option<&ProfileId>,
        now: Instant,
        reduce: bool,
    ) {
        if self.order_seen != ids {
            self.order_seen = ids.to_vec();
            self.offsets.clear();
        }
        let Some(selected) = selected else {
            return;
        };
        let Some(to) = self.slot(selected) else {
            return;
        };
        match &self.shown {
            Some(shown) if shown == selected => {
                if !self.thumb.running(now, THUMB_SPRING) && self.thumb.to != to {
                    self.thumb.jump(to);
                }
            }
            Some(_) if !reduce => {
                let from = self.thumb.value(now, THUMB_SPRING);
                self.thumb.jump(from);
                self.thumb.retarget(to, now, THUMB_SPRING);
            }
            _ => self.thumb.jump(to),
        }
        self.shown = Some(selected.clone());
    }

    fn reveal(&mut self, selected: Option<&ProfileId>) {
        let width = self.view_width.get();
        let Some(selected) = selected else {
            return;
        };
        let Some((x, w)) = self.slot(selected) else {
            return;
        };
        if width <= 0.0 {
            return;
        }
        let current = -f32::from(self.scroll.offset().x);
        if !self.restored {
            self.restored = true;
            let saved = SAVED_STRIP_X.with(Cell::get);
            let next = reveal_target(saved, width, x, w);
            self.revealed = Some(selected.clone());
            self.set_scroll(next);
            return;
        }
        if self.revealed.as_ref() == Some(selected) {
            SAVED_STRIP_X.with(|saved| saved.set(current));
            return;
        }
        self.revealed = Some(selected.clone());
        let next = reveal_target(current, width, x, w);
        if (next - current).abs() > f32::EPSILON {
            self.set_scroll(next);
        }
    }

    fn set_scroll(&self, x: f32) {
        SAVED_STRIP_X.with(|saved| saved.set(x));
        self.scroll.set_offset(point(px(-x), px(0.)));
    }

    fn drag_to(&mut self, x: f32, now: Instant) -> bool {
        let Some(mut press) = self.press.clone() else {
            return false;
        };
        let dx = x - press.start_x;
        if !press.dragging {
            if dx.abs() <= DRAG_SLOP {
                return false;
            }
            press.dragging = true;
        }
        let ids = self.order_seen.clone();
        let (Some(slot), Some(first), Some(last)) = (
            self.slot(&press.id),
            ids.first().and_then(|id| self.slot(id)),
            ids.last().and_then(|id| self.slot(id)),
        ) else {
            self.press = Some(press);
            return true;
        };
        let shift = drag_shift(slot, first, last, dx);
        self.offsets.insert(press.id.clone(), Tween::at(shift));
        let center = slot.0 + slot.1 / 2.0 + shift;
        let to = ids
            .iter()
            .filter(|other| {
                **other != press.id
                    && self
                        .slot(other)
                        .is_some_and(|(sx, sw)| sx + sw / 2.0 < center)
            })
            .count();
        let moved = to != press.to;
        if moved {
            press.to = to;
            let gap = slot.1 + PILL_GAP;
            for (j, other) in ids.iter().enumerate() {
                if *other == press.id {
                    continue;
                }
                let target = make_way(press.from, to, j, gap);
                let tween = self
                    .offsets
                    .entry(other.clone())
                    .or_insert_with(|| Tween::at(0.0));
                tween.retarget(target, duration::BASE, Curve::Enter, now);
            }
        }
        self.press = Some(press);
        moved
    }

    fn settle_all(&mut self, now: Instant) {
        for tween in self.offsets.values_mut() {
            tween.retarget(0.0, duration::BASE, Curve::Enter, now);
        }
    }
}

pub fn reveal_target(scroll_x: f32, view_width: f32, slot_x: f32, slot_width: f32) -> f32 {
    let left = slot_x + TRAY_PAD;
    let right = left + slot_width + TRAY_PAD;
    if left - TRAY_PAD < scroll_x {
        (left - TRAY_PAD * 2.0).max(0.0)
    } else if right > scroll_x + view_width {
        right - view_width + TRAY_PAD
    } else {
        scroll_x
    }
}

pub fn drag_shift(slot: (f32, f32), first: (f32, f32), last: (f32, f32), dx: f32) -> f32 {
    let low = first.0 - slot.0;
    let high = last.0 + last.1 - slot.0 - slot.1;
    dx.min(high).max(low)
}

pub fn make_way(from: usize, to: usize, index: usize, gap: f32) -> f32 {
    if from < index && index <= to {
        -gap
    } else if to <= index && index < from {
        gap
    } else {
        0.0
    }
}

pub fn dropped_order(order: &[ProfileId], id: &ProfileId, to: usize) -> Vec<ProfileId> {
    let mut ids: Vec<ProfileId> = order.iter().filter(|other| *other != id).cloned().collect();
    ids.insert(to.min(ids.len()), id.clone());
    ids
}

#[derive(IntoElement)]
pub struct ProfileTray {
    profiles: Vec<Arc<Profile>>,
    selected: Option<ProfileId>,
    p: Palette,
    host: Arc<dyn UiHost>,
    emit: Emit,
}

pub fn profile_bar(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let profiles: Vec<Arc<Profile>> = view
        .state
        .profile_order
        .iter()
        .filter_map(|id| view.state.profile(id.as_str()).cloned())
        .collect();
    let tray = ProfileTray {
        profiles,
        selected: selected_profile(view),
        p,
        host: Arc::clone(&view.host),
        emit: view.emit.clone(),
    };
    let create = IconButton::new("profile-create", Icon::Plus, &p)
        .square(PILL_HEIGHT, PILL_HEIGHT / 2.)
        .glyph(PILL_PLUS_GLYPH)
        .tooltip("Create Profile", &p)
        .on_click({
            let create = view.emit.click(Msg::People(PeopleMsg::CreateProfile));
            move |event, window, cx| {
                ardia_telemetry::counts::count("settings_create_profile_asks");
                ardia_telemetry::counts::count("settings_create_profile_sheets");
                create(event, window, cx)
            }
        });
    div()
        .debug_selector(|| "setting:profiles.profiles".into())
        .child(
            div()
                .mt(px(BAR_TOP))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(tray)
                .child(
                    div()
                        .debug_selector(|| "profile-create".into())
                        .child(create),
                ),
        )
        .children(head(view))
        .into_any_element()
}

fn end_press(
    state: &Entity<TrayMotion>,
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    selected: Option<&ProfileId>,
    window: &mut Window,
    cx: &mut App,
) {
    let now = Instant::now();
    let (press, order) = state.update(cx, |motion, _| {
        (motion.press.take(), motion.order_seen.clone())
    });
    let Some(press) = press else {
        return;
    };
    if press.dragging {
        if press.from == press.to {
            state.update(cx, |motion, _| motion.settle_all(now));
        } else {
            host.dispatch(Action::ReorderProfiles {
                order: dropped_order(&order, &press.id, press.to),
            });
        }
    } else if selected != Some(&press.id) {
        ardia_telemetry::counts::count("settings_profile_picks");
        emit.send(
            Msg::Command(SharedString::from(format!("settings:profile:{}", press.id))),
            window,
            cx,
        );
    }
    window.refresh();
}

impl RenderOnce for ProfileTray {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = Instant::now();
        let reduce = cx.reduce_motion();
        let p = self.p;
        let ids: Vec<ProfileId> = self.profiles.iter().map(|found| found.id.clone()).collect();
        let selected = self.selected.clone();
        let state = window.use_keyed_state(TRAY_KEY, cx, |_, _| TrayMotion::new());
        let (content_left, view_width, scroll, thumb, offsets, press, settling, measured_all) =
            state.update(cx, |motion, _| {
                motion.sync(&ids, selected.as_ref(), now, reduce);
                motion.reveal(selected.as_ref());
                let thumb = selected
                    .as_ref()
                    .and_then(|id| motion.slot(id).map(|_| id))
                    .map(|id| {
                        let (x, w) = motion.thumb.value(now, THUMB_SPRING);
                        (x + motion.offset(id, now), w)
                    });
                let offsets: HashMap<ProfileId, f32> = ids
                    .iter()
                    .map(|id| (id.clone(), motion.offset(id, now)))
                    .collect();
                let measured_all = ids.iter().all(|id| motion.slot(id).is_some());
                (
                    Rc::clone(&motion.content_left),
                    Rc::clone(&motion.view_width),
                    motion.scroll.clone(),
                    thumb,
                    offsets,
                    motion.press.clone(),
                    motion.settling(now),
                    measured_all,
                )
            });
        if settling || !measured_all {
            window.request_animation_frame();
        }
        let lifted = press
            .as_ref()
            .filter(|press| press.dragging)
            .map(|press| press.id.clone());
        let dragging = lifted.is_some();
        let listener_state = state.clone();
        let listener_host = Arc::clone(&self.host);
        let listener_emit = self.emit.clone();
        let listener_selected = selected.clone();
        let tracker = canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let moving = listener_state.clone();
                let haptics = Arc::clone(&listener_host);
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                    if phase != DispatchPhase::Bubble {
                        return;
                    }
                    let now = Instant::now();
                    let x = crate::scale::points(event.position.x);
                    let (moved, was_dragging, is_dragging) = moving.update(cx, |motion, _| {
                        let was = motion.press.as_ref().is_some_and(|press| press.dragging);
                        let moved = motion.drag_to(x, now);
                        let is = motion.press.as_ref().is_some_and(|press| press.dragging);
                        (moved, was, is)
                    });
                    if moved || is_dragging || was_dragging {
                        window.refresh();
                    }
                    if moved && is_dragging {
                        haptics.haptic_alignment();
                    }
                });
                let ending = listener_state.clone();
                let host = Arc::clone(&listener_host);
                let emit = listener_emit.clone();
                let selected = listener_selected.clone();
                window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                    if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                        return;
                    }
                    end_press(&ending, &host, &emit, selected.as_ref(), window, cx);
                });
            },
        )
        .absolute()
        .size_full();
        let content_origin = Rc::clone(&content_left);
        let width_cell = Rc::clone(&view_width);
        let pills = self.profiles.iter().enumerate().map(|(index, found)| {
            let id = found.id.clone();
            let chosen = selected.as_ref() == Some(&id);
            let is_lifted = lifted.as_ref() == Some(&id);
            let offset = offsets.get(&id).copied().unwrap_or(0.0);
            let measured = state.clone();
            let content_left = Rc::clone(&content_left);
            let measure_id = id.clone();
            let anchor_key = pill_anchor_key(id.as_str());
            let press_state = state.clone();
            let hover = p.row_hover;
            let fill = if chosen {
                None
            } else if is_lifted {
                Some(p.panel)
            } else {
                None
            };
            let pill = div()
                .id(SharedString::from(format!("profile-pill:{id}")))
                .debug_selector({
                    let id = id.clone();
                    move || format!("profile-pill:{id}")
                })
                .relative()
                .left(px(offset))
                .flex_none()
                .h(px(PILL_HEIGHT))
                .rounded(px(PILL_HEIGHT / 2.))
                .when(chosen && thumb.is_none(), |this| this.bg(p.form_accent))
                .when_some(fill, |this, fill| this.bg(fill))
                .when(!chosen && !dragging, |this| {
                    this.hover(move |style| style.bg(hover))
                })
                .on_mouse_down(MouseButton::Left, {
                    let id = id.clone();
                    move |event, window, cx| {
                        let x = crate::scale::points(event.position.x);
                        press_state.update(cx, |motion, _| {
                            motion.press = Some(Press {
                                id: id.clone(),
                                start_x: x,
                                from: index,
                                to: index,
                                dragging: false,
                            });
                        });
                        window.refresh();
                    }
                })
                .on_mouse_down(
                    MouseButton::Right,
                    self.emit.on(Msg::Command(SharedString::from(format!(
                        "settings:profileMenu:{id}"
                    )))),
                )
                .child(
                    canvas(
                        move |bounds, window, cx| {
                            let left = crate::scale::points(bounds.origin.x) - content_left.get();
                            let width = crate::scale::points(bounds.size.width);
                            let slot = (left - offset, width);
                            let moved = measured.update(cx, |motion, _| {
                                motion.slots.insert(measure_id, slot) != Some(slot)
                            });
                            if moved {
                                window.request_animation_frame();
                            }
                            remember_anchor(anchor_key, bounds);
                        },
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .size_full(),
                )
                .child(
                    div()
                        .h_full()
                        .pl(px(4.))
                        .pr(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(profile_badge(&*self.host, found, PILL_BADGE))
                        .child(
                            div()
                                .max_w(px(PILL_NAME_MAX))
                                .truncate()
                                .text_size(px(13.))
                                .text_color(if chosen { p.on_accent } else { p.text })
                                .child(found.name.clone()),
                        ),
                );
            if is_lifted {
                deferred(pill).with_priority(1).into_any_element()
            } else {
                pill.into_any_element()
            }
        });
        div()
            .id("profile-tray")
            .flex_1()
            .min_w_0()
            .rounded(px((PILL_HEIGHT + TRAY_PAD * 2.) / 2.))
            .bg(p.group_fill)
            .border(px(crate::primitives::tokens::THICK_HAIRLINE))
            .border_color(p.group_border)
            .overflow_hidden()
            .child(tracker)
            .child(
                div()
                    .id("profile-tray-scroll")
                    .relative()
                    .w_full()
                    .overflow_x_scroll()
                    .track_scroll(&scroll)
                    .child(
                        canvas(
                            move |bounds, _, _| {
                                width_cell.set(crate::scale::points(bounds.size.width))
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(
                        div().relative().flex_none().p(px(TRAY_PAD)).child(
                            div()
                                .relative()
                                .flex()
                                .flex_row()
                                .gap(px(PILL_GAP))
                                .child(
                                    canvas(
                                        move |bounds, _, _| {
                                            content_origin
                                                .set(crate::scale::points(bounds.origin.x))
                                        },
                                        |_, _, _, _| {},
                                    )
                                    .absolute()
                                    .size_full(),
                                )
                                .when_some(thumb, |this, (x, width)| {
                                    this.child(
                                        div()
                                            .debug_selector(|| "profile-thumb".into())
                                            .absolute()
                                            .top_0()
                                            .left(px(x))
                                            .w(px(width))
                                            .h(px(PILL_HEIGHT))
                                            .rounded(px(PILL_HEIGHT / 2.))
                                            .bg(p.form_accent),
                                    )
                                })
                                .children(pills),
                        ),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neighbours_make_way_like_the_old_pan() {
        assert_eq!(make_way(0, 2, 1, 50.0), -50.0);
        assert_eq!(make_way(0, 2, 2, 50.0), -50.0);
        assert_eq!(make_way(0, 2, 3, 50.0), 0.0);
        assert_eq!(make_way(3, 1, 1, 50.0), 50.0);
        assert_eq!(make_way(3, 1, 2, 50.0), 50.0);
        assert_eq!(make_way(3, 1, 0, 50.0), 0.0);
    }

    #[test]
    fn a_drag_stays_inside_the_tray() {
        let first = (0.0, 80.0);
        let last = (164.0, 60.0);
        let slot = (82.0, 80.0);
        assert_eq!(drag_shift(slot, first, last, -500.0), -82.0);
        assert_eq!(drag_shift(slot, first, last, 500.0), 62.0);
        assert_eq!(drag_shift(slot, first, last, 10.0), 10.0);
    }

    #[test]
    fn dropping_inserts_at_the_new_index() {
        let ids: Vec<ProfileId> = ["a", "b", "c"].iter().map(|s| ProfileId::new(*s)).collect();
        let moved = dropped_order(&ids, &ids[0], 2);
        assert_eq!(
            moved.iter().map(|id| id.as_str()).collect::<Vec<_>>(),
            ["b", "c", "a"]
        );
        let moved = dropped_order(&ids, &ids[2], 0);
        assert_eq!(
            moved.iter().map(|id| id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }

    #[test]
    fn revealing_scrolls_the_selected_pill_into_view() {
        assert_eq!(reveal_target(0.0, 300.0, 100.0, 80.0), 0.0);
        assert_eq!(reveal_target(0.0, 300.0, 280.0, 80.0), 66.0);
        assert_eq!(reveal_target(200.0, 300.0, 50.0, 80.0), 48.0);
    }

    #[test]
    fn icon_titles_read_like_the_old_row() {
        assert_eq!(icon_title(None), "None");
        assert_eq!(icon_title(Some("symbol:house.fill")), "Home");
        assert_eq!(icon_title(Some("🐱")), "🐱");
    }
}
