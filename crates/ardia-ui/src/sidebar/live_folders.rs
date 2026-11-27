pub mod rows;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use ardia_state::settings::LiveFolderIcon;
use ardia_state::tabs::Tab;
use ardia_state::{Action, GroupId, TabId};
use ardia_theme::RgbaColor;
use ardia_theme::layout::sidebar;
use ardia_theme::motion::{CubicBezier, ease_out_cubic};
use gpui::{
    Animation, AnimationExt, AnyElement, App, FontWeight, Global, Hsla, IntoElement, MouseButton,
    ParentElement, Pixels, Point, RenderOnce, SharedString, Styled, Window, div, prelude::*,
};

use crate::icon_picker::symbols::SymbolWeight;
use crate::msg::Msg;
use crate::primitives::controls::{IconButton, badge};
use crate::primitives::fade_label::fade_label;
use crate::primitives::favicon::{favicon_of, render_favicon};
use crate::primitives::icons::{Icon, symbol_icon};
use crate::primitives::theme_bridge::hsla;
use crate::scale::px;
use crate::sidebar::group_list::motion::group_ui;
use crate::sidebar::group_list::{
    FoldMember, GROUP_INNER_RADIUS, GroupBlock, TITLE_GAP, TITLE_TRAILING, folder_or_icon,
    group_surface, group_title_color,
};
use crate::sidebar::row_look;
use crate::sidebar::tab_row::{row_id, tab_row};
use crate::window::chrome::Chrome;
use rows::{
    Completion, Folder, FolderData, Item, Note, PrBadge, Row, active_live_tab, entry_anchor,
    folder_note, folder_rows, item_tab, keep_key, place_live, pr_badge, service_icon,
    stack_tab_open, status_text, strays, updating,
};

pub const PAD: f32 = 2.0;
pub const BOX_PAD: f32 = PAD + sidebar::GROUP_BORDER;
pub const SECTION_HEIGHT: f32 = 22.0;
pub const NOTE_HEIGHT: f32 = 28.0;
pub const MORE_HEIGHT: f32 = 26.0;
pub const STACK_HEIGHT: f32 = 26.0;
pub const STACK_LIFT: f32 = 1.5;
pub const TEXT_GAP: f32 = 5.0;
pub const COMPLETED_HEIGHT: f32 = 24.0;
pub const STACK_INDENT: f32 = 10.0;
pub const UNREAD_DOT_LEFT: f32 = 2.0;
pub const SLOT: f32 = 22.0;
pub const SPINNER_PERIOD_MS: u64 = 900;
pub const LIVE_FOLD_MS: u64 = 400;
pub const ICON_POP_MS: u64 = 250;
pub const CAPTION_LINE: f32 = 14.0;
pub const CARD_PAD: f32 = 12.0;

#[derive(Clone, Debug, PartialEq)]
pub enum LiveCommand {
    ToggleFolder {
        folder: String,
        collapsed: bool,
    },
    Refresh {
        folder: String,
    },
    FixError {
        folder: String,
    },
    ShowAll {
        folder: String,
        section: rows::Section,
    },
    ToggleStack {
        stack: String,
    },
    HideStack {
        folder: String,
        stack: String,
    },
    HideItems {
        folder: String,
        items: Vec<String>,
    },
    OpenItem {
        folder: String,
        item: String,
        background: bool,
    },
    FolderMenu {
        folder: String,
        at: Point<Pixels>,
    },
    ItemMenu {
        folder: String,
        item: String,
        tab: Option<TabId>,
        at: Point<Pixels>,
    },
}

pub type LiveSink = Rc<dyn Fn(LiveCommand, &mut Window, &mut App)>;

type ClickFn = Box<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveColors {
    pub pending: Hsla,
    pub merged: Hsla,
    pub draft: Hsla,
    pub conflict: Hsla,
    pub badge_ring: Hsla,
    pub success: Hsla,
    pub failure: Hsla,
}

