use std::sync::Arc;

use gpui::{
    Context, FontWeight, IntoElement, ParentElement, Render, Styled, Window, div, hsla, prelude::*,
};

use crate::host::UiHost;
use crate::scale::px;

use super::format_duration;
use super::state::{RecordingState, ReportCommand};

pub const HEIGHT: f32 = 32.0;
pub const STOP_HEIGHT: f32 = 24.0;
pub const DOT: f32 = 8.0;
pub const PAD: f32 = 8.0;

pub fn pill_seconds(recording: &RecordingState) -> f64 {
    match recording {
        RecordingState::Recording { seconds, .. } => *seconds,
        _ => 0.0,
    }
}

pub struct RecordingPillView {
    host: Arc<dyn UiHost>,
}

impl RecordingPillView {
    pub fn new(host: Arc<dyn UiHost>) -> Self {
        RecordingPillView { host }
    }
}

impl Render for RecordingPillView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let seconds = self
            .host
            .report()
            .map_or(0.0, |view| pill_seconds(&view.recording));
        let host = Arc::clone(&self.host);
        let white = hsla(0., 0., 1., 1.);
        div()
            .debug_selector(|| "report-recording-pill".into())
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .h(px(HEIGHT))
                    .pl(px(14.))
                    .pr(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .rounded_full()
                    .bg(hsla(0., 0., 0., 0.82))
                    .border(px(0.5))
                    .border_color(hsla(0., 0., 1., 0.12))
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(white)
                    .child(
                        div()
                            .size(px(DOT))
                            .rounded_full()
                            .bg(hsla(3. / 360., 1.0, 0.61, 1.0)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child("Recording")
                            .child(
                                div()
                                    .text_color(hsla(0., 0., 1., 0.7))
                                    .child(format_duration(seconds)),
                            ),
                    )
                    .child(
                        div()
                            .id("report-recording-stop")
                            .h(px(STOP_HEIGHT))
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .rounded_full()
                            .bg(hsla(0., 0., 1., 0.16))
                            .cursor_pointer()
                            .on_click(move |_, _, _| {
                                host.report_command(ReportCommand::StopRecording)
                            })
                            .child(div().size(px(DOT)).rounded(px(1.5)).bg(white))
                            .child(div().font_weight(FontWeight::SEMIBOLD).child("Stop")),
                    ),
            )
            .p(px(PAD))
    }
}
