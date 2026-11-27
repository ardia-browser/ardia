use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use crate::primitives::tokens::Curve;
use crate::scale::px;
use ardia_engine::DownloadCommand;
use ardia_state::Action;
use ardia_state::downloads::{Download, DownloadState};
use ardia_state::windows::Popover;
use ardia_theme::layout::panel;
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};
use gpui::{Hsla, PathBuilder, canvas};

use crate::msg::{MenuTarget, Msg};
use crate::popovers::context_menu::{MenuEntry, MenuItem, sections};
use crate::primitives::controls::{IconButton, popover, progress_bar, separator};
use crate::primitives::glass_states::{GlassBacking, GlassStates, stateful_glass_in};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::virtual_list::{self, VirtualItem, virtual_list};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const WIDTH: f32 = 300.0;

pub const ROW: f32 = 40.0;
pub const FILE_ICON: f32 = 24.0;
pub const HEADER: f32 = 24.0;
pub const VISIBLE_ROWS: usize = 8;
const PROGRESS_MIN: f32 = 0.03;
const ROW_BUTTON: f32 = 24.0;
const TEXT_BUTTON_PAD: f32 = 8.0;
const INK_INSET: f32 = panel::INSET + 1.0;
const PAD_TOP: f32 = INK_INSET - 7.5;
const PAD_BOTTOM: f32 = INK_INSET - 12.0;

pub fn human_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes < 0.0 {
        return String::new();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes;
    let mut unit = 0;
    while value >= 1000.0 && unit + 1 < units.len() {
        value /= 1000.0;
        unit += 1;
    }
    if value < 10.0 && unit > 0 {
        format!("{value:.1} {}", units[unit])
    } else {
        format!("{} {}", value.round(), units[unit])
    }
}

fn time_left(seconds: f64) -> String {
    if seconds < 60.0 {
        format!("{} sec left", seconds.round().max(1.0))
    } else if seconds < 3600.0 {
        format!("{} min left", (seconds / 60.0).round())
    } else {
        format!("{} hr left", (seconds / 3600.0).round())
    }
}

pub fn awaits_keep(download: &Download) -> bool {
    download.state == DownloadState::Downloading && download.dangerous == Some(true)
}

pub fn danger_warning(download: &Download, short: bool) -> &'static str {
    match (download.url.starts_with("http:"), short) {
        (true, true) => "Blocked: not secure",
        (true, false) => "Insecure download blocked",
        (false, true) => "Blocked: unsafe file type",
        (false, false) => "This type of file can harm your computer",
    }
}

pub fn status_line(download: &Download, exists: bool) -> String {
    match download.state {
        DownloadState::Finished if exists => human_bytes(if download.total > 0.0 {
            download.total
        } else {
            download.received
        }),
        DownloadState::Finished => "Deleted".to_owned(),
        DownloadState::Failed => "Failed to Download".to_owned(),
        DownloadState::Cancelled => "Cancelled".to_owned(),
        DownloadState::Downloading if awaits_keep(download) => {
            danger_warning(download, false).to_owned()
        }
        DownloadState::Downloading => {
            let progress = if download.total > 0.0 {
                format!(
                    "{} of {}",
                    human_bytes(download.received),
                    human_bytes(download.total)
                )
            } else {
                human_bytes(download.received)
            };
            if download.paused {
                return format!("{progress} — Paused");
            }
            if download.speed <= 0.0 {
                return progress;
            }
            let with_speed = format!("{progress}, {}/s", human_bytes(download.speed));
            if download.total > 0.0 {
                format!(
                    "{with_speed} — {}",
                    time_left((download.total - download.received) / download.speed)
                )
            } else {
                with_speed
            }
        }
    }
}

use crate::pages::downloads::file_exists;

fn list_key(window: &ardia_state::WindowId) -> SharedString {
    SharedString::from(format!("downloads-popover:{window}"))
}

fn text_button(
    id: impl Into<SharedString>,
    title: &'static str,
    p: &crate::look::Palette,
    msgs: Vec<Msg>,
    c: &Chrome,
) -> AnyElement {
    let p = *p;
    let emit = c.emit.clone();
    div()
        .id(id.into())
        .h(px(22.))
        .px(px(TEXT_BUTTON_PAD))
        .rounded(px(6.))
        .flex()
        .items_center()
        .text_size(px(12.))
        .text_color(p.text_secondary)
        .cursor_pointer()
        .hover(move |style| style.bg(p.toolbar_hover))
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            for msg in msgs.iter().cloned() {
                emit.send(msg, window, cx);
            }
        })
        .child(title)
        .into_any_element()
}

