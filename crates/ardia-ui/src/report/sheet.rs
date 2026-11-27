use std::sync::Arc;
use std::time::Duration;

use ardia_state::WindowId;
use gpui::{
    Animation, AnimationExt, AnyElement, Context, Entity, FontWeight, Hsla, IntoElement,
    MouseButton, ParentElement, Render, SharedString, Styled, Subscription, Window, deferred, div,
    prelude::*,
};

use crate::host::UiHost;
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::look::{Look, Palette};
use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, Checkbox, PushButton, Segmented};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput, focus_input};
use crate::scale::px;

use super::state::{AttachmentKey, ReportCommand, ReportView, SentReport, UploadState};
use super::{
    DraftField, FOOTER_NOTE, ReportKind, attached_summary, draft_problems, events_label,
    field_problem, format_bytes, short_address, title_counter, tokens, watch_end_date,
};

pub const WIDTH: f32 = 560.0;
pub const SENT_WIDTH: f32 = 480.0;
pub const PAD: f32 = 20.0;
pub const FIELD_HEIGHT: f32 = 24.0;
pub const DESCRIPTION_HEIGHT: f32 = 96.0;
pub const APPEAR_MS: u64 = 150;
pub const MAX_HEIGHT_SHARE: f32 = 0.9;

pub fn sheet_max_height(window_height: f32) -> f32 {
    (window_height * MAX_HEIGHT_SHARE).max(PAD * 2.0)
}

pub fn format_day(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%B %-d").to_string())
        .unwrap_or_default()
}

pub struct AttachedRowModel {
    pub key: AttachmentKey,
    pub title: &'static str,
    pub detail: String,
    pub on: bool,
    pub disabled: bool,
}

pub fn attached_rows(view: &ReportView) -> Vec<AttachedRowModel> {
    let a = view.draft.attach;
    let mut rows = vec![AttachedRowModel {
        key: AttachmentKey::System,
        title: "System info",
        detail: view.system_line.clone(),
        on: a.system,
        disabled: false,
    }];
    if let Some(events) = view.local_events {
        rows.push(AttachedRowModel {
            key: AttachmentKey::Errors,
            title: "Usage, errors and crashes, last 7 days",
            detail: events_label(events),
            on: a.errors && events > 0,
            disabled: events == 0,
        });
    }
    rows.push(AttachedRowModel {
        key: AttachmentKey::Settings,
        title: "Settings",
        detail: "No passwords or history".into(),
        on: a.settings,
        disabled: false,
    });
    rows.push(AttachedRowModel {
        key: AttachmentKey::Page,
        title: "Page address",
        detail: view
            .page_address
            .as_deref()
            .map_or_else(|| "No page open".into(), short_address),
        on: a.page && view.page_address.is_some(),
        disabled: view.page_address.is_none(),
    });
    rows
}

pub fn send_title(upload: &UploadState) -> &'static str {
    match upload {
        UploadState::Failed { .. } => "Try Again",
        u if u.busy() => "Sending…",
        _ => "Send",
    }
}

pub struct ReportSheetView {
    host: Arc<dyn UiHost>,
    window_id: WindowId,
    title: Entity<TextInput>,
    description: Entity<TextInput>,
    contact: Entity<TextInput>,
    _inputs: Vec<Subscription>,
    synced: bool,
    player: Option<(String, gpui::NativeView)>,
}

fn style(p: &Palette) -> InputStyle {
    InputStyle {
        text: p.text,
        placeholder: p.placeholder,
        caret: p.caret,
        selection: p.selection,
        font_size: 13.0,
        weight: gpui::FontWeight::NORMAL,
    }
}

