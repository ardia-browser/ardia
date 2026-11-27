use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::TabId;
use ardia_state::tabs::Tab;
use ardia_theme::layout::panel;
use ardia_theme::tokens::{TypeSize, radius, space};
use gpui::{
    AnyElement, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton, ObjectFit,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, StyledImage, div, img,
    prelude::*,
};

use crate::host::UiHost;
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::popovers::panel::{header, pill, pill_with, surface};
use crate::primitives::controls::{BadgeTone, Checkbox, Segmented, badge};
use crate::primitives::favicon::render_favicon;
use crate::scale::px;
use crate::window::chrome::Chrome;

pub const WIDTH: f32 = 600.0;
pub const THUMB_WIDTH: f64 = 320.0;
pub const ASPECT: f32 = 10.0 / 16.0;
pub const SELECTED_RING: f32 = 2.0;
pub const LIST_MAX_HEIGHT: f32 = 360.0;
pub const SHARE_BAR_HEIGHT: f32 = 38.0;
pub const SHARE_BAR_SLIDE_MS: f32 = 150.0;
pub const TAB_PREFIX: &str = "tab:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Tab,
    Window,
    Screen,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisplaySource {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    pub app: String,
    pub pid: Option<i32>,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioOffer {
    pub tab: bool,
    pub screen: bool,
    pub window: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayRequest {
    pub id: String,
    pub origin: String,
    pub frame_origin: String,
    pub audio: Option<AudioOffer>,
    pub controller: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabShare {
    pub captured: TabId,
    pub origin: String,
    pub dismissed: HashSet<TabId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Segment {
    Tabs,
    Windows,
    Screen,
}

impl Segment {
    pub const ALL: [Segment; 3] = [Segment::Tabs, Segment::Windows, Segment::Screen];

    pub fn title(self) -> &'static str {
        match self {
            Segment::Tabs => "Tabs",
            Segment::Windows => "Windows",
            Segment::Screen => "Entire Screen",
        }
    }
}

#[derive(Clone, Debug)]
struct PickerState {
    request: String,
    segment: Segment,
    picked: HashMap<Segment, String>,
    audio: HashMap<SourceKind, bool>,
    order: Vec<(String, SourceKind)>,
    columns: usize,
}

impl PickerState {
    fn fresh(request: &str, tab: &TabId) -> PickerState {
        PickerState {
            request: request.to_owned(),
            segment: Segment::Tabs,
            picked: HashMap::from([(Segment::Tabs, format!("{TAB_PREFIX}{tab}"))]),
            audio: HashMap::from([
                (SourceKind::Tab, true),
                (SourceKind::Screen, false),
                (SourceKind::Window, false),
            ]),
            order: Vec::new(),
            columns: 3,
        }
    }
}

thread_local! {
    static PICKERS: RefCell<HashMap<TabId, PickerState>> = RefCell::new(HashMap::new());
}

fn with_picker<R>(tab: &TabId, request: &str, f: impl FnOnce(&mut PickerState) -> R) -> R {
    PICKERS.with(|pickers| {
        let mut pickers = pickers.borrow_mut();
        let state = pickers
            .entry(tab.clone())
            .or_insert_with(|| PickerState::fresh(request, tab));
        if state.request != request {
            *state = PickerState::fresh(request, tab);
        }
        f(state)
    })
}

pub fn audio_label(kind: SourceKind, offer: &AudioOffer) -> &'static str {
    match kind {
        SourceKind::Tab => "Also share tab audio",
        SourceKind::Window if offer.window.as_deref() == Some("application") => {
            "Also share application audio"
        }
        _ => "Also share system audio",
    }
}

pub fn audio_offered(kind: Option<SourceKind>, offer: Option<&AudioOffer>) -> bool {
    let Some(offer) = offer else {
        return false;
    };
    match kind {
        Some(SourceKind::Tab) => offer.tab,
        Some(SourceKind::Screen) => offer.screen,
        Some(SourceKind::Window) => offer.window.is_some(),
        None => false,
    }
}

pub fn columns_for(width: f32) -> usize {
    if width < 560.0 { 2 } else { 3 }
}

pub fn card_width(width: f32, columns: usize) -> f32 {
    ((width - 2.0 * panel::ROW_INSET - (columns as f32 - 1.0) * space::M) / columns as f32).floor()
}

fn display_host(origin: &str) -> String {
    let host = ardia_state::omnibox::url::host_of(origin);
    if host.is_empty() {
        origin.to_owned()
    } else {
        host
    }
}

pub fn receiver(request: &DisplayRequest) -> String {
    let frame = display_host(&request.frame_origin);
    let page = display_host(&request.origin);
    if !frame.is_empty() && frame != page {
        format!("{frame}, a frame on this page,")
    } else {
        page
    }
}

pub fn subtitle(request: &DisplayRequest, kind: Option<SourceKind>, audio_on: bool) -> String {
    let who = receiver(request);
    if audio_on {
        return format!("{who} will see and hear what you choose.");
    }
    let only_tabs = request
        .audio
        .as_ref()
        .is_some_and(|a| !a.screen && a.window.is_none());
    if only_tabs && kind != Some(SourceKind::Tab) {
        format!("{who} will see what you choose. Only tabs share their audio.")
    } else {
        format!("{who} will see what you choose.")
    }
}

pub fn shareable_tabs(c: &Chrome, tab: &TabId) -> Vec<Arc<Tab>> {
    let Some(asking) = c.state.tab(tab.as_str()) else {
        return Vec::new();
    };
    let engine = |t: &Tab| c.state.engine_profile(&t.profile_id);
    let profile = engine(asking);
    let mut tabs: Vec<Arc<Tab>> = c
        .state
        .tabs
        .values()
        .filter(|t| {
            t.page.has_page()
                && engine(t) == profile
                && (t.url.starts_with("http:")
                    || t.url.starts_with("https:")
                    || t.url.starts_with("file:"))
        })
        .cloned()
        .collect();
    tabs.sort_by(|a, b| {
        (b.id == *tab)
            .cmp(&(a.id == *tab))
            .then(b.last_active_at.cmp(&a.last_active_at))
    });
    tabs
}

struct Card {
    id: String,
    title: String,
    tab: Option<Arc<Tab>>,
    badge: Option<&'static str>,
    kind: SourceKind,
    pid: Option<i32>,
}

fn card_glyph(c: &Chrome, card: &Card, size: f32, frame: f32) -> AnyElement {
    let app_icon = card.pid.and_then(|pid| c.host.app_icon_for_pid(pid, size));
    match (&card.tab, card.kind, app_icon) {
        (Some(tab), _, _) => render_favicon(&c.favicon(tab), size, c.p),
        (None, SourceKind::Window, Some(icon)) => img(icon)
            .size(px(if size > 20.0 { 28.0 } else { 16.0 }))
            .object_fit(ObjectFit::Contain)
            .into_any_element(),
        (None, SourceKind::Screen, _) => symbol(
            c.host.as_ref(),
            "display",
            size * 0.7,
            frame,
            SymbolWeight::Regular,
            c.p.text_secondary,
        ),
        (None, _, _) => symbol(
            c.host.as_ref(),
            "macwindow",
            size * 0.7,
            frame,
            SymbolWeight::Regular,
            c.p.text_secondary,
        ),
    }
}

fn preview_tokens(c: &Chrome) -> (Hsla, Hsla, Hsla) {
    let shade = |a: f32| {
        if c.p.dark {
            Hsla::white().opacity(a)
        } else {
            Hsla::black().opacity(a)
        }
    };
    if c.p.dark {
        (shade(0.15), shade(0.05), shade(0.14))
    } else {
        (shade(0.12), shade(0.03), shade(0.08))
    }
}

#[allow(clippy::too_many_arguments)]
fn source_card(
    c: &Chrome,
    tab: &TabId,
    request: &str,
    card: Card,
    width: f32,
    thumb: Option<Arc<gpui::Image>>,
    selected: bool,
) -> AnyElement {
    let ring = if selected { SELECTED_RING } else { 0.0 };
    let preview_width = width - 2.0 * space::M;
    let preview_height = preview_width * ASPECT;
    let (border, fill, picked_fill) = preview_tokens(c);
    let hover = c.p.row_hover;
    let select_tab = tab.clone();
    let share_tab = tab.clone();
    let request_select = request.to_owned();
    let id = card.id.clone();
    let share_id = card.id.clone();
    let share_host = Arc::clone(c.host);
    let kind = card.kind;
    div()
        .id(SharedString::from(format!("share-card:{}", card.id)))
        .debug_selector({
            let id = card.id.clone();
            move || format!("share-card:{id}")
        })
        .w(px(width))
        .p(px(space::M - ring))
        .rounded(px(radius::TILE))
        .border(px(ring))
        .border_color(c.p.form_accent)
        .when(selected, |this| this.bg(picked_fill))
        .when(!selected, |this| this.hover(move |s| s.bg(hover)))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |event, window, _| {
            if event.click_count() >= 2 {
                share(
                    &share_host,
                    &share_tab,
                    &request_select,
                    Some((share_id.clone(), kind)),
                );
            } else {
                with_picker(&select_tab, &request_select, |state| {
                    let segment = state.segment;
                    state.picked.insert(segment, id.clone());
                });
            }
            window.refresh();
        })
        .child(
            div()
                .w(px(preview_width))
                .h(px(preview_height))
                .rounded(px(radius::CONTROL))
                .border(px(0.5))
                .border_color(border)
                .bg(fill)
                .overflow_hidden()
                .flex()
                .items_center()
                .justify_center()
                .map(|this| match thumb {
                    Some(image) => this.child(
                        img(image)
                            .w(px(preview_width))
                            .h(px(preview_height))
                            .object_fit(ObjectFit::Cover),
                    ),
                    None => this.child(card_glyph(c, &card, 32.0, 28.0)),
                }),
        )
        .child(
            div()
                .mt(px(space::S))
                .flex()
                .items_center()
                .gap(px(space::S))
                .child(card_glyph(c, &card, 16.0, 16.0))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(TypeSize::Small.points()))
                        .child(SharedString::from(card.title)),
                )
                .children(card.badge.map(|text| {
                    badge(text, c.p)
                        .tone(BadgeTone::Accent)
                        .small()
                        .into_any_element()
                })),
        )
        .into_any_element()
}