fn row_button(
    c: &Chrome,
    id: String,
    glyph: Icon,
    tooltip: &'static str,
    msg: Msg,
) -> impl IntoElement {
    IconButton::new(SharedString::from(id), glyph, c.p)
        .square(ROW_BUTTON, 6.)
        .glyph(panel::ICON_SIZE)
        .tooltip(tooltip, c.p)
        .on_click(c.emit.click(msg))
}

fn row(c: &Chrome, download: &Download) -> AnyElement {
    let p = c.p;
    let id = download.id.to_string();
    let exists = file_exists(download);
    let done = download.state == DownloadState::Finished && exists;
    let blocked = awaits_keep(download);
    let downloading = download.state == DownloadState::Downloading;
    let name = if download.filename.is_empty() {
        SharedString::new_static("Preparing…")
    } else {
        SharedString::from(download.filename.clone())
    };
    let progress = if download.total > 0.0 {
        (download.received / download.total) as f32
    } else {
        0.0
    };
    let group = SharedString::from(format!("download-row:{id}"));
    let reveal = if cfg!(target_os = "macos") {
        "Show in Finder"
    } else {
        "Show in File Explorer"
    };
    div()
        .id(SharedString::from(format!("download:{id}")))
        .group(group.clone())
        .h(px(ROW))
        .px(px(panel::ROW_PADDING))
        .rounded(px(panel::ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .map(|this| {
            if c.look.glass {
                this.relative().child(stateful_glass_in(
                    group.clone(),
                    c.look,
                    panel::ROW_RADIUS,
                    if done {
                        GlassStates::ROW
                    } else {
                        GlassStates::LIT_ROW
                    },
                    GlassBacking::Native,
                ))
            } else {
                this.hover(move |style| style.bg(p.menu_hover))
                    .when(done, |this| {
                        this.active(move |style| style.bg(p.popover_row_pressed))
                    })
            }
        })
        .when(done, |this| {
            this.on_click(c.emit.click(Msg::OpenPath(download.path.clone())))
        })
        .on_mouse_down(gpui::MouseButton::Right, {
            let emit = c.emit.clone();
            let id = id.clone();
            move |event, window, cx| {
                cx.stop_propagation();
                emit.send(
                    Msg::Menu(Some((MenuTarget::Download(id.clone()), event.position))),
                    window,
                    cx,
                );
            }
        })
        .child(
            div()
                .flex_none()
                .size(px(FILE_ICON))
                .flex()
                .items_center()
                .justify_center()
                .opacity(if exists { 1.0 } else { 0.45 })
                .child(
                    match c.host.file_icon(
                        if !download.path.is_empty() {
                            &download.path
                        } else if !download.filename.is_empty() {
                            &download.filename
                        } else {
                            "file.bin"
                        },
                        FILE_ICON,
                    ) {
                        Some(image) => gpui::img(image)
                            .size(px(FILE_ICON))
                            .object_fit(gpui::ObjectFit::Contain)
                            .into_any_element(),
                        None => icon(Icon::Copy, FILE_ICON * 0.62, p.icon).into_any_element(),
                    },
                ),
        )
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
                        .text_color(if exists { p.text } else { p.text_secondary })
                        .when(!exists, |this| this.line_through())
                        .truncate()
                        .child(name),
                )
                .when(downloading && !blocked, |this| {
                    this.child(div().mt(px(4.)).mb(px(2.)).child(progress_bar(
                        progress.max(PROGRESS_MIN),
                        p.progress_track.opacity(0.4),
                        if download.paused {
                            p.text_tertiary
                        } else {
                            p.accent
                        },
                    )))
                })
                .child(
                    div()
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .text_color(if blocked {
                            p.destructive
                        } else {
                            p.text_secondary
                        })
                        .truncate()
                        .child(if blocked {
                            danger_warning(download, true).to_owned()
                        } else {
                            status_line(download, exists)
                        }),
                ),
        )
        .when(blocked, |this| {
            this.child(
                div()
                    .flex()
                    .mr(px(-TEXT_BUTTON_PAD))
                    .child(text_button(
                        format!("download-keep:{id}"),
                        "Keep",
                        p,
                        vec![Msg::Download {
                            id: id.clone(),
                            command: DownloadCommand::Keep,
                        }],
                        c,
                    ))
                    .child(text_button(
                        format!("download-discard:{id}"),
                        "Discard",
                        p,
                        vec![Msg::Download {
                            id: id.clone(),
                            command: DownloadCommand::Cancel,
                        }],
                        c,
                    )),
            )
        })
        .when(downloading && !blocked, |this| {
            let toggle = if download.paused {
                (Icon::Play, DownloadCommand::Resume, "Resume")
            } else {
                (Icon::Pause, DownloadCommand::Pause, "Pause")
            };
            this.child(
                div()
                    .flex()
                    .mr(px(-(ROW_BUTTON - panel::ICON_SIZE) / 2.0))
                    .child(row_button(
                        c,
                        format!("download-toggle:{id}"),
                        toggle.0,
                        toggle.2,
                        Msg::Download {
                            id: id.clone(),
                            command: toggle.1,
                        },
                    ))
                    .child(row_button(
                        c,
                        format!("download-cancel:{id}"),
                        Icon::XMark,
                        "Cancel",
                        Msg::Download {
                            id: id.clone(),
                            command: DownloadCommand::Cancel,
                        },
                    )),
            )
        })
        .when(done, |this| {
            this.child(
                div()
                    .flex_none()
                    .w(px(ROW_BUTTON))
                    .mr(px(-(ROW_BUTTON - panel::ICON_SIZE) / 2.0))
                    .opacity(0.0)
                    .group_hover(group, |style| style.opacity(1.0))
                    .child(row_button(
                        c,
                        format!("download-reveal:{id}"),
                        Icon::Search,
                        reveal,
                        Msg::Reveal(download.path.clone()),
                    )),
            )
        })
        .into_any_element()
}

