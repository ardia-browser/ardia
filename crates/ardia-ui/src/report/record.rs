use std::sync::Arc;

use gpui::{
    AnyElement, App, FontWeight, IntoElement, NativeView, ObjectFit, ParentElement, SharedString,
    Styled, StyledImage, Window, div, img, prelude::*,
};

use crate::host::UiHost;
use crate::look::Palette;
use crate::primitives::controls::{Checkbox, PushButton};
use crate::primitives::icons::Icon;
use crate::scale::px;

use super::state::{Recorded, RecordingState, ReportCommand, ReportView, recording_summary};
use super::{RECORD_HINT, ReportKind, format_bytes, format_duration, tokens};

pub const PAGES_WARNING: &str = "Pages and Picture in Picture videos can show private things like email, messages or bank details. Only include them if nothing sensitive is on screen. Tab names, addresses and what Ardia itself shows about a page, like suggestions and media controls, always show. WebKit pages with audio or video, where streaming services play, stay black. You'll watch it before it's sent.";
pub const PRIVATE_NOTE: &str = "Pages always stay hidden when you record a private window. Tab names and addresses still show.";
pub const LOCKED_NOTE: &str = "Applies to the next recording ·";
pub const SECTION_PAD: f32 = 12.0;
pub const SECTION_GAP: f32 = 10.0;
pub const TILE_RADIUS: f32 = 8.0;

fn small(text: impl Into<SharedString>, color: gpui::Hsla) -> gpui::Div {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(color)
        .child(text.into())
}

fn link(
    id: &'static str,
    title: &'static str,
    color: gpui::Hsla,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .text_size(px(13.))
        .text_color(color)
        .cursor_pointer()
        .hover(|s| s.underline())
        .on_click(move |_, window, cx| on_click(window, cx))
        .child(title)
}

pub fn record_section(
    host: &Arc<dyn UiHost>,
    view: &ReportView,
    player: Option<NativeView>,
    p: &Palette,
) -> AnyElement {
    let recorded = view.recording.recorded().is_some();
    let top = match &view.recording {
        RecordingState::Ready(recording) => recorded_row(host, recording, view.watching, player, p),
        RecordingState::Saving { .. } => div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(crate::primitives::controls::spinner(14., p.text_secondary))
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(p.text_secondary)
                    .child("Saving the recording…"),
            )
            .into_any_element(),
        state => {
            let host = Arc::clone(host);
            let failed = match state {
                RecordingState::Failed { message } => Some(message.clone()),
                _ => None,
            };
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(
                    PushButton::new("report-record", "Record the problem", p)
                        .icon(Icon::RecordCircle)
                        .disabled(state.busy())
                        .on_click(move |_, window, cx| host.report_record(window, cx)),
                )
                .child(div().flex_1().min_w_0().child(small(
                    failed.clone().unwrap_or_else(|| RECORD_HINT.into()),
                    if failed.is_some() {
                        p.destructive
                    } else {
                        p.text_secondary
                    },
                )))
                .into_any_element()
        }
    };
    div()
        .mt(px(12.))
        .rounded(px(12.))
        .bg(p.group_box)
        .border(px(1.))
        .border_color(p.group_stroke)
        .p(px(SECTION_PAD))
        .flex()
        .flex_col()
        .gap(px(SECTION_GAP))
        .child(top)
        .when(view.draft.kind == ReportKind::Slow, |d| {
            d.child(trace_row(host, view, recorded, p))
        })
        .child(pages_choice(host, view, recorded, p))
        .into_any_element()
}