impl ReportSheetView {
    fn sync_player(&mut self, path: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if self.player.as_ref().map(|(p, _)| p) == path.as_ref() {
            return;
        }
        if self.player.take().is_some() {
            self.host.report_player(None);
        }
        let Some(path) = path else {
            return;
        };
        let view = self.host.report_player(Some(&path)).and_then(|handle| {
            let raw = std::ptr::NonNull::new(handle.0)?;
            unsafe { gpui::NativeView::new(raw, window, cx) }.ok()
        });
        if let Some(view) = view {
            self.player = Some((path, view));
        }
    }

    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = cx.new(|cx| TextInput::new("Sidebar tabs flicker after waking from sleep", cx));
        let description = cx.new(|cx| {
            TextInput::new(
                "What did you do, what did you expect, what happened instead?",
                cx,
            )
        });
        let contact = cx.new(|cx| TextInput::new("@handle or email, if you'd like a reply", cx));
        let mut subs = Vec::new();
        for (input, make) in [
            (
                &title,
                ReportCommand::SetTitle as fn(String) -> ReportCommand,
            ),
            (
                &description,
                ReportCommand::SetDescription as fn(String) -> ReportCommand,
            ),
            (
                &contact,
                ReportCommand::SetContact as fn(String) -> ReportCommand,
            ),
        ] {
            subs.push(cx.subscribe_in(
                input,
                window,
                move |view: &mut Self, input, event, _, cx| match event {
                    InputEvent::Changed { .. } => {
                        let text = input.read(cx).text().to_owned();
                        view.host.report_command(make(text));
                    }
                    InputEvent::Submit(_) => view.host.report_command(ReportCommand::Send),
                    InputEvent::Cancel => view.host.report_command(ReportCommand::Close),
                    _ => {}
                },
            ));
        }
        ReportSheetView {
            host,
            window_id,
            title,
            description,
            contact,
            _inputs: subs,
            synced: false,
            player: None,
        }
    }

    fn sync(
        &mut self,
        view: &ReportView,
        p: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for input in [&self.title, &self.description, &self.contact] {
            input.update(cx, |i, cx| i.set_style(style(p), cx));
        }
        if self.synced {
            return;
        }
        self.synced = true;
        let draft = view.draft.clone();
        self.title
            .update(cx, |i, cx| i.set_text(draft.title.clone(), false, cx));
        self.description
            .update(cx, |i, cx| i.set_text(draft.description.clone(), false, cx));
        self.contact
            .update(cx, |i, cx| i.set_text(draft.contact.clone(), false, cx));
        focus_input(&self.title, window, cx);
    }

    fn field(input: &Entity<TextInput>, p: &Palette, invalid: bool, height: f32) -> AnyElement {
        div()
            .h(px(height))
            .px(px(8.))
            .rounded(px(4.))
            .bg(p.field)
            .border(px(1.))
            .border_color(if invalid {
                p.destructive
            } else {
                p.field_border
            })
            .flex()
            .when(height > FIELD_HEIGHT, |d| d.items_start().pt(px(6.)))
            .when(height <= FIELD_HEIGHT, |d| d.items_center())
            .child(div().flex_1().min_w_0().child(input.clone()))
            .into_any_element()
    }

    fn hint(text: Option<String>, p: &Palette) -> Option<AnyElement> {
        text.map(|t| {
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.destructive)
                .child(t)
                .into_any_element()
        })
    }

    fn form(&self, view: &ReportView, p: &Palette, cx: &mut Context<Self>) -> AnyElement {
        let emit = |cmd: ReportCommand| {
            let host = Arc::clone(&self.host);
            move |_: &gpui::ClickEvent, _: &mut Window, _: &mut gpui::App| {
                host.report_command(cmd.clone())
            }
        };
        let problems = if view.show_problems {
            draft_problems(&view.draft)
        } else {
            Vec::new()
        };
        let hint_of = |f: DraftField| field_problem(&problems, f).map(|(_, h)| h);
        let counter = title_counter(&view.draft.title);
        let kinds = ReportKind::ALL;
        let selected = kinds
            .iter()
            .position(|k| *k == view.draft.kind)
            .unwrap_or(0);
        let host = Arc::clone(&self.host);
        let header = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .child("Report a Problem"),
            )
            .child(
                kinds
                    .iter()
                    .fold(Segmented::new("report-kind", selected, p), |s, k| {
                        s.option(k.title(), None)
                    })
                    .on_select(move |i, _, _| {
                        if let Some(kind) = ReportKind::ALL.get(i) {
                            host.report_command(ReportCommand::SetKind(*kind));
                        }
                    }),
            )
            .child(
                div()
                    .id("report-close")
                    .size(px(22.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .hover(move |s| s.bg(p.toolbar_hover))
                    .on_click(emit(ReportCommand::Close))
                    .child(symbol(
                        self.host.as_ref(),
                        "xmark",
                        9.,
                        14.,
                        SymbolWeight::Semibold,
                        p.text_secondary,
                    )),
            );
        let label = |text: &'static str| {
            div()
                .flex_1()
                .font_weight(FontWeight::MEDIUM)
                .text_size(px(13.))
                .text_color(p.text_secondary)
                .child(text)
        };
        let fields = div()
            .flex()
            .flex_col()
            .child(
                div()
                    .mt(px(16.))
                    .mb(px(6.))
                    .flex()
                    .items_baseline()
                    .gap(px(8.))
                    .child(label("Title"))
                    .children(Self::hint(hint_of(DraftField::Title), p))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(if counter.full {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::NORMAL
                            })
                            .text_color(if counter.full {
                                p.destructive
                            } else {
                                p.text_tertiary
                            })
                            .child(format!("{}/{}", counter.count, counter.max)),
                    ),
            )
            .child(Self::field(
                &self.title,
                p,
                counter.full || hint_of(DraftField::Title).is_some(),
                FIELD_HEIGHT,
            ))
            .child(
                div()
                    .mt(px(12.))
                    .mb(px(6.))
                    .flex()
                    .items_baseline()
                    .gap(px(8.))
                    .child(label("What happened?"))
                    .children(Self::hint(hint_of(DraftField::Description), p)),
            )
            .child(Self::field(
                &self.description,
                p,
                hint_of(DraftField::Description).is_some(),
                DESCRIPTION_HEIGHT,
            ));
        let rows = attached_rows(view);
        let summary = attached_summary(
            view.draft.attach,
            view.local_events.unwrap_or(0),
            view.page_address.is_some(),
        );
        let attached = div()
            .mt(px(12.))
            .rounded(px(12.))
            .bg(p.group_box)
            .border(px(1.))
            .border_color(p.group_stroke)
            .overflow_hidden()
            .child(
                div()
                    .id("report-attached")
                    .h(px(34.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .hover(move |s| s.bg(p.row_hover))
                    .on_click(emit(ReportCommand::SetAttachedOpen(!view.attached_open)))
                    .child(symbol(
                        self.host.as_ref(),
                        "paperclip",
                        12.,
                        14.,
                        SymbolWeight::Regular,
                        p.text_secondary,
                    ))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(p.text_secondary)
                            .child("Attached"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .text_color(p.text)
                            .child(summary),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.form_accent)
                            .child("Preview"),
                    )
                    .child(symbol(
                        self.host.as_ref(),
                        if view.attached_open {
                            "chevron.up"
                        } else {
                            "chevron.down"
                        },
                        10.,
                        14.,
                        SymbolWeight::Semibold,
                        p.text_secondary,
                    )),
            )
            .when(view.attached_open, |d| {
                d.child(div().h(px(1.)).bg(p.divider)).child(
                    div()
                        .px(px(12.))
                        .py(px(8.))
                        .child(
                            div()
                                .mb(px(4.))
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(p.text_secondary)
                                .child("Sent with this report"),
                        )
                        .children(rows.into_iter().map(|row| {
                            let host = Arc::clone(&self.host);
                            let key = row.key;
                            div()
                                .h(px(26.))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    Checkbox::new(
                                        SharedString::from(format!("attach:{}", row.title)),
                                        row.on,
                                        row.title,
                                        p,
                                    )
                                    .on_toggle(
                                        move |on, _, _| {
                                            if !row.disabled {
                                                host.report_command(ReportCommand::SetAttach {
                                                    key,
                                                    on,
                                                });
                                            }
                                        },
                                    ),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_right()
                                        .text_size(px(12.))
                                        .text_color(p.text_tertiary)
                                        .child(row.detail),
                                )
                        }))
                        .child(
                            div()
                                .id("report-preview-link")
                                .mt(px(6.))
                                .text_size(px(13.))
                                .text_color(p.accent)
                                .cursor_pointer()
                                .on_click(emit(ReportCommand::SetPreview(true)))
                                .child("Preview everything that's sent"),
                        ),
                )
            });
        let watch = (!view.sharing).then(|| {
            let host = Arc::clone(&self.host);
            div()
                .mt(px(12.))
                .flex()
                .items_start()
                .gap(px(8.))
                .child(
                    Checkbox::new("report-watch", view.draft.watch, "", p).on_toggle(
                        move |on, _, _| host.report_command(ReportCommand::SetWatch(on)),
                    ),
                )
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(div().text_size(px(13.)).text_color(p.text).child(
                            "Help confirm the fix: share crash reports and usage for 14 days",
                        ))
                        .child(div().text_size(px(12.)).text_color(p.text_secondary).child(
                            format!(
                                "Turns itself off on {}.",
                                format_day(watch_end_date(chrono::Utc::now().timestamp_millis()))
                            ),
                        )),
                )
        });
        let contact = div()
            .mt(px(12.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .w(px(tokens::LABEL_WIDTH))
                    .font_weight(FontWeight::MEDIUM)
                    .text_size(px(13.))
                    .text_color(p.text_secondary)
                    .child("Contact"),
            )
            .child(div().flex_1().child(Self::field(
                &self.contact,
                p,
                hint_of(DraftField::Contact).is_some(),
                FIELD_HEIGHT,
            )))
            .children(Self::hint(hint_of(DraftField::Contact), p));
        let failed = matches!(view.upload, UploadState::Failed { .. });
        let footer = div()
            .mt(px(16.))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div().flex_1().min_w_0().child(match &view.upload {
                    u if u.busy() => div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(p.text_secondary)
                                .child(u.progress_text()),
                        )
                        .child(crate::primitives::controls::progress_bar(
                            if matches!(u, UploadState::Creating) {
                                0.02
                            } else {
                                u.fraction()
                            },
                            p.progress_track,
                            p.form_accent,
                        ))
                        .into_any_element(),
                    UploadState::Failed { message, .. } => div()
                        .text_size(px(12.))
                        .text_color(p.destructive)
                        .child(message.clone())
                        .into_any_element(),
                    _ => div()
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .text_color(p.text_secondary)
                        .child(FOOTER_NOTE)
                        .into_any_element(),
                }),
            )
            .child(
                PushButton::new("report-cancel", "Cancel", p).on_click(emit(ReportCommand::Close)),
            )
            .child(
                PushButton::new("report-send", send_title(&view.upload), p)
                    .kind(ButtonKind::Primary)
                    .disabled(!view.may_start_sending() && !failed)
                    .on_click(emit(ReportCommand::Send)),
            );
        let _ = cx;
        div()
            .flex()
            .flex_col()
            .child(header)
            .child(fields)
            .when(view.can_record, |d| {
                d.child(super::record::record_section(
                    &self.host,
                    view,
                    self.player.as_ref().map(|(_, player)| player.clone()),
                    p,
                ))
            })
            .child(attached)
            .children(watch)
            .child(contact)
            .child(footer)
            .into_any_element()
    }

    fn preview(&self, view: &ReportView, p: &Palette) -> AnyElement {
        let host = Arc::clone(&self.host);
        div()
            .flex()
            .flex_col()
            .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(p.text).child("What's sent"))
            .child(
                div()
                    .mt(px(6.))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(p.text_secondary)
                    .child("Exactly what leaves your Mac when you press Send. Only the title, description, kind and version go to the public GitHub issue."),
            )
            .child(
                div()
                    .id("report-preview")
                    .mt(px(16.))
                    .h(px(tokens::PREVIEW_HEIGHT))
                    .overflow_y_scroll()
                    .rounded(px(8.))
                    .bg(p.group_box)
                    .border(px(1.))
                    .border_color(p.group_stroke)
                    .p(px(12.))
                    .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(p.text_secondary).child("Report"))
                    .child(div().text_size(px(12.)).font_family("Menlo").text_color(p.text).child(view.payload_preview.clone().unwrap_or_else(|| "…".into())))
                    .child(div().mt(px(12.)).text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(p.text_secondary).child("Files"))
                    .map(|d| {
                        if view.files.is_empty() {
                            d.child(div().text_size(px(12.)).text_color(p.text_secondary).child("None"))
                        } else {
                            d.children(view.files.iter().map(|f| {
                                div()
                                    .flex()
                                    .gap(px(8.))
                                    .child(div().text_size(px(12.)).font_family("Menlo").text_color(p.text).child(f.name.clone()))
                                    .child(div().text_size(px(12.)).text_color(p.text_secondary).child(format_bytes(f.bytes)))
                            }))
                        }
                    }),
            )
            .child(
                div()
                    .mt(px(16.))
                    .flex()
                    .child(div().flex_1())
                    .child(PushButton::new("report-back", "Back", p).on_click(move |_, _, _| host.report_command(ReportCommand::SetPreview(false)))),
            )
            .into_any_element()
    }

    fn sent(&self, sent: &SentReport, p: &Palette) -> AnyElement {
        let colors: Vec<Hsla> = sent
            .colors
            .iter()
            .filter_map(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok())
            .map(|v| gpui::rgba((v << 8) | 0xFF).into())
            .collect();
        let host = Arc::clone(&self.host);
        let finish = Arc::clone(&self.host);
        let first = colors.first().copied().unwrap_or(p.accent);
        let last = colors.last().copied().unwrap_or(p.accent);
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(
                        div()
                            .size(px(tokens::SENT_ICON))
                            .rounded_full()
                            .bg(p.success)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(symbol(self.host.as_ref(), "checkmark", tokens::SENT_GLYPH, tokens::SENT_ICON, SymbolWeight::Bold, p.on_accent)),
                    )
                    .child(div().mt(px(12.)).text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).text_color(p.text).child(format!("Sent · {}", sent.id)))
                    .child(div().mt(px(4.)).text_size(px(13.)).text_color(p.text_secondary).child("Thanks. Every report gets read and tracked."))
                    .when(sent.issue_url.is_some(), |d| {
                        d.child(
                            div()
                                .id("report-view-issue")
                                .mt(px(4.))
                                .text_size(px(13.))
                                .text_color(p.accent)
                                .cursor_pointer()
                                .on_click(move |_, _, _| host.report_command(ReportCommand::ViewIssue))
                                .child(super::sent_link_title(sent.issue_number)),
                        )
                    }),
            )
            .child(
                div()
                    .mt(px(16.))
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.group_box)
                    .border(px(1.))
                    .border_color(p.group_stroke)
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .size(px(tokens::AVATAR))
                            .rounded_full()
                            .bg(gpui::linear_gradient(
                                sent.angle as f32,
                                gpui::linear_color_stop(first, 0.),
                                gpui::linear_color_stop(last, 1.),
                            )),
                    )
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .text_size(px(13.))
                                    .text_color(p.text)
                                    .child("You appear to us as ")
                                    .child(div().font_weight(FontWeight::SEMIBOLD).child(sent.name.clone())),
                            )
                            .child(div().text_size(px(12.)).text_color(p.text_secondary).child("A made-up name. No account, no email.")),
                    ),
            )
            .when_some(sent.watch_until, |d, until| {
                d.child(
                    div()
                        .mt(px(12.))
                        .text_center()
                        .text_size(px(12.))
                        .text_color(p.text_secondary)
                        .child(if sent.watch_turns_off {
                            format!("Crash reports and usage are shared until {} to confirm the fix, then sharing turns itself off. Stop early in Settings › Privacy.", format_day(until))
                        } else {
                            format!("We'll watch for this problem until {}.", format_day(until))
                        }),
                )
            })
            .child(
                div()
                    .mt(px(16.))
                    .flex()
                    .justify_center()
                    .child(PushButton::new("report-done", "Done", p).kind(ButtonKind::Primary).on_click(move |_, _, _| finish.report_command(ReportCommand::Finish))),
            )
            .into_any_element()
    }
}