pub const MARGIN: f32 = 8.0;
pub const ARROW_HEIGHT: f32 = 9.0;
pub const ARROW_GAP: f32 = 1.0;
const FALLBACK_TOP: f32 = 44.0;
const FALLBACK_SIDEBAR_LEFT: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub width: f32,
    pub left: f32,
    pub top: Option<f32>,
    pub bottom: Option<f32>,
    pub room: f32,
}

pub fn place(
    viewport: (f32, f32),
    anchor: Option<Rect>,
    top_strip: bool,
    sidebar_right: bool,
) -> Placement {
    let (vw, vh) = viewport;
    let width = WIDTH.min(vw - MARGIN * 2.0).max(0.0);
    let inside = anchor.filter(|a| {
        a.w > 0.0 && a.h > 0.0 && a.x >= 0.0 && a.y >= 0.0 && a.right() <= vw && a.y + a.h <= vh
    });
    let Some(anchor) = inside else {
        let left = if top_strip {
            MARGIN.max(vw - MARGIN - width)
        } else if sidebar_right {
            MARGIN.max(vw - FALLBACK_SIDEBAR_LEFT - width)
        } else {
            FALLBACK_SIDEBAR_LEFT
        };
        return Placement {
            width,
            left,
            top: Some(FALLBACK_TOP),
            bottom: None,
            room: vh - FALLBACK_TOP - MARGIN,
        };
    };
    let centre = anchor.x + anchor.w / 2.0;
    let left = MARGIN.max((centre - width / 2.0).min(vw - MARGIN - width));
    if anchor.y + anchor.h / 2.0 > vh / 2.0 {
        return Placement {
            width,
            left,
            top: None,
            bottom: Some(vh - anchor.y + ARROW_GAP),
            room: anchor.y - ARROW_GAP - ARROW_HEIGHT - MARGIN,
        };
    }
    let top = anchor.y + anchor.h + ARROW_GAP;
    Placement {
        width,
        left,
        top: Some(top),
        bottom: None,
        room: vh - top - ARROW_HEIGHT - MARGIN,
    }
}

fn button_rect(c: &Chrome) -> Option<Rect> {
    use crate::sidebar::header::{DOWNLOADS_SIZE, HEADER_RIGHT, footer_downloads_inset};
    let size = DOWNLOADS_SIZE;
    if let Some(strip) = c.layout.strip {
        let x = strip.x + strip.w - 8.0 - size;
        return Some(Rect::new(
            x,
            strip.y + strip.h / 2.0 - size / 2.0,
            size,
            size,
        ));
    }
    let sidebar = c.layout.sidebar?;
    if crate::sidebar::header::downloads_in_footer(c) {
        let inset = footer_downloads_inset();
        return Some(Rect::new(
            sidebar.x + inset,
            sidebar.y + sidebar.h - inset - size,
            size,
            size,
        ));
    }
    let centre =
        ardia_theme::layout::lights::center(c.layout.frame.inset, c.state.settings.compact_toolbar)
            [1];
    Some(Rect::new(
        sidebar.x + sidebar.w - HEADER_RIGHT - size,
        centre - size / 2.0,
        size,
        size,
    ))
}

pub fn placement_for(c: &Chrome) -> Placement {
    place(
        (c.layout.width, c.layout.height),
        button_rect(c),
        c.layout.strip.is_some(),
        c.state.sidebar_side(c.window.id.as_str()) == ardia_state::model::SidebarSide::Right,
    )
}

pub fn anchor(c: &Chrome) -> (f32, f32) {
    let placed = placement_for(c);
    (placed.left, placed.top.unwrap_or(c.layout.header))
}