pub fn live_colors(c: &Chrome) -> LiveColors {
    let dark = c.look.dark;
    let pick = |d: u32, l: u32| hsla(RgbaColor::hexa(if dark { d } else { l }));
    LiveColors {
        pending: pick(0xD29922FF, 0x9A6700FF),
        merged: pick(0xA371F7FF, 0x8250DFFF),
        draft: pick(0x8B949EFF, 0x6E7781FF),
        conflict: pick(0xDB6D28FF, 0xBC4C00FF),
        badge_ring: pick(0x00000059, 0xFFFFFFCC),
        success: c.p.success,
        failure: c.p.destructive,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glyph {
    pub symbol: &'static str,
    pub fallback: Icon,
}

pub const fn sf(symbol: &'static str, fallback: Icon) -> Glyph {
    Glyph { symbol, fallback }
}

pub fn completion_glyph(state: Completion, colors: &LiveColors) -> (Glyph, Hsla) {
    match state {
        Completion::Merged => (
            sf("checkmark.circle.fill", Icon::CheckCircleFill),
            colors.merged,
        ),
        Completion::Reviewed => (
            sf("checkmark.circle.fill", Icon::CheckCircleFill),
            colors.success,
        ),
        Completion::Closed => (sf("xmark.circle.fill", Icon::XMark), colors.draft),
    }
}

pub fn badge_look(badge: PrBadge, colors: &LiveColors) -> (Option<Glyph>, Hsla) {
    match badge {
        PrBadge::Conflict => (
            Some(sf("exclamationmark.triangle.fill", Icon::WarningFill)),
            colors.conflict,
        ),
        PrBadge::Failing => (Some(sf("xmark.circle.fill", Icon::XMark)), colors.failure),
        PrBadge::ChangesRequested => (
            Some(sf("arrow.uturn.backward.circle.fill", Icon::Undo)),
            colors.failure,
        ),
        PrBadge::Pending => (None, colors.pending),
        PrBadge::Approved => (
            Some(sf("checkmark.circle.fill", Icon::CheckCircleFill)),
            colors.success,
        ),
        PrBadge::Passed => (Some(sf("checkmark", Icon::Check)), colors.success),
    }
}

pub fn glyph(g: Glyph, side: f32, box_side: f32, color: Hsla, weight: SymbolWeight) -> AnyElement {
    div()
        .flex_none()
        .size(px(box_side))
        .flex()
        .items_center()
        .justify_center()
        .child(symbol_icon(g.symbol, g.fallback, side, color).weight(weight))
        .into_any_element()
}

pub const REFRESH_ARROW_RING_OFFSET: (f32, f32) = (-0.25, 1.3);
pub const SPINNER_BOX: f32 = 14.0;
pub const SPINNER_GLYPH: f32 = 10.0;

pub fn refresh_spinner(g: Glyph, weight: SymbolWeight, color: Hsla) -> AnyElement {
    div()
        .flex_none()
        .size(px(SPINNER_BOX))
        .flex()
        .items_center()
        .justify_center()
        .child(
            symbol_icon(g.symbol, g.fallback, SPINNER_GLYPH, color)
                .weight(weight)
                .spinning(Duration::from_millis(SPINNER_PERIOD_MS)),
        )
        .into_any_element()
}

pub fn refresh_arrow_spinner(color: Hsla) -> AnyElement {
    let (dx, dy) = REFRESH_ARROW_RING_OFFSET;
    div()
        .flex_none()
        .size(px(SPINNER_BOX))
        .relative()
        .left(px(dx))
        .top(px(dy))
        .child(
            div()
                .absolute()
                .left(px(-dx))
                .top(px(-dy))
                .size(px(SPINNER_BOX))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    symbol_icon("arrow.clockwise", Icon::Reload, SPINNER_GLYPH, color)
                        .weight(SymbolWeight::Semibold),
                ),
        )
        .with_animation(
            "live-refresh-spin",
            Animation::new(Duration::from_millis(SPINNER_PERIOD_MS)).repeat(),
            |this, t| this.rotate(gpui::radians(t * std::f32::consts::TAU)),
        )
        .into_any_element()
}

fn dot(size: f32, color: Hsla) -> AnyElement {
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(color)
        .into_any_element()
}

pub fn live_folder_icon(c: &Chrome, folder: &Folder, open: bool) -> AnyElement {
    if c.state.settings.live_folder_icon != LiveFolderIcon::Service {
        return folder_or_icon(
            c,
            &format!("livefolder|{}", folder.id),
            folder.icon.as_deref(),
            folder.color,
            open,
        );
    }
    let (site, own) = service_icon(folder);
    let favicon = c.resolve_favicon(
        favicon_of(site, None, own.as_deref(), ""),
        &c.window.profile_id,
    );
    render_favicon(&favicon, c.look.icon_points(sidebar::ROW_FAVICON), c.p)
}

#[derive(Default)]
struct LiveClock {
    first_seen: HashMap<(String, String), Instant>,
}

impl Global for LiveClock {}

#[derive(IntoElement)]
pub(crate) struct HoverSwap {
    pub(crate) key: GroupId,
    pub(crate) rest: Option<AnyElement>,
    pub(crate) over: Option<AnyElement>,
}

impl RenderOnce for HoverSwap {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ui = group_ui(cx);
        let hovered = ui.innermost(&self.key);
        let (shown, moving) = ui.box_opacity(&self.key, hovered);
        if moving {
            window.request_animation_frame();
        }
        div()
            .relative()
            .flex_none()
            .min_w(px(SLOT))
            .h_full()
            .flex()
            .items_center()
            .justify_end()
            .children(self.rest.map(|rest| div().opacity(1.0 - shown).child(rest)))
            .children(self.over.filter(|_| shown > 0.0).map(|over| {
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .flex()
                    .items_center()
                    .opacity(shown)
                    .child(over)
            }))
    }
}

#[derive(IntoElement)]
struct CompletingRow {
    key: (String, String),
    row: AnyElement,
}

impl RenderOnce for CompletingRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let start = *cx
            .default_global::<LiveClock>()
            .first_seen
            .entry(self.key)
            .or_insert_with(Instant::now);
        let delay = Duration::from_millis(rows::COMPLETION_MS - 420);
        let elapsed = start.elapsed();
        let fold = if elapsed <= delay {
            1.0
        } else {
            let t = (elapsed - delay).as_secs_f64() / (LIVE_FOLD_MS as f64 / 1000.0);
            1.0 - ease_out_cubic(t) as f32
        };
        if fold > 0.0 {
            window.request_animation_frame();
        }
        div()
            .flex_none()
            .h(px(sidebar::row_height() * fold))
            .opacity(fold)
            .overflow_hidden()
            .child(self.row)
    }
}

#[derive(IntoElement)]
struct PoppingIcon {
    key: (String, String),
    icon: AnyElement,
}

