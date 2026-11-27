pub mod away_title;
pub mod clean_up_upsell;
pub mod clear_divider;
pub mod completed_footer;
pub mod dock_drag;
pub mod drag;
pub mod drag_motion;
pub mod edge_peek;
pub mod folders;
pub mod footer;
pub mod group_list;
pub mod header;
pub mod hover_card;
pub mod icon_picker;
pub mod list_motion;
pub mod live_folders;
pub mod model;
pub mod overflow_menu;
pub mod pager;
pub mod pinned_grid;
pub mod resize;
pub mod row_look;
pub mod scroll_edge;
pub mod search_tabs;
pub mod selected_pill;
pub mod sort_tabs;
pub mod strip_drag;
pub mod strip_hover;
pub mod strip_layout;
pub mod strip_motion;
pub mod tab_row;
pub mod tab_strip;
pub mod tab_switcher;
pub mod tidy_tabs;
pub mod tile_letters;

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

use crate::scale::px;
use ardia_state::ProfileId;
use ardia_state::windows::WindowKind;
use ardia_theme::layout::sidebar;
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, MouseButton, ParentElement, Pixels, ScrollDelta, SharedString, Styled, TouchPhase,
    Window, div, prelude::*,
};

use crate::msg::{MenuTarget, Msg};
use crate::primitives::icons::Icon;
use crate::sidebar::footer::{footer, footer_height, footer_moving};
use crate::sidebar::header::header;
use crate::sidebar::pager::{Phase, with_pager};
use crate::sidebar::scroll_edge::{
    EDGE_INSET, edge_line, hidden_below, scrolled_past_top, span_of, toolbar_edge_lift,
};
use crate::window::chrome::Chrome;
use crate::window::layout::{ARC_FIELD_GAP, ARC_FIELD_ROW, Rect};

pub use crate::sidebar::footer::{
    FOOTER_BOTTOM_GAP, SWITCHER_ICON, SWITCHER_ICON_CELL, SwitcherLevels, switcher_band_top,
    switcher_cell, switcher_levels,
};

pub const LIGHTS_RESERVE: f32 = header::INDICATOR_X;
pub const PROFILE_NAME_MIN: f32 = sidebar::PROFILE_NAME_MIN_TRUNCATED;
pub const DOCK_SHARE: f32 = 0.4;
pub const DOCK_SLACK: f32 = 12.0;
pub const DOCKED_ROW_PAD: f32 = 6.0;
pub const DOCKED_LIST_PAD: f32 = 24.0;
pub const TILES_TO_LIST: f32 = 6.0;
pub const DOCKED_TILES_GAP: f32 = 6.0;
pub const FIELD_RADIUS: f32 = 10.0;
pub const FIELD_PLACEHOLDER: &str = "Search or enter address";
pub const FIELD_CONTROL_BOX: f32 = 24.0;
pub const FIELD_CONTROL_INSET: f32 = (ARC_FIELD_ROW - FIELD_CONTROL_BOX) / 2.0;
pub const FIELD_TEXT_GAP: f32 = 6.0;
pub const FIELD_TEXT_ALONE: f32 = 10.0;
pub const FIELD_TRAIL_FADE: f32 = 14.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldButtons {
    pub leading: bool,
    pub site_controls: bool,
    pub page: bool,
}

pub fn field_buttons(always: bool, hovered: bool, insecure: bool) -> FieldButtons {
    let shown = always || hovered;
    FieldButtons {
        leading: always || insecure,
        site_controls: shown && !always && !insecure,
        page: shown,
    }
}

pub fn grid_height(count: usize, inner_width: f32) -> f32 {
    if count == 0 {
        return 0.0;
    }
    let (columns, _) = model::grid_columns(count, inner_width);
    let rows = count.div_ceil(columns.max(1)) as f32;
    rows * sidebar::pinned_tile_height() + (rows - 1.0) * sidebar::PINNED_TILE_GAP
}

pub fn tiles_fit_dock(count: usize, inner_width: f32, page_height: f32, top_gap: f32) -> bool {
    if count == 0 || page_height <= 0.0 {
        return true;
    }
    let room = page_height * DOCK_SHARE - top_gap - EDGE_INSET - sidebar::SCROLL_EDGE_LINE;
    grid_height(count, inner_width) <= room
}