pub const OPEN_MS: f32 = 150.0;
pub const CLOSE_MS: f32 = 100.0;
pub const FLIGHT_MS: f32 = 400.0;
pub const ARROW_WIDTH: f32 = 20.0;
const FLIGHT_ICON: f32 = 44.0;
const FLIGHT_ARC: f32 = 90.0;
const FLIGHT_START_SHARE: f32 = 0.45;
const SHIFT: f32 = 4.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Flight {
    pub id: String,
    pub path: String,
    pub since: Instant,
}

#[derive(Debug, Default)]
pub struct Motion {
    shown: bool,
    from: f32,
    since: Option<Instant>,
    seen: Option<HashSet<String>>,
    seen_list: Option<Arc<ardia_state::downloads::DownloadList>>,
    pub flight: Option<Flight>,
}

impl Motion {
    pub fn appear(&self, now: Instant) -> f32 {
        let target = if self.shown { 1.0 } else { 0.0 };
        let Some(since) = self.since else {
            return target;
        };
        let (span, curve) = if self.shown {
            (OPEN_MS, Curve::Enter)
        } else {
            (CLOSE_MS, Curve::Exit)
        };
        let t = now.saturating_duration_since(since).as_secs_f32() * 1000.0 / span;
        self.from + (target - self.from) * curve.ease(t)
    }

    fn flight_progress(&self, now: Instant) -> Option<f32> {
        let flight = self.flight.as_ref()?;
        let t = now.saturating_duration_since(flight.since).as_secs_f32() * 1000.0 / FLIGHT_MS;
        (t < 1.0).then_some(t)
    }

    pub fn running(&self, now: Instant) -> bool {
        let appear = self.appear(now);
        let target = if self.shown { 1.0 } else { 0.0 };
        (appear - target).abs() > f32::EPSILON || self.flight_progress(now).is_some()
    }

    pub fn update(
        &mut self,
        open: bool,
        state: &ardia_state::BrowserState,
        window: &ardia_state::WindowId,
        focused: bool,
        now: Instant,
    ) {
        if open != self.shown {
            self.from = self.appear(now);
            self.shown = open;
            self.since = Some(now);
            if open {
                virtual_list::forget(&list_key(window));
            }
        }
        if self.flight_progress(now).is_none() {
            self.flight = None;
        }
        if self
            .seen_list
            .as_ref()
            .is_some_and(|seen| Arc::ptr_eq(seen, &state.downloads))
        {
            return;
        }
        self.seen_list = Some(Arc::clone(&state.downloads));
        let ids: HashSet<String> = state
            .downloads
            .items()
            .iter()
            .map(|d| d.id.to_string())
            .collect();
        if let Some(seen) = &self.seen {
            let fresh = state
                .downloads
                .items()
                .iter()
                .find(|d| !seen.contains(&d.id.to_string()));
            if let Some(fresh) = fresh
                && focused
                && crate::pages::downloads::download_visible_in(state, fresh, window)
            {
                self.flight = Some(Flight {
                    id: fresh.id.to_string(),
                    path: if fresh.path.is_empty() {
                        fresh.filename.clone()
                    } else {
                        fresh.path.clone()
                    },
                    since: now,
                });
            }
        }
        if self.flight_progress(now).is_none() {
            self.flight = None;
        }
        self.seen = Some(ids);
    }
}

fn keyframes(stops: &[(f32, f32)], at: f32) -> f32 {
    let mut previous = stops[0];
    for &stop in stops {
        if at <= stop.0 {
            let span = (stop.0 - previous.0).max(f32::EPSILON);
            return previous.1 + (stop.1 - previous.1) * ((at - previous.0) / span).clamp(0.0, 1.0);
        }
        previous = stop;
    }
    previous.1
}

pub fn flight_frame(start: (f32, f32), target: (f32, f32), t: f32) -> (f32, f32, f32, f32) {
    let p = Curve::Move.ease(t);
    let x = start.0 + (target.0 - start.0) * p;
    let y = start.1 + (target.1 - start.1) * p - (std::f32::consts::PI * p).sin() * FLIGHT_ARC;
    let opacity = keyframes(&[(0.0, 0.0), (0.1, 1.0), (0.8, 1.0), (1.0, 0.0)], p);
    let scale = keyframes(&[(0.0, 0.6), (0.15, 1.1), (1.0, 0.3)], p);
    (x, y, opacity, scale)
}