impl RenderOnce for PoppingIcon {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let start = *cx
            .default_global::<LiveClock>()
            .first_seen
            .entry((format!("pop:{}", self.key.0), self.key.1))
            .or_insert_with(Instant::now);
        let t = start.elapsed().as_secs_f64() / (ICON_POP_MS as f64 / 1000.0);
        if t < 1.0 {
            window.request_animation_frame();
        }
        let scale = 0.3 + 0.7 * CubicBezier::EASE_OUT_CUBIC.ease(t.clamp(0.0, 1.0)) as f32;
        div()
            .flex_none()
            .size(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .size(px(16. * scale))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(self.icon),
            )
    }
}

struct Ctx<'a> {
    c: &'a Chrome<'a>,
    folder: &'a Folder,
    data: &'a FolderData,
    sink: &'a LiveSink,
    colors: LiveColors,
    view: Vec<&'a Tab>,
    hidden_and_items: (HashSet<String>, HashSet<String>),
}

fn send(
    sink: &LiveSink,
    command: LiveCommand,
) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static {
    let sink = Rc::clone(sink);
    move |_, window, cx| sink(command.clone(), window, cx)
}

fn item_icon(x: &Ctx, item: &Item, completion: Option<Completion>) -> AnyElement {
    if let Some(state) = completion {
        let (data, color) = completion_glyph(state, &x.colors);
        return PoppingIcon {
            key: (x.folder.id.clone(), item.id.clone()),
            icon: glyph(data, 14., 16., color, SymbolWeight::Semibold),
        }
        .into_any_element();
    }
    if let Some(pr) = &item.pr {
        return glyph(
            sf("arrow.triangle.pull", Icon::Link),
            12.,
            16.,
            if pr.draft {
                x.colors.draft
            } else {
                x.colors.success
            },
            SymbolWeight::Semibold,
        );
    }
    let favicon = match item.icon.as_deref() {
        Some(url) if url.starts_with("http:") || url.starts_with("https:") => {
            favicon_of(&item.url, Some(url), None, "")
        }
        own => {
            let url = if item.source == rows::LiveSource::Confluence && own.is_none() {
                rows::LiveSource::Confluence.site()
            } else {
                item.url.as_str()
            };
            favicon_of(url, None, own, "")
        }
    };
    render_favicon(
        &x.c.resolve_favicon(favicon, &x.c.window.profile_id),
        x.c.look.icon_points(sidebar::ROW_FAVICON),
        x.c.p,
    )
}

fn trailing(x: &Ctx, item: &Item, completion: Option<Completion>) -> Option<AnyElement> {
    if let Some(state) = completion {
        let (_, color) = completion_glyph(state, &x.colors);
        return Some(
            div()
                .mr(px(4.))
                .text_size(px(x.c.points(11.)))
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .child(state.label())
                .into_any_element(),
        );
    }
    let badge = item.pr.as_ref().and_then(pr_badge)?;
    let (data, color) = badge_look(badge, &x.colors);
    Some(
        div()
            .id(SharedString::from(format!("live-badge:{}", item.id)))
            .flex_none()
            .size(px(SLOT))
            .flex()
            .items_center()
            .justify_center()
            .tooltip(crate::primitives::controls::tooltip(
                badge.tip().into(),
                x.c.p,
            ))
            .child(match data {
                Some(data) => glyph(data, 11., 16., color, SymbolWeight::Semibold),
                None => div()
                    .size(px(7.))
                    .rounded_full()
                    .bg(color)
                    .border(px(0.5))
                    .border_color(x.colors.badge_ring)
                    .into_any_element(),
            })
            .into_any_element(),
    )
}