pub fn docked_after(docked: bool, slack: f32) -> bool {
    if docked {
        slack < 1.0
    } else {
        slack < DOCK_SLACK
    }
}

pub fn visible_slots(position: f32, pages: usize) -> Vec<usize> {
    (0..pages)
        .filter(|slot| (*slot as f32 - position).abs() < 1.0)
        .collect()
}

thread_local! {
    static DOCKED: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
}

pub(crate) struct Frames(pub bool);

impl Element for Frames {
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
        let style = gpui::Style {
            position: gpui::Position::Absolute,
            ..gpui::Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        if self.0 {
            window.request_animation_frame();
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }
}

fn address_field(c: &Chrome) -> AnyElement {
    let p = *c.p;
    let empty = c.active.is_none_or(|tab| tab.url.is_empty());
    div()
        .id("arc-address")
        .debug_selector(|| "arc-address".into())
        .child(crate::onboarding::tour::probe(
            c.window.id.clone(),
            crate::onboarding::tour::Anchor::CommandBar,
        ))
        .on_scroll(crate::window::page_overlays::tab_swipe_handler(
            c.emit,
            c.state.settings.swipe_between_tabs,
        ))
        .flex_none()
        .h(px(ARC_FIELD_ROW))
        .mb(px(ARC_FIELD_GAP))
        .relative()
        .rounded(px(FIELD_RADIUS))
        .map(|this| {
            if c.look.glass {
                this.group(crate::primitives::glass_states::GLASS_CONTROL_GROUP)
                    .child(crate::primitives::glass_states::stateful_glass(
                        c.look,
                        FIELD_RADIUS,
                        crate::primitives::glass_states::GlassStates::HOVER_ONLY,
                        crate::primitives::glass_states::GlassBacking::Native,
                    ))
            } else {
                this.bg(p.pinned_resting)
                    .border(px(0.5))
                    .border_color(p.pinned_resting_stroke)
                    .hover(move |style| style.bg(p.tab_hover))
            }
        })
        .flex()
        .items_center()
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(c.emit.click(Msg::OpenCommandPanel {
            new_tab: false,
            text: None,
        }))
        .map(|this| {
            if empty {
                this.pl(px(12.0)).child(
                    div()
                        .ml(px(-2.0))
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.0))
                        .text_color(p.placeholder)
                        .child(SharedString::new_static(FIELD_PLACEHOLDER)),
                )
            } else {
                this.pr(px(FIELD_CONTROL_INSET))
                    .on_hover({
                        let emit = c.emit.clone();
                        move |hovered, window, cx| emit.send(Msg::UrlHover(*hovered), window, cx)
                    })
                    .on_mouse_down(MouseButton::Right, {
                        let emit = c.emit.clone();
                        let tab = c.active.map(|t| t.id.clone());
                        move |event, window, cx| {
                            cx.stop_propagation();
                            if let Some(tab) = tab.clone() {
                                emit.send(
                                    Msg::Menu(Some((
                                        MenuTarget::UrlBar(tab, None),
                                        event.position,
                                    ))),
                                    window,
                                    cx,
                                );
                            }
                        }
                    })
                    .children(field_page(c))
            }
        })
        .children(drag::pin_field_zone(c))
        .into_any_element()
}

fn field_control(
    c: &Chrome,
    id: &'static str,
    glyph: Icon,
    active: bool,
    tip: SharedString,
    msg: Msg,
) -> AnyElement {
    let p = c.p;
    crate::primitives::controls::IconButton::new(id, glyph, p)
        .square(FIELD_CONTROL_BOX, FIELD_RADIUS - FIELD_CONTROL_INSET)
        .glyph(13.0)
        .toggled(active.then_some(p.toolbar_pressed))
        .tooltip(tip, p)
        .on_click({
            let emit = c.emit.clone();
            let opens_site = !active
                && matches!(
                    msg,
                    Msg::TogglePopover(ardia_state::windows::Popover::SiteControls)
                );
            move |_, window, cx| {
                if opens_site {
                    ardia_telemetry::counts::count("site_controls_opens_from_sidebar_field");
                }
                emit.send(msg.clone(), window, cx);
            }
        })
        .into_any_element()
}