impl Render for ReportSheetView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(view) = self
            .host
            .report()
            .filter(|v| v.window.as_ref() == Some(&self.window_id))
        else {
            self.synced = false;
            self.sync_player(None, window, cx);
            return div().into_any_element();
        };
        if view.recording.hides_sheet() {
            self.sync_player(None, window, cx);
            return div().into_any_element();
        }
        let watched = view
            .recording
            .recorded()
            .filter(|_| view.watching && !view.preview && view.sent.is_none())
            .map(|r| r.path.clone());
        self.sync_player(watched, window, cx);
        let state = self.host.store().snapshot();
        let p = Look::new(&state, self.window_id.as_str(), window.appearance()).p;
        self.sync(&view, &p, window, cx);
        let (width, body) = match (&view.sent, view.preview) {
            (Some(sent), _) => (SENT_WIDTH, self.sent(sent, &p)),
            (None, true) => (WIDTH, self.preview(&view, &p)),
            (None, false) => (WIDTH, self.form(&view, &p, cx)),
        };
        let max_height = sheet_max_height(crate::scale::points(window.viewport_size().height));
        let host = Arc::clone(&self.host);
        deferred(
            div()
                .id("report-scrim")
                .absolute()
                .inset_0()
                .bg(p.scrim)
                .flex()
                .items_center()
                .justify_center()
                .occlude()
                .on_mouse_down(MouseButton::Left, move |_, _, _| {
                    host.report_command(ReportCommand::Close)
                })
                .child(
                    crate::primitives::sheets::panel_surface(
                        &p,
                        crate::primitives::tokens::radius::SHEET,
                        crate::primitives::tokens::shadow::DIALOG,
                    )
                    .id("report-sheet")
                    .debug_selector(|| "report-sheet".into())
                    .w(px(width))
                    .max_h(px(max_height))
                    .p(px(PAD))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .id("report-sheet-scroll")
                            .max_h(px(max_height - PAD * 2.0))
                            .overflow_y_scroll()
                            .child(body),
                    )
                    .with_animation(
                        "report-appear",
                        Animation::new(Duration::from_millis(APPEAR_MS)).with_easing(|t| {
                            ardia_theme::motion::ease_out_cubic(f64::from(t)) as f32
                        }),
                        |d, t| d.opacity(t),
                    ),
                ),
        )
        .with_priority(3)
        .into_any_element()
    }
}

pub fn open_report(window: &WindowId) -> Msg {
    Msg::Report(ReportCommand::Open {
        window: window.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sheet_caps_at_ninety_percent_of_the_window() {
        assert_eq!(sheet_max_height(860.0), 774.0);
        assert_eq!(sheet_max_height(10.0), PAD * 2.0);
    }

    #[test]
    fn attached_rows_follow_the_draft() {
        let mut view = ReportView {
            system_line: "Ardia".into(),
            ..ReportView::default()
        };
        let rows = attached_rows(&view);
        assert_eq!(rows.len(), 3);
        assert!(rows[2].disabled);
        assert_eq!(rows[2].detail, "No page open");
        view.local_events = Some(1);
        view.page_address = Some("https://www.a.com/x?y".into());
        let rows = attached_rows(&view);
        assert_eq!(rows[1].detail, "1 event");
        assert_eq!(rows[3].detail, "a.com/x");
        assert_eq!(send_title(&UploadState::Creating), "Sending…");
        assert_eq!(send_title(&UploadState::Idle), "Send");
        assert!(!format_day(0).is_empty());
    }
}