fn live_item_row(x: &Ctx, item: &Item, in_stack: bool) -> AnyElement {
    let c = x.c;
    let p = *c.p;
    let indent = if in_stack { STACK_INDENT } else { 0.0 };
    let folder = x.folder.id.clone();
    let tab = item_tab(&x.view, &folder, &item.id);
    let active = tab.as_ref().is_some_and(|t| c.is_active(t));
    let away = tab
        .as_ref()
        .and_then(|t| c.state.tab(t.as_str()))
        .is_some_and(|t| crate::sidebar::hover_card::away_from_pin(t));
    let unread = x.data.unread.contains(&item.id);
    let completion = x.data.completing.get(&item.id).copied();
    let fill = row_look::row_fill(c, active, false);
    let title_color = if completion.is_some() {
        p.text_secondary
    } else {
        row_look::title_color(c, active)
    };
    let resettable = away && completion.is_none();
    let control: Option<(Icon, &str, ClickFn)> = match (&tab, &item.pr) {
        (Some(tab), _) => Some((
            Icon::Minus,
            "Close Tab",
            Box::new(c.emit.click(Msg::CloseTab(tab.clone()))),
        )),
        (None, Some(_)) => Some((
            Icon::XMark,
            "Hide Until Refresh",
            Box::new(send(
                x.sink,
                LiveCommand::HideItems {
                    folder: folder.clone(),
                    items: vec![item.id.clone()],
                },
            )),
        )),
        _ => None,
    };
    let hover_key = format!("live-row:{folder}:{}", item.id);
    let open = {
        let sink = Rc::clone(x.sink);
        let folder = folder.clone();
        let id = item.id.clone();
        move |event: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
            sink(
                LiveCommand::OpenItem {
                    folder: folder.clone(),
                    item: id.clone(),
                    background: event.modifiers().platform,
                },
                window,
                cx,
            );
        }
    };
    let menu = {
        let sink = Rc::clone(x.sink);
        let folder = folder.clone();
        let id = item.id.clone();
        let tab = tab.clone();
        move |event: &gpui::MouseDownEvent, window: &mut Window, cx: &mut App| {
            cx.stop_propagation();
            sink(
                LiveCommand::ItemMenu {
                    folder: folder.clone(),
                    item: id.clone(),
                    tab: tab.clone(),
                    at: event.position,
                },
                window,
                cx,
            );
        }
    };
    let icon_el = if resettable {
        let reset = c.emit.click(Msg::Store(Action::ReturnToPinnedUrl {
            tab: tab.unwrap_or_else(|| TabId::new("")),
        }));
        div()
            .id(SharedString::from(format!("live-reset:{}", item.id)))
            .group("live-reset")
            .relative()
            .flex_none()
            .size(px(16.))
            .on_click(move |e, w, cx| {
                cx.stop_propagation();
                reset(e, w, cx);
            })
            .tooltip(crate::primitives::controls::tooltip(
                "Back to Pinned URL".into(),
                c.p,
            ))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .group_hover("live-reset", |s| s.opacity(0.))
                    .child(item_icon(x, item, completion)),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .opacity(0.)
                    .group_hover("live-reset", |s| s.opacity(1.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(glyph(
                        sf("arrow.uturn.backward", Icon::Undo),
                        11.,
                        16.,
                        title_color,
                        SymbolWeight::Semibold,
                    )),
            )
            .into_any_element()
    } else {
        item_icon(x, item, completion)
    };
    let stacked = in_stack
        .then(|| item.pr.as_ref().and_then(|pr| pr.stack.as_ref()))
        .flatten();
    let slot_rest = trailing(x, item, completion);
    let slot_over = control
        .filter(|_| completion.is_none())
        .map(|(glyph_icon, tip, press)| {
            IconButton::new(row_id("live-control", &hover_key), glyph_icon, c.p)
                .glyph(10.)
                .square(SLOT, 6.)
                .color(p.icon)
                .fills(p.toolbar_hover, p.toolbar_pressed)
                .tooltip(tip, c.p)
                .on_click(move |e, w, cx| {
                    cx.stop_propagation();
                    press(e, w, cx);
                })
                .into_any_element()
        });
    let key = GroupId::new(hover_key.clone());
    let key_for_hover = key.clone();
    let reserve = stacked.is_some() || slot_rest.is_some();
    let row = div()
        .id(row_id("live-row", &hover_key))
        .relative()
        .flex_none()
        .h(px(sidebar::row_height()))
        .pl(px(sidebar::ROW_CONTENT_LEFT + indent))
        .pr(px(sidebar::ROW_TRAILING))
        .rounded(px(row_look::chrome_radius()))
        .flex()
        .items_center()
        .gap(px(sidebar::DIA_ROW_TITLE_GAP))
        .when_some(fill.rest, |this, f| this.bg(f))
        .when_some(fill.border, |this, hairline| {
            this.child(crate::sidebar::tab_row::row_hairline(hairline))
        })
        .when(fill.glow, |this| {
            this.child(crate::primitives::outer_glow::outer_glow(
                px(row_look::chrome_radius()),
                row_look::selected_glow(c),
            ))
        })
        .when(completion.is_none(), |this| {
            this.when_some(fill.hover, |this, f| this.hover(move |s| s.bg(f)))
                .when_some(fill.pressed, |this, f| this.active(move |s| s.bg(f)))
        })
        .on_click(open)
        .on_mouse_down(MouseButton::Right, menu)
        .when(unread, |this| {
            this.child(
                div()
                    .absolute()
                    .left(px(UNREAD_DOT_LEFT + indent))
                    .top(px((sidebar::row_height() - 5.) / 2.))
                    .child(dot(5., p.accent)),
            )
        })
        .child(icon_el)
        .child(
            fade_label(
                if resettable {
                    SharedString::new_static("Back to Pinned URL")
                } else {
                    SharedString::from(item.title.clone())
                },
                title_color,
                row_look::title_size(c),
            )
            .weight(if unread {
                FontWeight::MEDIUM
            } else {
                FontWeight::NORMAL
            }),
        )
        .when_some(stacked, |this, stack| {
            this.child(
                div().ml(px(4.)).child(
                    badge(stack.position.to_string(), c.p)
                        .tone(crate::primitives::controls::BadgeTone::Chip),
                ),
            )
        })
        .when(reserve || slot_over.is_some(), |this| {
            this.child(HoverSwap {
                key,
                rest: slot_rest,
                over: slot_over,
            })
        });
    let hover = {
        let key = key_for_hover;
        move |hovered: &bool, window: &mut Window, cx: &mut App| {
            group_ui(cx).set_hovered(&key, Vec::new(), *hovered);
            window.refresh();
        }
    };
    if completion.is_some() {
        return CompletingRow {
            key: (folder, item.id.clone()),
            row: row.on_hover(hover).into_any_element(),
        }
        .into_any_element();
    }
    let stored = c.host.live().and_then(|live| {
        live.items
            .get(&folder)?
            .iter()
            .find(|it| it.id == item.id)
            .cloned()
    });
    match stored {
        Some(stored) => {
            let card_key = TabId::new(format!("live|{folder}|{}", item.id));
            let width = crate::live::card::card_width(&stored);
            let host = std::sync::Arc::clone(c.host);
            let emit = c.emit.clone();
            let window_id = c.window.id.clone();
            crate::sidebar::hover_card::attach_card(row, c, &card_key, width, hover, move || {
                crate::primitives::controls::hover_card(width, &p)
                    .p(px(CARD_PAD))
                    .child(crate::live::card::live_item_card(
                        &crate::live::card::CardContext {
                            host: host.as_ref(),
                            p: &p,
                            emit: &emit,
                            window: &window_id,
                            now: now_millis(),
                        },
                        &folder,
                        &stored,
                    ))
                    .into_any_element()
            })
            .into_any_element()
        }
        None => row.on_hover(hover).into_any_element(),
    }
}