fn field_page(c: &Chrome) -> Vec<AnyElement> {
    let Some(tab) = c.active else {
        return Vec::new();
    };
    let p = *c.p;
    let site_open = matches!(
        c.window.chrome.popover,
        Some(ardia_state::windows::Popover::SiteControls)
    );
    let hovered = c.ui.url_hover || site_open;
    let insecure = matches!(
        tab.live.security,
        ardia_state::tabs::SecurityState::Insecure | ardia_state::tabs::SecurityState::Dangerous
    );
    let always =
        c.state.settings.address_bar_buttons == ardia_state::settings::AddressBarButtons::Always;
    let shown = field_buttons(always, hovered, insecure);
    let host = crate::content::toolbar::page_host_label(&tab.url);
    let trail = crate::content::toolbar::url_trail(
        &tab.url,
        &tab.display_title(),
        hovered,
        c.state.settings.show_full_url,
    );
    let site = Msg::TogglePopover(ardia_state::windows::Popover::SiteControls);
    let mut out = Vec::new();
    if shown.leading {
        out.push(
            div()
                .ml(px(FIELD_CONTROL_INSET))
                .child(field_control(
                    c,
                    "field-site",
                    if insecure {
                        Icon::LockWarning
                    } else {
                        Icon::Sliders
                    },
                    site_open,
                    SharedString::new_static(if insecure {
                        "Connection is not secure"
                    } else {
                        "Site Controls"
                    }),
                    site.clone(),
                ))
                .into_any_element(),
        );
    }
    out.push(
        div()
            .flex_1()
            .min_w_0()
            .pl(px(if shown.leading {
                FIELD_TEXT_GAP
            } else {
                FIELD_TEXT_ALONE
            }))
            .flex()
            .items_center()
            .child(
                div()
                    .flex_shrink(1.0)
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.0))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(p.text)
                    .child(SharedString::from(host)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .ml(px(-2.0))
                    .h(px(18.0))
                    .flex()
                    .child(
                        crate::primitives::fade_label::fade_label(trail, p.text_secondary, 13.0)
                            .fade_width(FIELD_TRAIL_FADE),
                    ),
            )
            .into_any_element(),
    );
    if shown.page {
        let bookmarks = c.state.settings.show_bookmarks;
        let bookmarked = bookmarks
            && c.state
                .bookmarks_of(&tab.profile_id)
                .is_some_and(|tree| tree.find_url(&tab.url).is_some());
        out.push(if bookmarks {
            field_control(
                c,
                "field-bookmark",
                if bookmarked {
                    Icon::BookmarkFill
                } else {
                    Icon::Bookmark
                },
                false,
                if bookmarked {
                    SharedString::new_static("Remove Bookmark")
                } else {
                    crate::content::find_bar::with_shortcut(
                        "Bookmark This Page",
                        crate::keybindings::hint(c.state, "bookmarkPage"),
                    )
                },
                Msg::command("bookmarkPage"),
            )
        } else {
            field_control(
                c,
                "field-copy",
                Icon::Link,
                false,
                crate::content::find_bar::with_shortcut(
                    "Copy URL",
                    crate::keybindings::hint(c.state, "copyUrl"),
                ),
                Msg::command("copyUrl"),
            )
        });
    }
    if shown.site_controls {
        out.push(field_control(
            c,
            "field-site-trailing",
            Icon::Sliders,
            site_open,
            SharedString::new_static("Site Controls"),
            site,
        ));
    }
    out
}