pub fn flight(c: &Chrome, motion: &Motion, now: Instant) -> Option<AnyElement> {
    let t = motion.flight_progress(now)?;
    let flight = motion.flight.as_ref()?;
    let (w, h) = (c.layout.width, c.layout.height);
    let right =
        c.state.sidebar_side(c.window.id.as_str()) == ardia_state::model::SidebarSide::Right;
    let sidebar = if c.layout.strip.is_none() {
        c.layout.sidebar.map_or(0.0, |s| s.w)
    } else {
        0.0
    };
    let start = (
        if right { 0.0 } else { sidebar } + (w - sidebar) / 2.0,
        h * FLIGHT_START_SHARE,
    );
    let target = button_rect(c).map_or((if right { w - 24.0 } else { 24.0 }, 24.0), |b| {
        (b.x + b.w / 2.0, b.y + b.h / 2.0)
    });
    let (x, y, opacity, scale) = flight_frame(start, target, t);
    let side = FLIGHT_ICON * scale;
    let glyph: AnyElement = match c.host.file_icon(&flight.path, FLIGHT_ICON) {
        Some(image) => gpui::img(image)
            .size(px(side))
            .object_fit(gpui::ObjectFit::Contain)
            .into_any_element(),
        None => icon(Icon::Copy, side * 0.62, c.p.icon).into_any_element(),
    };
    Some(
        div()
            .absolute()
            .left(px(x - side / 2.0))
            .top(px(y - side / 2.0))
            .size(px(side))
            .flex()
            .items_center()
            .justify_center()
            .opacity(opacity)
            .debug_selector(|| "download-flight".into())
            .child(glyph)
            .into_any_element(),
    )
}

fn arrow(fill: Hsla, edge: Hsla, up: bool, x: f32) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let o = bounds.origin;
            let unit = |dx: f32, dy: f32| gpui::point(o.x + px(dx), o.y + px(dy));
            let (tip, base) = if up {
                (0.0, ARROW_HEIGHT + 0.5)
            } else {
                (ARROW_HEIGHT, -0.5)
            };
            let mut builder = PathBuilder::fill();
            builder.move_to(unit(0.0, base));
            builder.line_to(unit(ARROW_WIDTH / 2.0, tip));
            builder.line_to(unit(ARROW_WIDTH, base));
            builder.close();
            if let Ok(path) = builder.build() {
                window.paint_path(path, fill);
            }
            let mut rim = PathBuilder::stroke(px(0.5));
            rim.move_to(unit(0.0, base));
            rim.line_to(unit(ARROW_WIDTH / 2.0, tip));
            rim.line_to(unit(ARROW_WIDTH, base));
            if let Ok(path) = rim.build() {
                window.paint_path(path, edge);
            }
        },
    )
    .absolute()
    .left(px(x - ARROW_WIDTH / 2.0))
    .when(up, |this| this.top(px(-ARROW_HEIGHT)))
    .when(!up, |this| this.bottom(px(-ARROW_HEIGHT)))
    .w(px(ARROW_WIDTH))
    .h(px(ARROW_HEIGHT))
}

pub const SHRUNK: f32 = 0.94;

pub fn appear_scale(appear: f32) -> f32 {
    SHRUNK + (1.0 - SHRUNK) * appear.clamp(0.0, 1.0)
}

pub fn scale_about(scale: f32, origin: (f32, f32), size: (f32, f32)) -> (f32, f32) {
    (
        (1.0 - scale) * (origin.0 - size.0 / 2.0),
        (1.0 - scale) * (origin.1 - size.1 / 2.0),
    )
}