fn share(host: &Arc<dyn UiHost>, tab: &TabId, request: &str, picked: Option<(String, SourceKind)>) {
    let Some((id, kind)) = picked else {
        return;
    };
    let request_info = host.display_request(tab);
    ardia_telemetry::counts::count(match kind {
        SourceKind::Tab => "shares_picked_tab",
        SourceKind::Window => "shares_picked_window",
        SourceKind::Screen => "shares_picked_screen",
    });
    if request_info.as_ref().is_some_and(|r| r.controller) {
        ardia_telemetry::counts::count("shares_with_capture_controller");
    }
    let offer = request_info.and_then(|r| r.audio);
    let audio = audio_offered(Some(kind), offer.as_ref())
        && with_picker(tab, request, |state| {
            state.audio.get(&kind).copied().unwrap_or(false)
        });
    match id.strip_prefix(TAB_PREFIX) {
        Some(shared) => host.share_tab_with(tab.clone(), TabId::from(shared), audio),
        None => host.answer_display_request(tab.clone(), Some(id), audio),
    }
}

pub fn picker_key(host: &Arc<dyn UiHost>, tab: &TabId, key: &str) -> bool {
    let Some(request) = host.display_request(tab) else {
        return false;
    };
    let (order, columns, selected) = with_picker(tab, &request.id, |state| {
        (
            state.order.clone(),
            state.columns.max(1),
            state.picked.get(&state.segment).cloned(),
        )
    });
    let at = selected
        .as_ref()
        .and_then(|id| order.iter().position(|(card, _)| card == id));
    let step = |delta: isize| -> Option<usize> {
        if order.is_empty() {
            return None;
        }
        Some(match at {
            None => 0,
            Some(at) => (at as isize + delta).clamp(0, order.len() as isize - 1) as usize,
        })
    };
    let next = match key {
        "escape" => {
            host.answer_display_request(tab.clone(), None, false);
            return true;
        }
        "enter" => {
            share(host, tab, &request.id, at.map(|i| order[i].clone()));
            return true;
        }
        "left" => step(-1),
        "right" => step(1),
        "up" => step(-(columns as isize)),
        "down" => step(columns as isize),
        _ => return false,
    };
    if let Some(next) = next {
        let id = order[next].0.clone();
        with_picker(tab, &request.id, |state| {
            let segment = state.segment;
            state.picked.insert(segment, id);
        });
    }
    true
}

