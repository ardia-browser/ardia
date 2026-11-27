use std::time::Duration;

use ardia_state::live::github::{CheckTone, summarize_checks};
use ardia_state::live::{
    CheckState, LiveCommand, LiveItem, Mergeable, PullRequestCheck, PullRequestSection, ReviewState,
};
use ardia_state::{Action, NewTab, WindowId};
use gpui::{
    Animation, AnimationExt, AnyElement, FontWeight, Hsla, IntoElement, ObjectFit, ParentElement,
    SharedString, Styled, StyledImage, div, img, prelude::*, rgba,
};

use crate::host::UiHost;
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::scale::px;

use super::{ago, tokens};

pub const PR_WIDTH: f32 = 300.0;
pub const DOC_WIDTH: f32 = 280.0;
pub const PREVIEW_GAP: f32 = 8.0;
pub const CI_BAR: f32 = 6.0;
pub const CHECK_ROW: f32 = 24.0;
pub const CHECK_PAD: f32 = 4.0;
pub const AVATAR_SIZE: f32 = 20.0;
pub const FAILURES_SHOWN: usize = 3;
pub const CI_PULSE_MS: u64 = 1100;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveColors {
    pub pending: Hsla,
    pub merged: Hsla,
    pub draft: Hsla,
    pub conflict: Hsla,
    pub ci_track: Hsla,
    pub chip: Hsla,
    pub badge_ring: Hsla,
    pub avatar_fill: Hsla,
    pub success: Hsla,
    pub failure: Hsla,
    pub now: Hsla,
}

pub fn live_colors(p: &Palette) -> LiveColors {
    let c = |dark: u32, light: u32| -> Hsla { rgba(if p.dark { dark } else { light }).into() };
    LiveColors {
        pending: c(tokens::PENDING_DARK, tokens::PENDING_LIGHT),
        merged: c(tokens::MERGED_DARK, tokens::MERGED_LIGHT),
        draft: c(tokens::DRAFT_DARK, tokens::DRAFT_LIGHT),
        conflict: c(tokens::CONFLICT_DARK, tokens::CONFLICT_LIGHT),
        ci_track: c(tokens::CI_TRACK_DARK, tokens::CI_TRACK_LIGHT),
        chip: c(tokens::CHIP_DARK, tokens::CHIP_LIGHT),
        badge_ring: c(tokens::BADGE_RING_DARK, tokens::BADGE_RING_LIGHT),
        avatar_fill: c(tokens::AVATAR_FILL_DARK, tokens::AVATAR_FILL_LIGHT),
        success: p.success,
        failure: p.destructive,
        now: p.destructive,
    }
}

thread_local! {
    static ALL_FAILURES: std::cell::RefCell<std::collections::HashSet<String>> = std::cell::RefCell::new(std::collections::HashSet::new());
}

pub fn show_all_failures(item: &str) {
    ALL_FAILURES.with(|all| all.borrow_mut().insert(item.to_owned()));
}

pub fn shows_all_failures(item: &str) -> bool {
    ALL_FAILURES.with(|all| all.borrow().contains(item))
}

pub struct CardContext<'a> {
    pub host: &'a dyn UiHost,
    pub p: &'a Palette,
    pub emit: &'a Emit,
    pub window: &'a WindowId,
    pub now: i64,
}

pub fn initials(name: &str) -> String {
    let out: String = name
        .split(|c: char| c.is_whitespace() || matches!(c, '.' | '_' | '-'))
        .filter(|p| !p.is_empty())
        .take(2)
        .filter_map(|p| p.chars().next())
        .flat_map(char::to_uppercase)
        .collect();
    if out.is_empty() { "?".into() } else { out }
}

pub fn comments_text(comments: u64, unresolved: u64) -> String {
    let base = if comments == 1 {
        "1 comment".to_owned()
    } else {
        format!("{comments} comments")
    };
    if unresolved > 0 {
        format!("{base} · {unresolved} unresolved")
    } else {
        base
    }
}

pub fn files_text(files: u64) -> String {
    if files == 0 {
        String::new()
    } else if files == 1 {
        " · 1 file".into()
    } else {
        format!(" · {files} files")
    }
}

pub fn review_text(review: ReviewState, section: Option<PullRequestSection>) -> &'static str {
    match review {
        ReviewState::Approved => "Approved",
        ReviewState::ChangesRequested => "Changes Requested",
        ReviewState::Required
            if section.unwrap_or(PullRequestSection::Authored) == PullRequestSection::Authored =>
        {
            "Review required"
        }
        ReviewState::Required => "Needs your review",
    }
}