pub fn downloads(c: &Chrome, appear: f32) -> AnyElement {
    let p = c.p;
    let placed = placement_for(c);
    let upward = placed.bottom.is_some();
    let arrow_x = button_rect(c).map_or(placed.width / 2.0, |b| b.x + b.w / 2.0 - placed.left);
    let shift = if upward { SHIFT } else { -SHIFT } * (1.0 - appear);
    let shown = crate::pages::downloads::shown_downloads(c.state, &c.window.id);
    let (items, keys) = (shown.items, shown.keys);
    let clearable = items.iter().any(|d| d.state != DownloadState::Downloading);
    let chrome_height =
        PAD_TOP + HEADER + 0.5 + panel::SEPARATOR_GAP * 2.0 + panel::ROW_HEIGHT + PAD_BOTTOM;
    let list_max = ROW.max((VISIBLE_ROWS as f32 * ROW).min(placed.room - chrome_height));
    let list = if items.is_empty() {
        panel::ROW_HEIGHT
    } else {
        (items.len() as f32 * ROW).min(list_max)
    };
    let height = chrome_height + list;
    let scale = appear_scale(appear);
    let (dx, dy) = scale_about(
        scale,
        (
            arrow_x,
            if upward {
                height + ARROW_HEIGHT
            } else {
                -ARROW_HEIGHT
            },
        ),
        (placed.width, height),
    );
    popover("downloads-popover", c.look.glass, placed.width, p)
        .debug_selector(|| "downloads-popover".into())
        .absolute()
        .left(px(placed.left + dx))
        .opacity(appear)
        .scale(scale)
        .when_some(placed.top, |this, top| {
            this.top(px(top + ARROW_HEIGHT + shift + dy))
        })
        .when_some(placed.bottom, |this, bottom| {
            this.bottom(px(bottom + ARROW_HEIGHT - shift - dy))
        })
        .when(button_rect(c).is_some(), |this| {
            this.child(arrow(
                if c.look.glass {
                    p.popover_fill.opacity(0.9)
                } else {
                    p.popover_fill
                },
                p.popover_border,
                !upward,
                arrow_x,
            ))
        })
        .py(px(0.))
        .pt(px(PAD_TOP))
        .pb(px(PAD_BOTTOM))
        .child(
            div()
                .h(px(HEADER))
                .pl(px(panel::INSET))
                .pr(px(panel::INSET - TEXT_BUTTON_PAD))
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .text_size(px(11.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text_secondary)
                        .child("RECENT DOWNLOADS"),
                )
                .when(clearable, |this| {
                    this.child(text_button(
                        "downloads-clear",
                        "Clear",
                        p,
                        vec![
                            Msg::TogglePopover(Popover::Downloads),
                            Msg::Store(Action::ClearDownloads),
                        ],
                        c,
                    ))
                }),
        )
        .when(items.is_empty(), |this| {
            this.child(
                div()
                    .h(px(panel::ROW_HEIGHT))
                    .px(px(panel::INSET))
                    .flex()
                    .items_center()
                    .text_size(px(13.))
                    .text_color(p.text_secondary)
                    .child("No downloads yet"),
            )
        })
        .when(!items.is_empty(), |this| {
            let key = list_key(&c.window.id);
            let handle = virtual_list::scroll_handle(key.clone());
            let rows = virtual_list(key, &handle)
                .items(keys.iter().map(|key| VirtualItem::new(key.clone(), ROW)))
                .render(|ix, _| row(c, &items[ix]));
            this.child(
                div()
                    .id("downloads-list")
                    .max_h(px(list_max))
                    .overflow_y_scroll()
                    .track_scroll(&handle)
                    .px(px(panel::ROW_INSET))
                    .child(rows),
            )
        })
        .child(separator(p))
        .child(view_all(c))
        .into_any_element()
}