fn section_title(c: &Chrome, title: &str) -> AnyElement {
    div()
        .flex_none()
        .h(px(SECTION_HEIGHT))
        .px(px(sidebar::ROW_CONTENT_LEFT))
        .pt(px(SECTION_HEIGHT - 2. - CAPTION_LINE))
        .pb(px(2.))
        .text_size(px(c.points(11.)))
        .line_height(px(CAPTION_LINE))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(c.p.text_secondary)
        .truncate()
        .child(SharedString::from(title.to_owned()))
        .into_any_element()
}

fn list_row(c: &Chrome, id: String, height: f32, clickable: bool) -> gpui::Stateful<gpui::Div> {
    let p = *c.p;
    div()
        .id(SharedString::from(id))
        .flex_none()
        .h(px(height))
        .pl(px(sidebar::ROW_CONTENT_LEFT))
        .rounded(px(8.))
        .flex()
        .items_center()
        .when(clickable, |this| this.hover(move |s| s.bg(p.row_hover)))
}

fn note_row(x: &Ctx, note: &Note) -> AnyElement {
    let c = x.c;
    let p = *c.p;
    let folder = x.folder.id.clone();
    let press = match note {
        Note::Error(_) => Some(LiveCommand::FixError { folder }),
        Note::Hidden(_) => Some(LiveCommand::Refresh { folder }),
        _ => None,
    };
    list_row(
        c,
        format!("live-note:{}", x.folder.id),
        NOTE_HEIGHT,
        press.is_some(),
    )
    .pr(px(sidebar::ROW_TRAILING))
    .gap(px(6.))
    .when_some(press, |this, press| this.on_click(send(x.sink, press)))
    .map(|this| match note {
        Note::Loading => this.child(
            div()
                .flex_none()
                .size(px(16.))
                .flex()
                .items_center()
                .justify_center()
                .child(refresh_spinner(
                    sf("arrow.triangle.2.circlepath", Icon::Sync),
                    SymbolWeight::Regular,
                    p.text_secondary,
                )),
        ),
        Note::Error(_) => this.child(glyph(
            sf("exclamationmark.triangle.fill", Icon::WarningFill),
            10.,
            16.,
            x.colors.pending,
            SymbolWeight::Regular,
        )),
        _ => this,
    })
    .child(
        div()
            .flex_1()
            .min_w_0()
            .text_size(px(c.points(12.)))
            .text_color(p.text_secondary)
            .line_clamp(2)
            .child(note.text()),
    )
    .into_any_element()
}

fn more_row(x: &Ctx, section: rows::Section, count: usize) -> AnyElement {
    let c = x.c;
    list_row(
        c,
        format!("live-more:{}:{}", x.folder.id, section.key()),
        MORE_HEIGHT,
        true,
    )
    .on_click(send(
        x.sink,
        LiveCommand::ShowAll {
            folder: x.folder.id.clone(),
            section,
        },
    ))
    .child(glyph(
        sf("ellipsis", Icon::Ellipsis),
        11.,
        16.,
        c.p.text_secondary,
        SymbolWeight::Regular,
    ))
    .child(
        div()
            .ml(px(TEXT_GAP))
            .text_size(px(c.points(12.)))
            .text_color(c.p.text_secondary)
            .child(format!("Show {count} More")),
    )
    .into_any_element()
}