fn recorded_row(
    host: &Arc<dyn UiHost>,
    recording: &Recorded,
    watching: bool,
    player: Option<NativeView>,
    p: &Palette,
) -> AnyElement {
    let summary = recording_summary(recording);
    let actions = {
        let watch = Arc::clone(host);
        let again = Arc::clone(host);
        let remove = Arc::clone(host);
        div()
            .mt(px(4.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(link(
                "report-watch-recording",
                if watching { "Hide" } else { "Watch" },
                p.accent,
                move |_, _| watch.report_command(ReportCommand::SetWatching(!watching)),
            ))
            .child(link(
                "report-record-again",
                "Record again",
                p.accent,
                move |window, cx| again.report_record(window, cx),
            ))
            .child(link(
                "report-remove-recording",
                "Remove",
                p.destructive,
                move |_, _| remove.report_command(ReportCommand::DiscardRecording),
            ))
    };
    if watching {
        return div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .h(px(tokens::PLAYER_HEIGHT))
                    .rounded(px(TILE_RADIUS))
                    .overflow_hidden()
                    .bg(gpui::black())
                    .children(player.map(|view| div().size_full().child(view))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.text)
                            .child(summary),
                    )
                    .child(actions),
            )
            .into_any_element();
    }
    let [tw, th] = tokens::THUMBNAIL;
    let thumbnail = div()
        .relative()
        .flex_none()
        .w(px(tw))
        .h(px(th))
        .rounded(px(TILE_RADIUS))
        .overflow_hidden()
        .bg(gpui::black())
        .children(recording.thumbnail.clone().map(|path| {
            img(std::path::PathBuf::from(path))
                .size_full()
                .object_fit(ObjectFit::Cover)
        }))
        .child(
            div()
                .absolute()
                .top(px(4.))
                .right(px(4.))
                .px(px(4.))
                .rounded(px(4.))
                .bg(p.scrim)
                .text_size(px(10.))
                .line_height(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(gpui::white())
                .child(format_duration(recording.seconds)),
        );
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(thumbnail)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .child(summary),
                )
                .child(small(
                    format!(
                        "{} · You'll watch it before it's sent.",
                        format_bytes(recording.bytes)
                    ),
                    p.text_secondary,
                ))
                .child(actions),
        )
        .into_any_element()
}

fn trace_row(host: &Arc<dyn UiHost>, view: &ReportView, locked: bool, p: &Palette) -> AnyElement {
    let host = Arc::clone(host);
    let failed = view.trace == super::state::TraceState::Failed;
    div()
        .flex()
        .items_start()
        .gap(px(8.))
        .child(
            Checkbox::new("report-trace", view.draft.trace, "", p)
                .disabled(locked)
                .on_toggle(move |on, _, _| host.report_command(ReportCommand::SetTrace(on))),
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
                        .text_color(p.text)
                        .child("Record a performance trace"),
                )
                .child(small(
                    view.trace.status_text(),
                    if failed {
                        p.destructive
                    } else {
                        p.text_secondary
                    },
                )),
        )
        .into_any_element()
}

fn pages_choice(
    host: &Arc<dyn UiHost>,
    view: &ReportView,
    locked: bool,
    p: &Palette,
) -> AnyElement {
    let on = view.draft.include_pages && !view.private_window;
    let toggle = Arc::clone(host);
    let again = Arc::clone(host);
    let note = if view.private_window {
        small(PRIVATE_NOTE, p.text_secondary)
            .mt(px(2.))
            .into_any_element()
    } else if locked {
        div()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(crate::primitives::icons::icon(
                Icon::Lock,
                10.,
                p.text_tertiary,
            ))
            .child(small(LOCKED_NOTE, p.text_secondary))
            .child(link(
                "report-pages-record-again",
                "Record again",
                p.accent,
                move |window, cx| again.report_record(window, cx),
            ))
            .into_any_element()
    } else {
        small(PAGES_WARNING, p.text_secondary)
            .mt(px(2.))
            .into_any_element()
    };
    div()
        .flex()
        .items_start()
        .gap(px(8.))
        .child(
            Checkbox::new("report-include-pages", on, "", p)
                .disabled(locked || view.private_window)
                .on_toggle(move |on, _, _| {
                    toggle.report_command(ReportCommand::SetIncludePages(on))
                }),
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
                        .text_color(if locked { p.text_secondary } else { p.text })
                        .child("Include web pages"),
                )
                .child(note),
        )
        .when(on && !locked, |d| {
            d.child(
                div()
                    .mt(px(4.))
                    .flex_none()
                    .size(px(tokens::RECORD_DOT))
                    .rounded_full()
                    .bg(p.warning),
            )
        })
        .into_any_element()
}