thread_local! {
    static MISSING_NOTED: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

pub fn share_picker(c: &Chrome, tab: &TabId) -> Option<AnyElement> {
    let request = c.host.display_request(tab)?;
    let p = c.p;
    let page = c.layout.page();
    let width = WIDTH.min(page.w - 24.0).max(0.0);
    let columns = columns_for(width);
    let card_w = card_width(width, columns);
    let (segment, picked, audio_state) = with_picker(tab, &request.id, |s| {
        (s.segment, s.picked.clone(), s.audio.clone())
    });
    let allowed = segment == Segment::Tabs || c.host.screen_recording_allowed();
    if !allowed
        && MISSING_NOTED
            .with(|noted| noted.replace(Some(request.id.clone())))
            .as_ref()
            != Some(&request.id)
    {
        ardia_telemetry::counts::count("share_picker_screen_recording_missing");
    }
    let sources = if allowed && segment != Segment::Tabs {
        c.host.display_sources()
    } else {
        Vec::new()
    };
    let cards: Vec<Card> = match segment {
        Segment::Tabs => shareable_tabs(c, tab)
            .into_iter()
            .map(|t| Card {
                id: format!("{TAB_PREFIX}{}", t.id),
                title: if t.title.is_empty() {
                    t.url.clone()
                } else {
                    t.display_title()
                },
                badge: (t.id == *tab).then_some("This Tab"),
                tab: Some(t),
                kind: SourceKind::Tab,
                pid: None,
            })
            .collect(),
        Segment::Screen => sources
            .iter()
            .filter(|s| s.kind == SourceKind::Screen)
            .map(|s| Card {
                id: s.id.clone(),
                title: s.name.clone(),
                tab: None,
                badge: None,
                kind: SourceKind::Screen,
                pid: None,
            })
            .collect(),
        Segment::Windows => sources
            .iter()
            .filter(|s| s.kind == SourceKind::Window)
            .map(|s| Card {
                id: s.id.clone(),
                title: if s.name.is_empty() {
                    if s.app.is_empty() {
                        "Window".into()
                    } else {
                        s.app.clone()
                    }
                } else {
                    s.name.clone()
                },
                tab: None,
                badge: None,
                kind: SourceKind::Window,
                pid: s.pid,
            })
            .collect(),
    };
    let needs_access = segment != Segment::Tabs && !allowed;
    let mut selected = picked.get(&segment).cloned();
    if cards.len() == 1 && !needs_access && selected.as_deref() != Some(cards[0].id.as_str()) {
        selected = Some(cards[0].id.clone());
        let lone = cards[0].id.clone();
        with_picker(tab, &request.id, |s| {
            s.picked.insert(segment, lone);
        });
    }
    let selected_kind = cards
        .iter()
        .find(|card| Some(&card.id) == selected.as_ref())
        .map(|card| card.kind);
    let audio_on = selected_kind.is_some_and(|k| {
        audio_offered(Some(k), request.audio.as_ref())
            && audio_state.get(&k).copied().unwrap_or(false)
    });
    let thumbs = if segment != Segment::Tabs && allowed {
        let ids: Vec<String> = cards.iter().map(|card| card.id.clone()).collect();
        c.host.display_thumbnails(&ids, THUMB_WIDTH)
    } else {
        HashMap::new()
    };
    let cancel_host = Arc::clone(c.host);
    let cancel_tab = tab.clone();
    let share_host = Arc::clone(c.host);
    let share_tab = tab.clone();
    let share_request = request.id.clone();
    let share_pick = selected.clone().zip(selected_kind);
    let segment_tab = tab.clone();
    let segment_request = request.id.clone();
    let order: Vec<(String, SourceKind)> = cards
        .iter()
        .map(|card| (card.id.clone(), card.kind))
        .collect();
    with_picker(tab, &request.id, |state| {
        state.order = order;
        state.columns = columns;
    });
    let body = if needs_access {
        let host = Arc::clone(c.host);
        div()
            .px(px(panel::INSET))
            .pt(px(space::XS))
            .flex()
            .flex_col()
            .gap(px(space::XS))
            .child(
                div()
                    .text_size(px(TypeSize::Small.points()))
                    .text_color(p.text_secondary)
                    .child("To share a window or your entire screen, turn on Ardia in System Settings › Privacy & Security › Screen Recording, then quit and reopen Ardia."),
            )
            .child(
                div()
                    .id("share-open-settings")
                    .text_size(px(TypeSize::Small.points()))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.accent)
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .on_click(move |_, _, _| {
                        ardia_telemetry::counts::count("share_picker_screen_recording_asked");
                        host.request_screen_recording()
                    })
                    .child("Open System Settings"),
            )
            .into_any_element()
    } else if cards.is_empty() {
        div()
            .px(px(panel::INSET))
            .pt(px(space::XS))
            .text_size(px(TypeSize::Small.points()))
            .text_color(p.text_secondary)
            .child(if segment == Segment::Tabs {
                "No other tabs can be shared right now."
            } else {
                "Nothing can be shared right now."
            })
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_wrap()
            .gap(px(space::M))
            .children(cards.into_iter().map(|card| {
                let thumb = match &card.tab {
                    Some(shown) => c.host.tab_preview(&shown.id),
                    None => thumbs.get(&card.id).cloned(),
                };
                let is = Some(&card.id) == selected.as_ref();
                source_card(c, tab, &request.id, card, card_w, thumb, is)
            }))
            .into_any_element()
    };
    let checkbox = selected_kind
        .filter(|k| audio_offered(Some(*k), request.audio.as_ref()))
        .map(|kind| {
            let tab = tab.clone();
            let id = request.id.clone();
            Checkbox::new(
                "share-audio",
                audio_state.get(&kind).copied().unwrap_or(false),
                audio_label(kind, request.audio.as_ref().expect("offered")),
                p,
            )
            .on_toggle(move |on, window, _| {
                with_picker(&tab, &id, |s| {
                    s.audio.insert(kind, on);
                });
                window.refresh();
            })
            .into_any_element()
        });
    let card = surface("share-picker", width, p)
        .debug_selector(|| "share-picker".into())
        .pb(px(panel::INSET))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(header(
            symbol(
                c.host.as_ref(),
                "rectangle.inset.filled.and.person.filled",
                13.0,
                panel::ICON_SLOT,
                SymbolWeight::Regular,
                p.icon,
            ),
            "Share your screen",
            None,
            p,
        ))
        .child(
            div()
                .px(px(panel::INSET))
                .mt(px(-panel::HEADER_GAP))
                .mb(px(space::XS))
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child(SharedString::from(subtitle(
                    &request,
                    selected_kind,
                    audio_on,
                ))),
        )
        .child(
            div()
                .px(px(panel::INSET))
                .mt(px(space::XS))
                .mb(px(space::M))
                .child(
                    Segment::ALL
                        .iter()
                        .fold(
                            Segmented::new(
                                "share-segments",
                                Segment::ALL.iter().position(|s| *s == segment).unwrap_or(0),
                                p,
                            ),
                            |seg, s| seg.option(s.title(), None),
                        )
                        .fill(true)
                        .on_select(move |index, window, _| {
                            with_picker(&segment_tab, &segment_request, |s| {
                                s.segment = Segment::ALL[index.min(2)]
                            });
                            window.refresh();
                        }),
                ),
        )
        .child(
            div()
                .id("share-sources")
                .max_h(px(LIST_MAX_HEIGHT))
                .overflow_y_scroll()
                .px(px(panel::ROW_INSET))
                .child(body),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(space::M))
                .px(px(panel::INSET))
                .mt(px(space::L))
                .children(checkbox)
                .child(div().flex_1())
                .child(div().debug_selector(|| "share-cancel".into()).child(pill(
                    "share-cancel",
                    "Cancel",
                    p,
                    move |_, _, _| {
                        cancel_host.answer_display_request(cancel_tab.clone(), None, false)
                    },
                )))
                .child(
                    div()
                        .debug_selector(|| "share-confirm".into())
                        .when(share_pick.is_none(), |this| this.opacity(0.4))
                        .child(pill_with(
                            true,
                            "share-confirm",
                            "Share",
                            p,
                            move |_, _, _| {
                                share(&share_host, &share_tab, &share_request, share_pick.clone())
                            },
                        )),
                ),
        );
    Some(
        div()
            .absolute()
            .left(px(page.x + (page.w - width) / 2.0))
            .top(px(page.y + panel::POPOVER_MARGIN))
            .child(crate::primitives::appear::rise(
                gpui::ElementId::Name(format!("share-picker-in:{}", request.id).into()),
                card,
                crate::primitives::appear::Rise::popover(
                    crate::primitives::appear::OriginX::Left,
                    false,
                ),
            ))
            .into_any_element(),
    )
}