fn stack_block(x: &Ctx, id: &str, repo: &str, items: &[Item]) -> (AnyElement, f32) {
    let c = x.c;
    let p = *c.p;
    let collapsed = x.data.collapsed_stacks.contains(id);
    let tab_open = stack_tab_open(&x.view, &x.folder.id, items);
    let short = repo.split('/').nth(1).unwrap_or(repo).to_owned();
    let key = GroupId::new(format!("stack:{}:{id}", x.folder.id));
    let hide = (!tab_open).then(|| {
        IconButton::new(row_id("live-stack-hide", key.as_str()), Icon::XMark, c.p)
            .glyph(10.)
            .square(SLOT, 6.)
            .color(p.icon)
            .fills(p.toolbar_hover, p.toolbar_pressed)
            .tooltip("Hide Stack Until Refresh", c.p)
            .on_click({
                let sink = Rc::clone(x.sink);
                let folder = x.folder.id.clone();
                let stack = id.to_owned();
                move |_, w, cx| {
                    cx.stop_propagation();
                    sink(
                        LiveCommand::HideStack {
                            folder: folder.clone(),
                            stack: stack.clone(),
                        },
                        w,
                        cx,
                    );
                }
            })
            .into_any_element()
    });
    let header = list_row(
        c,
        format!("live-stack:{}", key.as_str()),
        STACK_HEIGHT,
        true,
    )
    .pr(px(8.))
    .on_click(send(
        x.sink,
        LiveCommand::ToggleStack {
            stack: id.to_owned(),
        },
    ))
    .on_hover({
        let key = key.clone();
        move |hovered, window, cx| {
            group_ui(cx).set_hovered(&key, Vec::new(), *hovered);
            window.refresh();
        }
    })
    .child(glyph(
        sf("square.stack.3d.up", Icon::Tabs),
        11.,
        16.,
        p.text_secondary,
        SymbolWeight::Regular,
    ))
    .child(
        div()
            .flex_1()
            .min_w_0()
            .ml(px(TEXT_GAP))
            .text_size(px(c.points(12.)))
            .font_weight(FontWeight::MEDIUM)
            .text_color(p.text_secondary)
            .truncate()
            .child(format!("{short} stack")),
    )
    .child(div().mr(px(4.)).child(HoverSwap {
        key: key.clone(),
        rest: Some(badge(items.len().to_string(), c.p).into_any_element()),
        over: hide,
    }))
    .child(StackChevron {
        key: key.clone(),
        open: !collapsed,
        color: p.text_secondary,
    })
    .into_any_element();
    let members: Vec<FoldMember> = items
        .iter()
        .map(|item| FoldMember {
            element: live_item_row(x, item, true),
            height: sidebar::row_height(),
            kept: false,
        })
        .collect();
    let open_height = sidebar::row_gap()
        + items.len() as f32 * sidebar::row_height()
        + items.len().saturating_sub(1) as f32 * sidebar::row_gap();
    let height = STACK_HEIGHT + if collapsed { 0.0 } else { open_height };
    (
        GroupBlock {
            id: GroupId::new(format!("fold:{}", key.as_str())),
            ancestors: Vec::new(),
            collapsed,
            fill: Hsla::transparent_black(),
            stroke: Hsla::transparent_black(),
            at_rest: false,
            header: div()
                .mt(px(-STACK_LIFT))
                .when(collapsed, |this| this.mb(px(STACK_LIFT)))
                .child(header)
                .into_any_element(),
            members,
            first_gap: [
                sidebar::row_gap() + STACK_LIFT,
                sidebar::row_gap() + STACK_LIFT,
            ],
            fold_sides: (0.0, 0.0),
            pad_bottom: Some(0.0),
            pad_y: 0.0,
        }
        .into_any_element(),
        height,
    )
}

#[derive(IntoElement)]
struct StackChevron {
    key: GroupId,
    open: bool,
    color: Hsla,
}

impl RenderOnce for StackChevron {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let fold = GroupId::new(format!("fold:{}", self.key.as_str()));
        let (open, _) = group_ui(cx).open(&fold, self.open);
        div()
            .flex_none()
            .size(px(12.))
            .flex()
            .items_center()
            .justify_center()
            .child(crate::sidebar::group_list::glyphs::turned(
                crate::sidebar::group_list::glyphs::CHEVRON_DOWN,
                12.,
                self.color,
                -std::f32::consts::FRAC_PI_2 * (1.0 - open),
            ))
    }
}