fn rows(
    c: &Chrome,
    sections: &model::Sections,
    inline_new_tab: bool,
    tiles_above: Option<bool>,
    list: (&str, &gpui::ScrollHandle),
) -> AnyElement {
    let clearable = sections.unpinned.len();
    let pinned = live_folders::pinned_list(c, &sections.pinned, list);
    let pinned_rows = pinned.is_some();
    let show_divider = pinned_rows
        || (c.state.settings.show_clear_button && clearable > 0)
        || clear_divider::offers_tidy(c);
    div()
        .flex()
        .flex_col()
        .relative()
        .child(list_motion::origin_probe(
            c.window.id.as_str(),
            c.window.profile_id.as_str(),
        ))
        .when(pinned_rows, |this| {
            this.child(
                div()
                    .when(tiles_above == Some(false), |this| {
                        this.mt(px(TILES_TO_LIST))
                    })
                    .flex()
                    .flex_col()
                    .children(pinned),
            )
        })
        .when(show_divider, |this| {
            let lift = tiles_above == Some(true) && !pinned_rows;
            this.child(
                div()
                    .when(lift, |this| this.mt(px(-DOCKED_TILES_GAP)))
                    .child(clear_divider::clear_divider(c, clearable)),
            )
        })
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(sidebar::row_gap()))
                .when(inline_new_tab && new_tab_at_top(c), |this| {
                    this.child(tab_row::new_tab_row(c))
                })
                .when(!sections.unpinned.is_empty(), |this| {
                    this.child(unpinned_rows(c, &sections.unpinned, list))
                })
                .when(inline_new_tab && !new_tab_at_top(c), |this| {
                    this.child(tab_row::sliding_new_tab_row(c))
                }),
        )
        .children(
            crate::plugins::overlays::mounted_sidebar(&c.window.id)
                .filter(|_| !c.window.profile_id.is_incognito()),
        )
        .into_any_element()
}

pub(crate) fn entry_key(entry: &model::Entry) -> SharedString {
    match entry {
        model::Entry::Tab { tab, .. } => SharedString::from(tab.id.as_str().to_owned()),
        model::Entry::Split { split, .. } => SharedString::from(format!("split:{}", split.id)),
        model::Entry::Group { group, .. } => SharedString::from(format!("group:{}", group.id)),
    }
}

pub(crate) fn active_entry_key(c: &Chrome) -> Option<SharedString> {
    let tab = c.active?;
    if let Some(split) = c.state.split_of(tab.id.as_str()) {
        let in_group = ardia_state::groups::innermost_group_of(&c.state.groups, tab.id.as_str());
        if in_group.is_none() {
            return Some(SharedString::from(format!("split:{}", split.id)));
        }
    }
    match ardia_state::groups::innermost_group_of(&c.state.groups, tab.id.as_str()) {
        Some(inner) => {
            let outer = ardia_state::groups::ancestors(&c.state.groups, inner.as_str())
                .pop()
                .unwrap_or(inner);
            Some(SharedString::from(format!("group:{outer}")))
        }
        None => Some(SharedString::from(tab.id.as_str().to_owned())),
    }
}

fn unpinned_rows(
    c: &Chrome,
    entries: &[model::Entry],
    (key, handle): (&str, &gpui::ScrollHandle),
) -> AnyElement {
    let window = c.window.id.as_str();
    let everything = drag::live_drag(window).is_some() || drag_motion::busy(window);
    let revision = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        c.sections.generation.hash(&mut hasher);
        sidebar::row_height().to_bits().hash(&mut hasher);
        sidebar::row_gap().to_bits().hash(&mut hasher);
        hasher.finish()
    };
    crate::primitives::virtual_list::virtual_list(
        SharedString::from(format!("sidebar-rows:{key}")),
        handle,
    )
    .items_with(revision, entries.len(), |ix| {
        crate::primitives::virtual_list::VirtualItem::new(
            entry_key(&entries[ix]),
            model::entry_height(c.state, window, &entries[ix]),
        )
    })
    .gap(sidebar::row_gap())
    .keep(active_entry_key(c))
    .render_all(everything)
    .scope(SharedString::from(window.to_owned()))
    .render(|ix, _| group_list::entry(c, &entries[ix]))
}

fn empty_area(c: &Chrome, key: &str, docked: bool) -> AnyElement {
    let emit = c.emit.clone();
    let menu = c.emit.clone();
    div()
        .id(SharedString::from(format!("sidebar-empty:{key}")))
        .debug_selector(|| "sidebar-empty".into())
        .flex_1()
        .min_h(px(if docked { 0.0 } else { 24.0 }))
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            if event.click_count == 2 {
                emit.send(Msg::command("newTab"), window, cx);
            } else {
                window.start_window_move();
            }
        })
        .on_mouse_down(MouseButton::Right, move |event, window, cx| {
            menu.send(
                Msg::Menu(Some((MenuTarget::NewTab, event.position))),
                window,
                cx,
            )
        })
        .into_any_element()
}