fn view_all(c: &Chrome) -> AnyElement {
    let emit = c.emit.clone();
    let window = c.window.id.clone();
    let url = crate::pages::PageKind::Downloads.page().url();
    let open = match crate::pages::plan_open(c.state, &window, crate::pages::PageKind::Downloads) {
        crate::pages::OpenPlan::Activate(tab) => Msg::Store(Action::ActivateTab { tab }),
        crate::pages::OpenPlan::NavigateIn(tab) => Msg::Navigate { tab, input: url },
        crate::pages::OpenPlan::NewTab => Msg::Store(Action::NewTab {
            window,
            tab: ardia_state::NewTab {
                url: Some(url),
                ..ardia_state::NewTab::default()
            },
        }),
    };
    let p = *c.p;
    div()
        .px(px(panel::ROW_INSET))
        .child(
            div()
                .id("downloads-view-all")
                .debug_selector(|| "downloads-view-all".into())
                .group("downloads-view-all")
                .h(px(panel::ROW_HEIGHT))
                .px(px(panel::ROW_PADDING))
                .rounded(px(panel::ROW_RADIUS))
                .flex()
                .items_center()
                .cursor_pointer()
                .map(|this| {
                    if c.look.glass {
                        this.relative().child(stateful_glass_in(
                            SharedString::new_static("downloads-view-all"),
                            c.look,
                            panel::ROW_RADIUS,
                            GlassStates::ROW,
                            GlassBacking::Native,
                        ))
                    } else {
                        this.hover(move |style| style.bg(p.menu_hover))
                            .active(move |style| style.bg(p.popover_row_pressed))
                    }
                })
                .on_click(move |_, window, cx| {
                    emit.send(Msg::TogglePopover(Popover::Downloads), window, cx);
                    emit.send(open.clone(), window, cx);
                })
                .child(
                    div()
                        .flex_1()
                        .text_size(px(13.))
                        .text_color(p.text_secondary)
                        .group_hover("downloads-view-all", move |style| style.text_color(p.text))
                        .child("View all downloads"),
                )
                .child(
                    div()
                        .size(px(12.))
                        .mr(px(-3.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(Icon::ChevronRight, 9., p.text_tertiary)),
                ),
        )
        .into_any_element()
}

pub fn downloads_button_menu(
    state: &ardia_state::BrowserState,
    window: &ardia_state::WindowId,
) -> Vec<MenuEntry> {
    let clearable = state
        .downloads
        .items()
        .iter()
        .any(|d| d.state != DownloadState::Downloading);
    sections(vec![
        vec![
            MenuItem::new("downloads:show", "Show Downloads")
                .icon(Icon::ArrowDownCircle)
                .shortcut(crate::keybindings::hint(state, "downloads"))
                .msg(Msg::Store(Action::SetPopover {
                    window: window.clone(),
                    popover: Some(Popover::Downloads),
                }))
                .entry(),
        ],
        vec![
            MenuItem::new("downloads:clear", "Clear Downloads")
                .icon(Icon::XMark)
                .enabled(clearable)
                .msg(Msg::Count("downloads_menu_clears"))
                .msg(Msg::CloseOverlays)
                .msg(Msg::Store(Action::ClearDownloads))
                .entry(),
        ],
    ])
}

pub fn download_menu(download: &Download, opens_when_done: bool) -> Vec<MenuEntry> {
    let id = download.id.to_string();
    let command = |command: DownloadCommand| Msg::Download {
        id: id.clone(),
        command,
    };
    let downloading = download.state == DownloadState::Downloading;
    let exists = download.state == DownloadState::Finished && file_exists(download);
    let lead = if awaits_keep(download) {
        vec![
            MenuItem::new("keep", "Keep")
                .icon(Icon::CheckCircleFill)
                .msg(command(DownloadCommand::Keep))
                .entry(),
            MenuItem::new("cancel", "Discard")
                .icon(Icon::XMark)
                .msg(command(DownloadCommand::Cancel))
                .entry(),
        ]
    } else if downloading {
        vec![
            MenuItem::new("whenDone", "Open When Done")
                .checked(opens_when_done)
                .msg(Msg::ToggleOpenWhenDone(id.clone()))
                .entry(),
            if download.paused {
                MenuItem::new("resume", "Resume")
                    .icon(Icon::Play)
                    .msg(command(DownloadCommand::Resume))
            } else {
                MenuItem::new("pause", "Pause")
                    .icon(Icon::Pause)
                    .msg(command(DownloadCommand::Pause))
            }
            .entry(),
            MenuItem::new("cancel", "Cancel")
                .icon(Icon::XMark)
                .msg(command(DownloadCommand::Cancel))
                .entry(),
        ]
    } else {
        vec![
            MenuItem::new("open", "Open")
                .icon(Icon::Share)
                .enabled(exists)
                .msg(Msg::OpenPath(download.path.clone()))
                .entry(),
            MenuItem::new(
                "reveal",
                if cfg!(target_os = "macos") {
                    "Show in Finder"
                } else {
                    "Show in File Explorer"
                },
            )
            .icon(Icon::Folder)
            .enabled(exists)
            .msg(Msg::Reveal(download.path.clone()))
            .entry(),
        ]
    };
    sections(vec![
        lead,
        vec![
            MenuItem::new("copy", "Copy Link")
                .icon(Icon::Link)
                .enabled(!download.url.is_empty())
                .msg(Msg::Copy(download.url.clone()))
                .entry(),
        ],
        vec![
            MenuItem::new("remove", "Remove from List")
                .icon(Icon::Minus)
                .enabled(!downloading)
                .msg(Msg::Store(Action::RemoveDownload { id: id.clone() }))
                .entry(),
        ]
        .into_iter()
        .chain(exists.then(|| {
            MenuItem::new(
                "trash",
                if cfg!(target_os = "macos") {
                    "Move to Trash"
                } else {
                    "Move to Recycle Bin"
                },
            )
            .icon(Icon::Trash)
            .msg(Msg::TrashDownload {
                id: id.clone(),
                path: download.path.clone(),
            })
            .entry()
        }))
        .collect(),
    ])
}

pub fn placement(c: &Chrome) -> Rect {
    let placed = placement_for(c);
    Rect::new(
        placed.left,
        placed.top.unwrap_or(c.layout.header),
        placed.width,
        0.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn download(state: DownloadState) -> Download {
        serde_json::from_value(serde_json::json!({
            "id": "d1",
            "url": "https://example.com/a.zip",
            "filename": "a.zip",
            "path": "/nonexistent/a.zip",
            "state": state.key(),
            "received": 1_500_000.0,
            "total": 3_000_000.0,
        }))
        .expect("download")
    }

    #[test]
    fn status_lines_match_the_old_popover() {
        let mut d = download(DownloadState::Downloading);
        assert_eq!(status_line(&d, true), "1.5 MB of 3.0 MB");
        d.speed = 500_000.0;
        assert_eq!(
            status_line(&d, true),
            "1.5 MB of 3.0 MB, 500 KB/s — 3 sec left"
        );
        d.paused = true;
        assert_eq!(status_line(&d, true), "1.5 MB of 3.0 MB — Paused");
        d.dangerous = Some(true);
        assert!(awaits_keep(&d));
        assert_eq!(
            status_line(&d, true),
            "This type of file can harm your computer"
        );
        assert_eq!(danger_warning(&d, true), "Blocked: unsafe file type");
        assert_eq!(
            status_line(&download(DownloadState::Finished), true),
            "3.0 MB"
        );
        assert_eq!(
            status_line(&download(DownloadState::Finished), false),
            "Deleted"
        );
        assert_eq!(
            status_line(&download(DownloadState::Failed), true),
            "Failed to Download"
        );
    }

    #[test]
    fn the_downloads_button_menu_offers_show_and_clear() {
        let state = ardia_state::BrowserState::default();
        let menu = downloads_button_menu(&state, &ardia_state::WindowId::new("w"));
        assert_eq!(
            crate::popovers::context_menu::titles(&menu),
            ["Show Downloads", "-", "Clear Downloads"]
        );
    }

    #[test]
    fn the_download_menu_follows_its_state() {
        let titles = |d: &Download| crate::popovers::context_menu::titles(&download_menu(d, false));
        assert_eq!(
            titles(&download(DownloadState::Downloading)),
            [
                "Open When Done",
                "Pause",
                "Cancel",
                "-",
                "Copy Link",
                "-",
                "Remove from List"
            ]
        );
        let mut held = download(DownloadState::Downloading);
        held.dangerous = Some(true);
        assert_eq!(titles(&held)[..2], ["Keep", "Discard"]);
        assert_eq!(
            titles(&download(DownloadState::Finished))[..2],
            ["Open", "Show in Finder"]
        );
    }

    #[test]
    fn the_panel_hangs_under_its_button_like_the_old_placement() {
        let button = Rect::new(196.0, 7.0, 34.0, 34.0);
        let placed = place((1512.0, 859.0), Some(button), false, false);
        assert_eq!(placed.width, 300.0);
        assert_eq!(placed.left, 63.0);
        assert_eq!(placed.top, Some(42.0));
        let low = place(
            (1512.0, 859.0),
            Some(Rect::new(10.0, 800.0, 34.0, 34.0)),
            false,
            false,
        );
        assert_eq!(low.left, 8.0);
        assert_eq!(low.bottom, Some(60.0));
        let lost = place((1512.0, 859.0), None, false, false);
        assert_eq!((lost.left, lost.top), (10.0, Some(44.0)));
    }

    #[test]
    fn the_flight_arcs_up_and_fades_like_the_magnet() {
        let start = (500.0, 400.0);
        let target = (200.0, 24.0);
        let (x, y, opacity, scale) = flight_frame(start, target, 0.0);
        assert_eq!((x, y, opacity), (500.0, 400.0, 0.0));
        assert!((scale - 0.6).abs() < 1e-4);
        let (_, mid_y, mid_opacity, _) = flight_frame(start, target, 0.5);
        assert!(mid_y < 212.0 - 80.0);
        assert_eq!(mid_opacity, 1.0);
        let (x, y, opacity, scale) = flight_frame(start, target, 1.0);
        assert!((x - 200.0).abs() < 1e-3 && (y - 24.0).abs() < 1e-3);
        assert_eq!(opacity, 0.0);
        assert!((scale - 0.3).abs() < 1e-4);
    }

    #[test]
    fn the_popover_opens_in_150ms_and_closes_in_100ms() {
        let state = ardia_state::BrowserState::default();
        let window = ardia_state::WindowId::new("w");
        let start = Instant::now();
        let mut motion = Motion::default();
        motion.update(true, &state, &window, true, start);
        assert_eq!(motion.appear(start), 0.0);
        let half = start + std::time::Duration::from_millis(75);
        assert!(motion.appear(half) > 0.8);
        assert_eq!(
            motion.appear(start + std::time::Duration::from_millis(150)),
            1.0
        );
        let closing = start + std::time::Duration::from_millis(200);
        motion.update(false, &state, &window, true, closing);
        assert!(motion.running(closing));
        assert_eq!(
            motion.appear(closing + std::time::Duration::from_millis(100)),
            0.0
        );
    }

    #[test]
    fn the_popover_grows_from_its_arrow_tip() {
        assert_eq!(appear_scale(0.0), 0.94);
        assert_eq!(appear_scale(1.0), 1.0);
        assert_eq!(scale_about(1.0, (150.0, -9.0), (300.0, 200.0)), (0.0, 0.0));
        let (dx, dy) = scale_about(0.94, (150.0, -9.0), (300.0, 200.0));
        assert!(dx.abs() < 1e-4);
        assert!((dy - 0.06 * (-109.0)).abs() < 1e-4);
    }

    #[test]
    fn sizes_read_like_finder() {
        assert_eq!(human_bytes(0.0), "0 B");
        assert_eq!(human_bytes(512.0), "512 B");
        assert_eq!(human_bytes(1_234.0), "1.2 KB");
        assert_eq!(human_bytes(12_345.0), "12 KB");
        assert_eq!(human_bytes(250_000_000.0), "250 MB");
        assert_eq!(human_bytes(f64::NAN), "");
    }
}