pub fn doc_meta(item: &LiveItem) -> String {
    let doc = item.doc.as_ref();
    [
        doc.map(|d| d.kind.clone()),
        doc.and_then(|d| d.place.clone())
            .or_else(|| Some(item.subtitle.clone()).filter(|s| !s.is_empty())),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

pub fn edited_text(item: &LiveItem, now: i64) -> Option<String> {
    (item.updated_at > 0).then(|| {
        let by = item
            .doc
            .as_ref()
            .and_then(|d| d.edited_by.as_ref())
            .map(|b| format!(" by {b}"))
            .unwrap_or_default();
        format!("Edited {}{by}", ago(item.updated_at, now))
    })
}

fn open_url(ctx: &CardContext, url: String) -> Msg {
    Msg::Store(Action::NewTab {
        window: ctx.window.clone(),
        tab: NewTab {
            url: Some(url),
            ..NewTab::default()
        },
    })
}

fn status_line(
    ctx: &CardContext,
    name: &str,
    color: Hsla,
    text: impl Into<SharedString>,
) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .child(symbol(
            ctx.host,
            name,
            11.,
            14.,
            SymbolWeight::Regular,
            color,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.))
                .line_height(px(15.))
                .text_color(ctx.p.text)
                .child(text.into()),
        )
        .into_any_element()
}

fn avatar(ctx: &CardContext, uri: Option<&str>, name: &str, colors: &LiveColors) -> AnyElement {
    div()
        .flex_none()
        .relative()
        .size(px(AVATAR_SIZE))
        .rounded_full()
        .overflow_hidden()
        .bg(colors.avatar_fill)
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .text_size(px(AVATAR_SIZE * tokens::AVATAR_SCALE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ctx.p.text)
                .child(initials(name)),
        )
        .when_some(
            uri.filter(|u| u.starts_with("https://")).map(str::to_owned),
            |this, uri| {
                this.child(
                    div().absolute().inset_0().child(
                        img(SharedString::from(uri))
                            .size(px(AVATAR_SIZE))
                            .object_fit(ObjectFit::Cover),
                    ),
                )
            },
        )
        .into_any_element()
}

fn ci_bar(checks: &[PullRequestCheck], colors: &LiveColors) -> AnyElement {
    let success = checks
        .iter()
        .filter(|c| matches!(c.state, CheckState::Success | CheckState::Neutral))
        .count();
    let pending = checks
        .iter()
        .filter(|c| matches!(c.state, CheckState::Pending | CheckState::Queued))
        .count();
    let failure = checks
        .iter()
        .filter(|c| c.state == CheckState::Failure)
        .count();
    let present: Vec<bool> = vec![success > 0, pending > 0, failure > 0];
    let first = present.iter().position(|p| *p).unwrap_or(0);
    let last = present.iter().rposition(|p| *p).unwrap_or(0);
    let part = |index: usize, count: usize, color: Hsla| {
        div()
            .flex_basis(px(0.))
            .flex_grow(count as f32)
            .h_full()
            .bg(color)
            .when(index == first, |d| d.rounded_l(px(CI_BAR / 2.)))
            .when(index == last, |d| d.rounded_r(px(CI_BAR / 2.)))
    };
    div()
        .h(px(CI_BAR))
        .rounded(px(CI_BAR / 2.))
        .overflow_hidden()
        .flex()
        .gap(px(2.))
        .bg(colors.ci_track)
        .when(success > 0, |this| {
            this.child(part(0, success, colors.success))
        })
        .when(pending > 0, |this| {
            this.child(part(1, pending, colors.pending).with_animation(
                "ci-pulse",
                Animation::new(Duration::from_millis(CI_PULSE_MS * 2)).repeat(),
                |bar, t| {
                    let wave = if t < 0.5 { t * 2.0 } else { 2.0 - t * 2.0 };
                    let eased = ardia_theme::motion::ease_in_out_cubic(f64::from(wave)) as f32;
                    bar.opacity(1.0 - 0.55 * eased)
                },
            ))
        })
        .when(failure > 0, |this| {
            this.child(part(2, failure, colors.failure))
        })
        .into_any_element()
}