pub fn new_tab_at_top(c: &Chrome) -> bool {
    c.state.settings.new_tab_button_position == ardia_state::settings::Placement::Top
}

pub const GLOW_ROOM: f32 = 24.0;

pub fn list_glow_room(scrolled: bool, lift: f32, under_fixed_tiles: bool) -> f32 {
    let room = if scrolled { lift.max(0.0) } else { GLOW_ROOM };
    if under_fixed_tiles {
        room.min(TILES_TO_LIST)
    } else {
        room
    }
}

fn edge_slot(line: Option<AnyElement>, top: f32) -> AnyElement {
    div()
        .flex_none()
        .h_0()
        .relative()
        .children(line.map(|line| {
            div()
                .absolute()
                .left(px(-sidebar::INSET))
                .right(px(-sidebar::INSET))
                .top(px(top))
                .child(line)
        }))
        .into_any_element()
}

fn page(c: &Chrome, profile: &ProfileId, page_height: f32) -> AnyElement {
    let sections = c.sections;
    let key = format!("{}:{profile}", c.window.id);
    let handle = scroll_edge::handle(&key);
    let span = span_of(&handle);
    let arc = c.layout.sidebar_field;
    let inner = (c.layout.sidebar_width - 2.0 * sidebar::INSET).max(0.0);
    let top_gap = if arc {
        0.0
    } else {
        c.layout.first_row_top - c.layout.header
    };
    let player_height = crate::media::sidebar_player::player_height(c, profile);
    let fixed = tiles_fit_dock(
        sections.tiles.len(),
        inner,
        page_height - player_height,
        top_gap,
    );
    let has_tiles = !sections.tiles.is_empty();
    let lift = if (has_tiles && fixed) || arc {
        0.0
    } else {
        toolbar_edge_lift(c.layout.header, c.layout.card.y, c.layout.toolbar)
    };
    let glow_room = list_glow_room(scrolled_past_top(span.offset), lift, has_tiles && fixed);
    let rows_height = handle
        .bounds_for_item(0)
        .map(|b| crate::scale::points(b.size.height));
    let was_docked = DOCKED.with(|d| d.borrow().get(&key).copied().unwrap_or(false));
    let docked = !new_tab_at_top(c)
        && match rows_height {
            Some(height) if span.viewport > 0.0 => {
                let viewport = span.viewport - glow_room;
                let slack = if was_docked {
                    viewport
                        - DOCKED_LIST_PAD
                        - height
                        - (sidebar::row_height() + sidebar::row_gap())
                } else {
                    viewport - height
                };
                docked_after(was_docked, slack.max(0.0))
            }
            _ => was_docked,
        };
    if docked != was_docked {
        DOCKED.with(|d| d.borrow_mut().insert(key.clone(), docked));
    }
    let top_line = edge_line(c, format!("edge-top:{key}"), scrolled_past_top(span.offset));
    let bottom_line = edge_line(
        c,
        format!("edge-bottom:{key}"),
        hidden_below(span.offset, span.viewport, span.content),
    );
    div()
        .size_full()
        .flex()
        .flex_col()
        .child(div().flex_none().h(px(top_gap.max(0.0))))
        .when(has_tiles && fixed, |this| {
            this.child(pinned_grid::pinned_grid(c, &sections.tiles, inner))
                .child(div().flex_none().h(px(TILES_TO_LIST)))
        })
        .child(edge_slot(
            top_line,
            -(EDGE_INSET + sidebar::SCROLL_EDGE_LINE) - lift,
        ))
        .child(
            div()
                .id(SharedString::from(format!("sidebar-list:{key}")))
                .debug_selector(|| "sidebar-list".into())
                .flex_1()
                .min_h_0()
                .mx(px(-sidebar::INSET))
                .px(px(sidebar::INSET))
                .mt(px(-glow_room))
                .pt(px(glow_room))
                .flex()
                .flex_col()
                .overflow_y_scroll()
                .restrict_scroll_to_axis()
                .track_scroll(&handle)
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .flex_col()
                        .children(drag::pin_slot_gap(c))
                        .when(has_tiles && !fixed, |this| {
                            this.child(pinned_grid::pinned_grid(c, &sections.tiles, inner))
                        })
                        .child(rows(
                            c,
                            sections,
                            !docked,
                            has_tiles.then_some(fixed),
                            (&key, &handle),
                        ))
                        .children(
                            (*profile == c.window.profile_id)
                                .then(|| clean_up_upsell::upsell(c))
                                .flatten(),
                        ),
                )
                .child(empty_area(c, &key, docked))
                .when(docked, |this| {
                    this.child(div().flex_none().h(px(DOCKED_LIST_PAD)))
                }),
        )
        .child(edge_slot(bottom_line, -sidebar::SCROLL_EDGE_LINE))
        .children(crate::media::sidebar_player::sidebar_player(
            c, profile, docked,
        ))
        .when(docked, |this| {
            this.child(
                div()
                    .flex_none()
                    .py(px(DOCKED_ROW_PAD))
                    .child(tab_row::new_tab_row(c)),
            )
        })
        .into_any_element()
}