fn header(x: &Ctx) -> AnyElement {
    let c = x.c;
    let p = *c.p;
    let folder = x.folder;
    let collapsed = folder.collapsed;
    let status = x.data.status.as_ref();
    let busy = updating(status);
    let tip = status_text(status, x.data.hidden.len(), now_millis());
    let refresh = LiveCommand::Refresh {
        folder: folder.id.clone(),
    };
    let key = GroupId::new(format!("live-header:{}", folder.id));
    let error = status.and_then(|s| s.error);
    let slot: AnyElement = if busy {
        div()
            .id(SharedString::from(format!("live-spinner:{}", folder.id)))
            .flex_none()
            .size(px(SLOT))
            .flex()
            .items_center()
            .justify_center()
            .tooltip(crate::primitives::controls::tooltip(tip.into(), c.p))
            .on_click(send(x.sink, refresh))
            .child(refresh_arrow_spinner(p.text_secondary))
            .into_any_element()
    } else {
        let rest = (collapsed || error.is_some()).then(|| {
            div()
                .flex()
                .items_center()
                .mr(px(2.))
                .gap(px(4.))
                .when(collapsed && !x.data.unread.is_empty(), |this| {
                    this.child(dot(7., p.accent))
                })
                .when(collapsed, |this| {
                    this.child(badge(x.data.items.len().to_string(), c.p))
                })
                .when_some(error, |this, _| {
                    this.child(
                        div()
                            .id(SharedString::from(format!("live-warning:{}", folder.id)))
                            .on_click(send(
                                x.sink,
                                LiveCommand::FixError {
                                    folder: folder.id.clone(),
                                },
                            ))
                            .child(glyph(
                                sf("exclamationmark.triangle.fill", Icon::WarningFill),
                                10.,
                                18.,
                                x.colors.pending,
                                SymbolWeight::Regular,
                            )),
                    )
                })
                .into_any_element()
        });
        let over = IconButton::new(row_id("live-refresh", &folder.id), Icon::Reload, c.p)
            .glyph(10.)
            .square(SLOT, 6.)
            .color(p.icon)
            .fills(p.toolbar_hover, p.toolbar_pressed)
            .tooltip(tip, c.p)
            .on_click({
                let sink = Rc::clone(x.sink);
                move |_, w, cx| {
                    cx.stop_propagation();
                    sink(refresh.clone(), w, cx);
                }
            })
            .into_any_element();
        HoverSwap {
            key: key.clone(),
            rest,
            over: Some(over),
        }
        .into_any_element()
    };
    let menu = {
        let sink = Rc::clone(x.sink);
        let folder = folder.id.clone();
        move |event: &gpui::MouseDownEvent, window: &mut Window, cx: &mut App| {
            cx.stop_propagation();
            sink(
                LiveCommand::FolderMenu {
                    folder: folder.clone(),
                    at: event.position,
                },
                window,
                cx,
            );
        }
    };
    div()
        .id(row_id("live-header", &folder.id))
        .debug_selector(|| "live-folder-header".into())
        .relative()
        .flex_none()
        .h(px(sidebar::row_height()))
        .pl(px(sidebar::ROW_CONTENT_LEFT))
        .pr(px(sidebar::ROW_TRAILING))
        .rounded(px(GROUP_INNER_RADIUS))
        .flex()
        .items_center()
        .on_hover(move |hovered, window, cx| {
            group_ui(cx).set_hovered(&key, Vec::new(), *hovered);
            window.refresh();
        })
        .on_click(send(
            x.sink,
            LiveCommand::ToggleFolder {
                folder: folder.id.clone(),
                collapsed: !collapsed,
            },
        ))
        .on_mouse_down(MouseButton::Right, menu)
        .child(live_folder_icon(c, folder, !collapsed))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h(px(c.points(18.)))
                .ml(px(TITLE_GAP))
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_shrink(1.)
                        .min_w_0()
                        .pr(px(TITLE_TRAILING))
                        .child(
                            fade_label(
                                SharedString::from(folder.name.clone()),
                                group_title_color(c.look.dark, c.look.high_contrast),
                                c.points(13.),
                            )
                            .weight(FontWeight::MEDIUM)
                            .line_height(c.points(18.))
                            .hug(),
                        ),
                ),
        )
        .child(
            div()
                .flex_none()
                .self_stretch()
                .flex()
                .items_center()
                .child(slot),
        )
        .into_any_element()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn live_folder_block(
    c: &Chrome,
    folder: &Folder,
    data: &FolderData,
    sink: &LiveSink,
) -> AnyElement {
    let window = c.window.id.as_str();
    let view: Vec<&Tab> = c
        .state
        .view_tabs(window, None)
        .into_iter()
        .map(|t| t.as_ref())
        .collect();
    let item_ids: HashSet<String> = data.items.iter().map(|i| i.id.clone()).collect();
    let x = Ctx {
        c,
        folder,
        data,
        sink,
        colors: live_colors(c),
        view,
        hidden_and_items: (data.hidden.clone(), item_ids),
    };
    let (hidden, items) = &x.hidden_and_items;
    let rows = folder_rows(folder, &data.items, &data.show_all);
    let stray_ids = strays(&x.view, &folder.id, items, hidden);
    let active = active_live_tab(c.active.map(|t| t.as_ref()), &folder.id, hidden);
    let keep = folder
        .collapsed
        .then(|| keep_key(&rows, &stray_ids, active.as_ref()))
        .flatten();
    let mut members: Vec<FoldMember> = Vec::new();
    let mut push = |key: String, element: AnyElement, height: f32| {
        let kept = keep.as_deref() == Some(key.as_str());
        members.push(FoldMember {
            element,
            height,
            kept,
        });
    };
    if rows.is_empty() {
        push(
            "note".into(),
            note_row(&x, &folder_note(folder, data)),
            NOTE_HEIGHT,
        );
    }
    for row in &rows {
        let key = row.key();
        match row {
            Row::Header { title, .. } => push(key, section_title(c, title), SECTION_HEIGHT),
            Row::More { section, count } => push(key, more_row(&x, *section, *count), MORE_HEIGHT),
            Row::Item(item) => push(key, live_item_row(&x, item, false), sidebar::row_height()),
            Row::Stack { id, repo, items } => {
                let (element, height) = stack_block(&x, id, repo, items);
                push(key, element, height);
            }
        }
    }
    for id in &stray_ids {
        if let Some(tab) = c.state.tab(id.as_str()) {
            push(
                format!("stray:{id}"),
                tab_row(c, tab, 0),
                sidebar::row_height(),
            );
        }
    }
    let open_item: crate::sidebar::completed_footer::OpenItem = {
        let sink = Rc::clone(sink);
        let folder_id = folder.id.clone();
        Rc::new(move |item: &str, window: &mut Window, cx: &mut App| {
            sink(
                LiveCommand::OpenItem {
                    folder: folder_id.clone(),
                    item: item.to_owned(),
                    background: false,
                },
                window,
                cx,
            )
        })
    };
    if let Some(footer) = crate::sidebar::completed_footer::footer(
        c,
        &folder.id,
        &crate::sidebar::completed_footer::shown_rows(&data.completed, &[], now_millis()),
        open_item,
    ) {
        push("completed".into(), footer, COMPLETED_HEIGHT);
    }
    let (fill, stroke, at_rest) = group_surface(folder.color, (c.p.group_box, c.p.group_stroke));
    GroupBlock {
        id: GroupId::new(format!("livefolder|{}", folder.id)),
        ancestors: Vec::new(),
        collapsed: folder.collapsed,
        fill,
        stroke,
        at_rest,
        header: header(&x),
        members,
        first_gap: [0.0, 0.0],
        fold_sides: (BOX_PAD, BOX_PAD),
        pad_bottom: Some(PAD),
        pad_y: sidebar::GROUP_BORDER,
    }
    .into_any_element()
}