fn pr_preview(ctx: &CardContext, folder: &str, item: &LiveItem) -> AnyElement {
    let p = ctx.p;
    let colors = live_colors(p);
    let Some(pr) = &item.pr else {
        return div().into_any_element();
    };
    let summary = summarize_checks(&pr.checks);
    let failing: Vec<&PullRequestCheck> = pr
        .checks
        .iter()
        .filter(|c| c.state == CheckState::Failure)
        .collect();
    let all = shows_all_failures(&item.id);
    let shown = if all {
        failing.len()
    } else {
        failing.len().min(FAILURES_SHOWN)
    };
    let header = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(avatar(
            ctx,
            pr.author_avatar.as_deref(),
            &pr.author,
            &colors,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.))
                .line_height(px(15.))
                .text_color(p.text_secondary)
                .child(
                    gpui::StyledText::new(format!("{} · {} #{}", pr.author, pr.repo, pr.number))
                        .with_highlights([(
                            0..pr.author.len(),
                            gpui::HighlightStyle {
                                color: Some(p.text),
                                font_weight: Some(FontWeight::SEMIBOLD),
                                ..Default::default()
                            },
                        )]),
                ),
        )
        .when(pr.draft, |this| {
            this.child(
                div()
                    .px(px(5.))
                    .rounded(px(4.))
                    .border(px(1.))
                    .border_color(colors.draft)
                    .text_size(px(10.))
                    .line_height(px(13.))
                    .text_color(colors.draft)
                    .child("Draft"),
            )
        });
    let checks = summary.map(|summary| {
        let (name, color) = match summary.tone {
            CheckTone::Success => ("checkmark.circle.fill", colors.success),
            CheckTone::Failure => ("xmark.circle.fill", colors.failure),
            _ => ("clock.fill", colors.pending),
        };
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(ci_bar(&pr.checks, &colors))
            .child(status_line(ctx, name, color, summary.text))
            .children(failing.iter().take(shown).map(|check| {
                let url = check.url.clone();
                div()
                    .id(SharedString::from(format!("failing:{}", check.name)))
                    .h(px(CHECK_ROW))
                    .px(px(CHECK_PAD))
                    .rounded(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .group("failing-check")
                    .hover(|s| s.bg(p.row_hover))
                    .when_some(url, |this, url| {
                        this.on_click(ctx.emit.click(open_url(ctx, url)))
                    })
                    .child(symbol(
                        ctx.host,
                        "xmark",
                        9.,
                        12.,
                        SymbolWeight::Bold,
                        colors.failure,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.))
                            .line_height(px(15.))
                            .text_color(p.text)
                            .child(check.name.clone()),
                    )
                    .child(
                        div()
                            .opacity(0.)
                            .group_hover("failing-check", |s| s.opacity(1.))
                            .child(symbol(
                                ctx.host,
                                "arrow.up.forward",
                                9.,
                                12.,
                                SymbolWeight::Regular,
                                p.text_secondary,
                            )),
                    )
            }))
            .when(failing.len() > FAILURES_SHOWN && !all, |this| {
                this.child(
                    div()
                        .id("show-all-failures")
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(p.accent)
                        .cursor_pointer()
                        .on_click({
                            let id = item.id.clone();
                            move |_, window, _| {
                                show_all_failures(&id);
                                window.refresh();
                            }
                        })
                        .child(format!("Show all {} failures", failing.len())),
                )
            })
    });
    let conflict = (pr.mergeable == Mergeable::Conflicting).then(|| {
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(div().flex_1().child(status_line(
                ctx,
                "exclamationmark.triangle.fill",
                colors.conflict,
                "This branch has conflicts",
            )))
            .child(
                div()
                    .id("resolve-conflicts")
                    .h(px(24.))
                    .px(px(8.))
                    .rounded(px(12.))
                    .bg(p.url_pill)
                    .hover(move |s| s.bg(p.toolbar_hover))
                    .active(move |s| s.bg(p.toolbar_pressed))
                    .flex()
                    .items_center()
                    .text_size(px(12.))
                    .line_height(px(15.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.text)
                    .on_click(
                        ctx.emit
                            .click(open_url(ctx, format!("{}/conflicts", item.url))),
                    )
                    .child("Resolve Conflicts"),
            )
    });
    let review = pr.review.map(|review| {
        let (name, color) = match review {
            ReviewState::Approved => ("checkmark.seal.fill", colors.success),
            ReviewState::ChangesRequested => ("arrow.uturn.backward.circle.fill", colors.failure),
            ReviewState::Required => ("eye", p.text_secondary),
        };
        status_line(ctx, name, color, review_text(review, item.section))
    });
    let diff = (pr.additions > 0 || pr.deletions > 0).then(|| {
        div()
            .text_size(px(11.))
            .line_height(px(14.))
            .text_color(p.text_secondary)
            .flex()
            .child(
                div()
                    .text_color(colors.success)
                    .child(format!("+{}", pr.additions)),
            )
            .child(" ")
            .child(
                div()
                    .text_color(colors.failure)
                    .child(format!("−{}", pr.deletions)),
            )
            .child(files_text(pr.changed_files))
    });
    div()
        .flex()
        .flex_col()
        .gap(px(PREVIEW_GAP))
        .child(header)
        .child(
            div()
                .text_size(px(13.))
                .line_height(px(18.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.text)
                .line_clamp(3)
                .child(item.title.clone()),
        )
        .children(checks)
        .children(conflict)
        .children(review)
        .child(div().h(px(1.)).bg(p.divider))
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(10.))
                .child(
                    div()
                        .id("live-comments")
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .cursor_pointer()
                        .on_click(ctx.emit.click(Msg::Live(LiveCommand::OpenItem {
                            window: ctx.window.clone(),
                            folder: folder.to_owned(),
                            item: item.id.clone(),
                            background: false,
                        })))
                        .child(symbol(
                            ctx.host,
                            "bubble.left",
                            10.5,
                            14.,
                            SymbolWeight::Regular,
                            p.text_secondary,
                        ))
                        .child(
                            div()
                                .text_size(px(11.))
                                .line_height(px(14.))
                                .text_color(p.text_secondary)
                                .child(comments_text(pr.comments, pr.unresolved_threads)),
                        ),
                )
                .children(diff),
        )
        .into_any_element()
}