thread_local! {
    static BARS: RefCell<HashMap<String, (bool, std::time::Instant)>> = RefCell::new(HashMap::new());
}

pub fn bar_height(window: &str, shown: bool, now: std::time::Instant) -> (f32, bool) {
    BARS.with(|bars| {
        let mut bars = bars.borrow_mut();
        let entry = bars
            .entry(window.to_owned())
            .or_insert((shown, now - std::time::Duration::from_secs(1)));
        if entry.0 != shown {
            *entry = (shown, now);
        }
        let t = (now.saturating_duration_since(entry.1).as_secs_f32() * 1000.0
            / SHARE_BAR_SLIDE_MS)
            .clamp(0.0, 1.0);
        let eased = ardia_theme::motion::ease_out_cubic(f64::from(t)) as f32;
        let progress = if shown { eased } else { 1.0 - eased };
        (SHARE_BAR_HEIGHT * progress, t < 1.0)
    })
}

thread_local! {
    static LAST_BAR: RefCell<HashMap<String, (TabId, TabId, TabShare)>> = RefCell::new(HashMap::new());
}

pub fn share_bar(c: &Chrome, tab: &TabId) -> Option<AnyElement> {
    let window = c.window.id.as_str().to_owned();
    let (capturer, share) = match c.host.share_bar(tab) {
        Some(found) => {
            LAST_BAR.with(|last| {
                last.borrow_mut()
                    .insert(window, (tab.clone(), found.0.clone(), found.1.clone()))
            });
            found
        }
        None => LAST_BAR.with(|last| {
            last.borrow()
                .get(&window)
                .filter(|(shown, _, _)| shown == tab)
                .map(|(_, capturer, share)| (capturer.clone(), share.clone()))
        })?,
    };
    let p = c.p;
    let is_shared = share.captured == *tab;
    let host = display_host(&share.origin);
    let border = if p.dark {
        Hsla::white().opacity(0.1)
    } else {
        Hsla::black().opacity(0.08)
    };
    let action = {
        let host_ref = Arc::clone(c.host);
        let capturer = capturer.clone();
        let tab = tab.clone();
        if is_shared {
            pill("share-stop", "Stop Sharing", p, move |_, _, _| {
                host_ref.stop_sharing(capturer.clone())
            })
        } else {
            pill_with(
                true,
                "share-instead",
                "Share This Tab Instead",
                p,
                move |_, _, _| host_ref.share_instead(capturer.clone(), tab.clone()),
            )
        }
    };
    let dismiss_host = Arc::clone(c.host);
    let dismiss_tab = tab.clone();
    Some(
        div()
            .debug_selector(|| "share-bar".into())
            .h(px(SHARE_BAR_HEIGHT))
            .flex()
            .items_center()
            .gap(px(space::ML))
            .pl(px(space::L))
            .pr(px(space::M))
            .border_b(px(0.5))
            .border_color(border)
            .child(
                div()
                    .flex_none()
                    .size(px(20.))
                    .rounded_full()
                    .bg(p.destructive)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(symbol(
                        c.host.as_ref(),
                        "rectangle.inset.filled",
                        9.0,
                        14.0,
                        SymbolWeight::Bold,
                        gpui::white(),
                    )),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(TypeSize::Body.points()))
                    .text_color(p.text_secondary)
                    .child("Sharing ")
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.text)
                            .child(if is_shared { "this tab" } else { "another tab" }),
                    )
                    .child(SharedString::from(format!(" with {host}"))),
            )
            .child(action)
            .child(pill("share-dismiss", "Dismiss", p, move |_, _, _| {
                dismiss_host.dismiss_share_bar(capturer.clone(), dismiss_tab.clone())
            }))
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(audio: Option<AudioOffer>) -> DisplayRequest {
        DisplayRequest {
            id: "r".into(),
            origin: "https://meet.example".into(),
            frame_origin: "https://meet.example".into(),
            audio,
            controller: false,
        }
    }

    #[test]
    fn the_picker_lays_out_like_the_old_one() {
        assert_eq!(columns_for(600.0), 3);
        assert_eq!(columns_for(500.0), 2);
        assert_eq!(
            card_width(600.0, 3),
            ((600.0 - 12.0 - 16.0) / 3.0f32).floor()
        );
    }

    #[test]
    fn subtitles_say_who_sees_and_hears() {
        let tab_only = Some(AudioOffer {
            tab: true,
            screen: false,
            window: None,
        });
        assert_eq!(
            subtitle(&request(None), Some(SourceKind::Tab), false),
            "meet.example will see what you choose."
        );
        assert_eq!(
            subtitle(&request(tab_only.clone()), Some(SourceKind::Tab), true),
            "meet.example will see and hear what you choose."
        );
        assert_eq!(
            subtitle(&request(tab_only), Some(SourceKind::Screen), false),
            "meet.example will see what you choose. Only tabs share their audio."
        );
        let mut framed = request(None);
        framed.frame_origin = "https://widget.example".into();
        assert_eq!(receiver(&framed), "widget.example, a frame on this page,");
    }

    #[test]
    fn audio_labels_match_the_source() {
        let offer = AudioOffer {
            tab: true,
            screen: true,
            window: Some("application".into()),
        };
        assert_eq!(audio_label(SourceKind::Tab, &offer), "Also share tab audio");
        assert_eq!(
            audio_label(SourceKind::Window, &offer),
            "Also share application audio"
        );
        assert_eq!(
            audio_label(SourceKind::Screen, &offer),
            "Also share system audio"
        );
        assert!(audio_offered(Some(SourceKind::Window), Some(&offer)));
        assert!(!audio_offered(None, Some(&offer)));
    }
}