fn paging_index(c: &Chrome) -> Option<usize> {
    if c.window.kind == WindowKind::Incognito {
        return None;
    }
    c.state
        .profile_order
        .iter()
        .position(|id| *id == c.window.profile_id)
}

fn pages(c: &Chrome, position: f32, index: Option<usize>, page_height: f32) -> AnyElement {
    let width = c.layout.sidebar_width;
    let current = c.window.profile_id.clone();
    let order = &c.state.profile_order;
    let slots: Vec<Option<usize>> = match index {
        Some(index) => {
            let visible = visible_slots(position, order.len());
            if visible.is_empty() {
                vec![Some(index)]
            } else {
                visible.into_iter().map(Some).collect()
            }
        }
        None => vec![None],
    };
    let children = slots.into_iter().filter_map(|slot| {
        let profile = match slot {
            Some(slot) => order.get(slot)?.clone(),
            None => current.clone(),
        };
        let offset = slot.map_or(0.0, |slot| (slot as f32 - position) * width);
        let body = if profile == current {
            page(c, &profile, page_height)
        } else {
            let other = model::sections_for(c.state, c.window.id.as_str(), Some(&profile));
            let chrome = Chrome {
                sections: &other,
                ..*c
            };
            page(&chrome, &profile, page_height)
        };
        Some(
            div()
                .id(SharedString::from(format!("sidebar-page:{profile}")))
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(offset))
                .w(px(width))
                .px(px(sidebar::INSET))
                .child(body)
                .into_any_element(),
        )
    });
    div()
        .id("sidebar-pages")
        .flex_1()
        .min_h_0()
        .relative()
        .mx(px(-sidebar::INSET))
        .overflow_hidden()
        .children(children)
        .into_any_element()
}