#[derive(Clone, Default)]
pub struct LiveFeed {
    pub folders: Vec<(Folder, FolderData)>,
    pub sink: Option<LiveSink>,
}

thread_local! {
    static FEED: std::cell::RefCell<LiveFeed> = std::cell::RefCell::new(LiveFeed::default());
}

pub fn publish(feed: LiveFeed) {
    FEED.with(|cell| *cell.borrow_mut() = feed);
}

pub fn pinned_list(
    c: &Chrome,
    pinned: &[crate::sidebar::model::Entry],
    (key, handle): (&str, &gpui::ScrollHandle),
) -> Option<AnyElement> {
    let feed = FEED.with(|cell| cell.borrow().clone());
    let entries: Vec<(String, usize)> = pinned
        .iter()
        .enumerate()
        .map(|(i, e)| (entry_anchor(e, c.state), i))
        .collect();
    let profile = &c.window.profile_id;
    let shown: Vec<(Folder, usize)> = feed
        .folders
        .iter()
        .enumerate()
        .filter(|(_, (f, _))| &f.profile_id == profile)
        .map(|(i, (f, _))| (f.clone(), usize::MAX - i))
        .collect();
    let slots: Vec<usize> = place_live(entries, &shown)
        .into_iter()
        .filter(|slot| *slot < pinned.len() || feed.folders.get(usize::MAX - slot).is_some())
        .collect();
    if slots.is_empty() {
        return None;
    }
    let sink = feed.sink.clone().unwrap_or_else(|| Rc::new(|_, _, _| {}));
    let window = c.window.id.as_str();
    let everything = crate::sidebar::drag::live_drag(window).is_some()
        || crate::sidebar::drag_motion::busy(window);
    let items: Vec<crate::primitives::virtual_list::VirtualItem> = slots
        .iter()
        .map(|&slot| {
            if slot < pinned.len() {
                crate::primitives::virtual_list::VirtualItem::new(
                    crate::sidebar::entry_key(&pinned[slot]),
                    crate::sidebar::model::entry_height(c.state, window, &pinned[slot]),
                )
            } else {
                let folder = &feed.folders[usize::MAX - slot].0;
                crate::primitives::virtual_list::VirtualItem::new(
                    SharedString::from(format!("live:{}", folder.id)),
                    ardia_theme::layout::sidebar::row_height(),
                )
            }
        })
        .collect();
    Some(
        crate::primitives::virtual_list::virtual_list(
            SharedString::from(format!("sidebar-pinned:{key}")),
            handle,
        )
        .items(items)
        .gap(ardia_theme::layout::sidebar::row_gap())
        .keep(crate::sidebar::active_entry_key(c))
        .render_all(everything)
        .scope(SharedString::from(window.to_owned()))
        .render(|ix, _| {
            let slot = slots[ix];
            if slot < pinned.len() {
                crate::sidebar::group_list::entry(c, &pinned[slot])
            } else {
                let (folder, data) = &feed.folders[usize::MAX - slot];
                live_folder_block(c, folder, data, &sink)
            }
        }),
    )
}

#[cfg(test)]
mod ui_tests {
    use super::rows::fixtures::{folder, pr};
    use super::rows::{FetchState, FolderKind, Section, Status};
    use super::*;
    use crate::tests::support::Browser;
    use gpui::TestAppContext;
    use std::cell::RefCell;

    #[test]
    fn badge_and_completion_colours_follow_the_live_tokens() {
        let colors = LiveColors {
            pending: Hsla::red(),
            merged: Hsla::blue(),
            draft: Hsla::black(),
            conflict: Hsla::green(),
            badge_ring: Hsla::white(),
            success: Hsla::white(),
            failure: Hsla::red(),
        };
        assert_eq!(badge_look(PrBadge::Pending, &colors), (None, Hsla::red()));
        assert_eq!(badge_look(PrBadge::Conflict, &colors).1, Hsla::green());
        assert_eq!(
            completion_glyph(Completion::Merged, &colors).1,
            Hsla::blue()
        );
        assert_eq!(
            completion_glyph(Completion::Closed, &colors).0.symbol,
            "xmark.circle.fill"
        );
    }

    #[gpui::test]
    fn a_live_folder_renders_rows_and_sends_its_clicks(cx: &mut TestAppContext) {
        let sent: Rc<RefCell<Vec<LiveCommand>>> = Rc::default();
        let log = Rc::clone(&sent);
        let mut f = folder(FolderKind::PullRequests);
        f.after = Some(None);
        let data = FolderData {
            items: vec![
                pr("1", Section::Authored, None),
                pr("2", Section::Review, None),
            ],
            status: Some(Status {
                state: FetchState::Idle,
                last_fetch: Some(0),
                error: None,
            }),
            ..FolderData::default()
        };
        publish(LiveFeed {
            folders: vec![(f, data)],
            sink: Some(Rc::new(move |command, _, _| log.borrow_mut().push(command))),
        });
        let browser = Browser::open(cx);
        browser.redraw(cx);
        assert!(browser.bounds(cx, "live-folder-header").is_some());
        browser.click(cx, "live-folder-header");
        assert_eq!(
            sent.borrow().first(),
            Some(&LiveCommand::ToggleFolder {
                folder: "lf".into(),
                collapsed: true
            })
        );
        publish(LiveFeed::default());
    }
}