fn doc_preview(ctx: &CardContext, item: &LiveItem) -> AnyElement {
    let p = ctx.p;
    let icon = match item.icon.as_deref() {
        Some(emoji) if !emoji.starts_with("http") => div()
            .text_size(px(14.))
            .child(SharedString::from(emoji.to_owned()))
            .into_any_element(),
        _ => crate::primitives::favicon::render_favicon(
            &crate::primitives::favicon::favicon_of(
                &item.url,
                item.icon.as_deref(),
                None,
                &item.title,
            ),
            16.,
            p,
        ),
    };
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_none()
                        .size(px(16.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .line_clamp(2)
                        .child(item.title.clone()),
                ),
        )
        .child(
            div()
                .truncate()
                .text_size(px(12.))
                .line_height(px(15.))
                .text_color(p.text_secondary)
                .child(doc_meta(item)),
        )
        .children(edited_text(item, ctx.now).map(|text| {
            div()
                .truncate()
                .text_size(px(12.))
                .line_height(px(15.))
                .text_color(p.text_secondary)
                .child(text)
        }))
        .into_any_element()
}

pub fn card_width(item: &LiveItem) -> f32 {
    if item.pr.is_some() {
        PR_WIDTH
    } else {
        DOC_WIDTH
    }
}

pub fn live_item_card(ctx: &CardContext, folder: &str, item: &LiveItem) -> AnyElement {
    if item.pr.is_some() {
        pr_preview(ctx, folder, item)
    } else {
        doc_preview(ctx, item)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::live::{DocumentInfo, LiveSourceId};

    #[test]
    fn copy_matches_the_old_card() {
        assert_eq!(initials("octo-dev"), "OD");
        assert_eq!(initials(""), "?");
        assert_eq!(comments_text(1, 0), "1 comment");
        assert_eq!(comments_text(3, 2), "3 comments · 2 unresolved");
        assert_eq!(files_text(1), " · 1 file");
        assert_eq!(
            review_text(ReviewState::Required, Some(PullRequestSection::Review)),
            "Needs your review"
        );
        assert_eq!(review_text(ReviewState::Required, None), "Review required");
        let item = LiveItem {
            id: "d".into(),
            source: LiveSourceId::Gdrive,
            url: "https://d".into(),
            title: "Plan".into(),
            subtitle: "Document".into(),
            icon: None,
            updated_at: 1,
            section: None,
            pr: None,
            doc: Some(DocumentInfo {
                kind: "Document".into(),
                edited_by: Some("Mira".into()),
                place: None,
            }),
        };
        assert_eq!(doc_meta(&item), "Document · Document");
        assert_eq!(
            edited_text(&item, 1 + 5 * 60_000).as_deref(),
            Some("Edited 5 min ago by Mira")
        );
        assert_eq!(card_width(&item), DOC_WIDTH);
    }
}