fn swipe_handler(c: &Chrome) -> impl Fn(&gpui::ScrollEvent, &mut Window, &mut App) + 'static {
    let emit = c.emit.clone();
    let window_id = c.window.id.clone();
    let order = c.state.profile_order.clone();
    let current = c.window.profile_id.clone();
    let width = c.layout.sidebar_width;
    let enabled = c.window.kind != WindowKind::Incognito && order.len() > 1;
    let host = std::sync::Arc::clone(c.host);
    move |event, window, cx| {
        if !enabled {
            return;
        }
        let now = Instant::now();
        let index = order.iter().position(|id| *id == current).unwrap_or(0);
        let (dx, dy) = match event.delta {
            ScrollDelta::Pixels(delta) => {
                (crate::scale::points(delta.x), crate::scale::points(delta.y))
            }
            ScrollDelta::Lines(lines) => (lines.x, lines.y),
        };
        if event.momentum_phase != gpui::ScrollPhase::None
            && event.gesture_phase == gpui::ScrollPhase::None
        {
            with_pager(window_id.as_str(), |pager| {
                if matches!(
                    event.momentum_phase,
                    gpui::ScrollPhase::Ended | gpui::ScrollPhase::Cancelled
                ) {
                    pager.momentum_ended();
                }
            });
            return;
        }
        let gesture = match event.gesture_phase {
            gpui::ScrollPhase::MayBegin => Some(Phase::Prepare),
            gpui::ScrollPhase::Began => Some(Phase::Started),
            gpui::ScrollPhase::Changed | gpui::ScrollPhase::Stationary => Some(Phase::Moved),
            gpui::ScrollPhase::Ended => Some(Phase::Ended),
            gpui::ScrollPhase::Cancelled => Some(Phase::Cancelled),
            gpui::ScrollPhase::None => match (event.delta, event.touch_phase) {
                (ScrollDelta::Pixels(_), TouchPhase::Started) => Some(Phase::Started),
                (ScrollDelta::Pixels(_), TouchPhase::Ended) => Some(Phase::Ended),
                (ScrollDelta::Pixels(_), TouchPhase::Moved)
                    if with_pager(window_id.as_str(), |pager| pager.tracking()) =>
                {
                    Some(Phase::Moved)
                }
                _ => None,
            },
        };
        let wheel = gesture.is_none();
        let target = match gesture {
            Some(phase) => {
                let (outcome, moving) = with_pager(window_id.as_str(), |pager| {
                    let outcome =
                        pager.swipe_at(phase, dx, dy, width, order.len(), now, event.timestamp);
                    (outcome, pager.moving())
                });
                if outcome.detent {
                    host.haptic_alignment();
                }
                if moving || matches!(phase, Phase::Ended | Phase::Cancelled) {
                    window.refresh();
                }
                outcome.target
            }
            None => {
                if dx.abs() <= dy.abs() {
                    return;
                }
                with_pager(window_id.as_str(), |pager| pager.wheel(dx, now)).and_then(|step| {
                    let next = index as i64 + i64::from(step);
                    usize::try_from(next).ok().filter(|n| *n < order.len())
                })
            }
        };
        let Some(target) = target.filter(|target| *target != index) else {
            return;
        };
        let Some(profile) = order.get(target) else {
            return;
        };
        with_pager(window_id.as_str(), |pager| {
            if wheel {
                pager.page_to(profile, target, now, true);
            } else {
                pager.note_switch(profile);
            }
        });
        emit.send(
            Msg::Store(ardia_state::Action::SwitchProfile {
                window: window_id.clone(),
                profile: profile.clone(),
            }),
            window,
            cx,
        );
        window.refresh();
    }
}

type SwipeHandler = std::rc::Rc<dyn Fn(&gpui::ScrollEvent, &mut Window, &mut App)>;

fn stray_gestures(window_key: String, swipe: SwipeHandler) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .child(
            gpui::canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let window_key = window_key.clone();
                    let swipe = swipe.clone();
                    window.on_mouse_event(move |event: &gpui::ScrollEvent, phase, window, cx| {
                        if !phase.bubble() || bounds.contains(&event.position) {
                            return;
                        }
                        let engaged = with_pager(&window_key, |pager| pager.engaged());
                        if engaged {
                            if crate::sidebar::pager::stray_phase(
                                event.gesture_phase,
                                event.touch_phase,
                            )
                            .is_none()
                            {
                                return;
                            }
                            let mut stray = event.clone();
                            if matches!(
                                stray.gesture_phase,
                                gpui::ScrollPhase::MayBegin | gpui::ScrollPhase::Began
                            ) {
                                stray.gesture_phase = gpui::ScrollPhase::Cancelled;
                            }
                            swipe(&stray, window, cx);
                        } else if event.gesture_phase == gpui::ScrollPhase::None
                            && matches!(
                                event.momentum_phase,
                                gpui::ScrollPhase::Ended | gpui::ScrollPhase::Cancelled
                            )
                        {
                            swipe(event, window, cx);
                        }
                    });
                },
            )
            .size_full(),
        )
        .into_any_element()
}

