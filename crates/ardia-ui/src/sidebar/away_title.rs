use crate::scale::px;
use ardia_state::tabs::Tab;
use gpui::{AnyElement, FontWeight, Hsla, IntoElement, ParentElement, Styled, div, prelude::*};

use crate::primitives::fade_label::fade_label;

pub const SLASH_ALPHA: f32 = 0.45;
pub const SLASH_GAP: f32 = 4.0;
pub const PINNED_MAX_SHARE: f32 = 0.45;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AwayTitle {
    pub pinned: Option<String>,
    pub page: String,
    pub renamed: bool,
}

pub fn same_page(a: &str, b: &str) -> bool {
    let page = |u: &str| {
        let without = u.split_once('#').map_or(u, |(page, _)| page);
        without.strip_suffix('/').unwrap_or(without).to_owned()
    };
    page(a) == page(b)
}

pub fn away_from_pin(tab: &Tab) -> bool {
    match tab.pinned_url.as_deref() {
        Some(pinned) if !pinned.is_empty() && !tab.url.is_empty() => !same_page(&tab.url, pinned),
        _ => false,
    }
}

pub fn page_title(tab: &Tab) -> String {
    let mut plain = tab.clone();
    plain.custom_title = None;
    plain.display_title()
}

pub fn away_title(tab: &Tab) -> Option<AwayTitle> {
    away_from_pin(tab).then(|| AwayTitle {
        pinned: tab.custom_title.clone().filter(|t| !t.is_empty()),
        page: page_title(tab),
        renamed: false,
    })
}

pub fn row_away_title(tab: &Tab) -> Option<AwayTitle> {
    let away = away_title(tab)?;
    if away.pinned.is_some() {
        Some(AwayTitle {
            pinned: None,
            page: tab.display_title(),
            renamed: true,
        })
    } else {
        Some(away)
    }
}

pub fn away_title_text(away: &AwayTitle) -> String {
    match &away.pinned {
        Some(pinned) => format!("{pinned} / {}", away.page),
        None => format!("/ {}", away.page),
    }
}

pub struct AwayLabel {
    pub color: Hsla,
    pub size: f32,
    pub weight: FontWeight,
    pub height: f32,
    pub struck: bool,
    pub max_width: f32,
}

pub fn away_label(away: &AwayTitle, look: AwayLabel) -> AnyElement {
    let struck_line = |color: Hsla| {
        div()
            .absolute()
            .left_0()
            .right_0()
            .top(px(look.height / 2.0))
            .h(px(1.))
            .bg(color)
    };
    div()
        .flex_1()
        .min_w_0()
        .h(px(look.height))
        .flex()
        .items_center()
        .when(look.struck, |d| {
            d.opacity(crate::sidebar::row_look::SLEEPING_TITLE_OPACITY)
        })
        .when_some(away.pinned.clone(), |d, pinned| {
            d.child(
                div()
                    .relative()
                    .flex_shrink(1.)
                    .min_w_0()
                    .max_w(px(look.max_width * PINNED_MAX_SHARE))
                    .text_size(px(look.size))
                    .font_weight(look.weight)
                    .text_color(look.color)
                    .truncate()
                    .child(pinned)
                    .when(look.struck, |d| d.child(struck_line(look.color))),
            )
        })
        .child(
            div()
                .flex_none()
                .when(away.pinned.is_some(), |d| d.ml(px(SLASH_GAP)))
                .mr(px(SLASH_GAP))
                .text_size(px(look.size))
                .font_weight(look.weight)
                .text_color(look.color.alpha(SLASH_ALPHA))
                .child("/"),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .relative()
                .flex()
                .items_center()
                .child(
                    fade_label(away.page.clone(), look.color, look.size)
                        .weight(look.weight)
                        .line_height(look.height),
                )
                .when(look.struck, |d| d.child(struck_line(look.color))),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::{ProfileId, TabId, WindowId};

    fn tab(url: &str, pinned: Option<&str>, custom: Option<&str>) -> Tab {
        let mut tab = Tab::new(
            TabId::new("t"),
            WindowId::new("w"),
            ProfileId::default_profile(),
            url,
            0,
        );
        tab.title = "Page".into();
        tab.pinned_url = pinned.map(str::to_owned);
        tab.custom_title = custom.map(str::to_owned);
        tab
    }

    #[test]
    fn the_same_page_with_a_fragment_or_slash_is_not_away() {
        assert!(!away_from_pin(&tab(
            "https://a.test/x/#top",
            Some("https://a.test/x"),
            None
        )));
        assert!(away_from_pin(&tab(
            "https://a.test/y",
            Some("https://a.test/x"),
            None
        )));
        assert!(!away_from_pin(&tab("https://a.test/y", None, None)));
    }

    #[test]
    fn a_renamed_pin_shows_its_name_then_the_page() {
        let away = away_title(&tab(
            "https://a.test/y",
            Some("https://a.test/x"),
            Some("Docs"),
        ))
        .expect("away");
        assert_eq!(away_title_text(&away), "Docs / Page");
        let row = row_away_title(&tab(
            "https://a.test/y",
            Some("https://a.test/x"),
            Some("Docs"),
        ))
        .expect("away");
        assert!(row.renamed);
        assert_eq!(row.pinned, None);
        assert_eq!(
            away_title_text(
                &away_title(&tab("https://a.test/y", Some("https://a.test/x"), None))
                    .expect("away")
            ),
            "/ Page"
        );
    }
}