pub fn sidebar_body(c: &Chrome) -> AnyElement {
    let now = Instant::now();
    let arc = c.layout.sidebar_field;
    let index = paging_index(c);
    let window_key = c.window.id.as_str().to_owned();
    let (position, pager_moving) = with_pager(&window_key, |pager| {
        let position = pager.sync(&c.window.profile_id, index, now);
        (position, pager.animating())
    });
    let field = if arc {
        ARC_FIELD_ROW + ARC_FIELD_GAP
    } else {
        0.0
    };
    let page_height = (c.layout.height - c.layout.header - field - footer_height(c)).max(0.0);
    let moving = pager_moving || footer_moving(&window_key, now);
    let swipe: SwipeHandler = std::rc::Rc::new(swipe_handler(c));
    div()
        .id("sidebar-body")
        .size_full()
        .flex()
        .flex_col()
        .px(px(sidebar::INSET))
        .text_color(c.p.text)
        .on_scroll({
            let swipe = swipe.clone();
            move |event, window, cx| swipe(event, window, cx)
        })
        .child(stray_gestures(window_key, swipe))
        .child(header(c))
        .when(arc, |this| this.child(address_field(c)))
        .child(pages(c, position, index, page_height))
        .children(footer(c, position))
        .child(Frames(moving))
        .child(folders::folder_panel(
            c,
            &c.sections.tiles,
            c.layout.first_row_top,
        ))
        .children(drag::pin_slot_overlay(c))
        .into_any_element()
}

pub fn docked_sidebar(c: &Chrome, rect: Rect) -> AnyElement {
    div()
        .id("sidebar")
        .debug_selector(|| "sidebar".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .child(sidebar_body(c))
        .into_any_element()
}

pub fn floating_sidebar(c: &Chrome, rect: Rect) -> AnyElement {
    let radius = c.layout.frame.peek.radius;
    let emit = c.emit.clone();
    div()
        .id("peek-sidebar")
        .debug_selector(|| "peek-sidebar".into())
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .rounded(px(radius))
        .occlude()
        .border(px(0.5))
        .border_color(crate::primitives::theme_bridge::hsla(
            c.look.theme.roles.panel_border,
        ))
        .shadow(crate::primitives::controls::panel_shadows(c.p))
        .on_hover(move |hovered, window, cx| emit.send(Msg::PeekHover(*hovered), window, cx))
        .map(|this| {
            let window_size = [c.layout.width, c.layout.height];
            let fill = crate::primitives::theme_bridge::themed_fill(
                &c.look.treatment,
                window_size,
                crate::primitives::theme_bridge::vibrancy_under(c.look.dark),
            )
            .reframed(window_size, [rect.x, rect.y], [rect.w, rect.h]);
            this.bg(fill.under)
                .children(fill.layers.iter().map(|layer| {
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(radius))
                        .bg(layer.background())
                }))
        })
        .child(sidebar_body(c))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiles_stay_docked_while_they_fit_two_fifths_of_the_page() {
        assert!(tiles_fit_dock(0, 222.0, 100.0, 8.0));
        assert!(tiles_fit_dock(5, 222.0, 800.0, 8.0));
        assert!(!tiles_fit_dock(40, 222.0, 400.0, 8.0));
        assert_eq!(grid_height(5, 222.0), 2.0 * 41.0 + 6.0);
    }

    #[test]
    fn the_list_keeps_room_above_for_the_selected_row_glow() {
        assert_eq!(list_glow_room(false, 3.0, false), GLOW_ROOM);
        assert_eq!(list_glow_room(true, 3.0, false), 3.0);
        assert_eq!(list_glow_room(true, -2.0, false), 0.0);
        assert_eq!(list_glow_room(false, 0.0, true), TILES_TO_LIST);
        assert_eq!(list_glow_room(true, 0.0, true), 0.0);
    }

    #[test]
    fn the_new_tab_row_docks_with_hysteresis() {
        assert!(docked_after(false, 11.0));
        assert!(!docked_after(false, 12.0));
        assert!(docked_after(true, 0.5));
        assert!(!docked_after(true, 1.0));
    }

    #[test]
    fn field_buttons_follow_hover_and_security() {
        let rest = field_buttons(false, false, false);
        assert!(!rest.leading && !rest.page && !rest.site_controls);
        let hovered = field_buttons(false, true, false);
        assert!(!hovered.leading && hovered.page && hovered.site_controls);
        let insecure = field_buttons(false, true, true);
        assert!(insecure.leading && !insecure.site_controls);
        let always = field_buttons(true, false, false);
        assert!(always.leading && always.page && !always.site_controls);
    }

    #[test]
    fn only_pages_in_view_are_built() {
        assert_eq!(visible_slots(1.0, 4), vec![1]);
        assert_eq!(visible_slots(1.5, 4), vec![1, 2]);
        assert_eq!(visible_slots(-0.2, 4), vec![0]);
    }
}
