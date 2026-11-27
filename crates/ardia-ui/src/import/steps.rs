use ardia_theme::tokens::{TypeSize, radius, space};
use gpui::{FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use crate::host_data::{ExtensionListing, source_notes};
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::msg::Msg;
use crate::primitives::controls::{ButtonKind, PushButton};
use crate::scale::px;

use super::{ImportWindowView, title_block};

pub const APP: &str = "Ardia";
pub const SAFARI_ICON: f32 = 40.0;
pub const APP_ICON: f32 = 56.0;
pub const STEP_BADGE: f32 = 20.0;
pub const DROP_HEIGHT: f32 = 130.0;
pub const TEXT_MAX: f32 = 420.0;
pub const ENCRYPTED_KINDS: [&str; 2] = ["passwords", "cookies"];
pub const EXPORT_STEPS: [&str; 3] = [
    "Open Safari",
    "File menu › Export Browsing Data to File",
    "Upload the .zip file to Ardia",
];
pub const ACCESS_STEPS: [&str; 3] = [
    "Click “Open Full Disk Access Settings” below",
    "Turn on Ardia in the list",
    "Come back here: we'll continue automatically",
];

pub fn keychain_service(browser_id: &str, browser_name: &str) -> String {
    match browser_id {
        "edge" => "Microsoft Edge Safe Storage".to_owned(),
        _ => format!("{browser_name} Safe Storage"),
    }
}

pub fn needs_unlock(kinds: &[String]) -> bool {
    kinds
        .iter()
        .any(|kind| ENCRYPTED_KINDS.contains(&kind.as_str()))
}

fn command(text: &str) -> Msg {
    Msg::Command(SharedString::from(text.to_owned()))
}

fn button(
    view: &ImportWindowView,
    id: &'static str,
    title: &'static str,
    primary: bool,
    cmd: &'static str,
) -> gpui::AnyElement {
    let p = view.look.p;
    div()
        .debug_selector(move || id.into())
        .child(
            PushButton::new(id, title, &p)
                .kind(if primary {
                    ButtonKind::Primary
                } else {
                    ButtonKind::Plain
                })
                .on_click(view.emit.click(command(cmd))),
        )
        .into_any_element()
}

fn section(text: &str, p: &crate::look::Palette) -> gpui::AnyElement {
    div()
        .mt(px(space::XL))
        .mb(px(space::M))
        .text_size(px(TypeSize::Small.points()))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text_secondary)
        .child(SharedString::from(text.to_owned()))
        .into_any_element()
}

fn step_badge(n: usize, p: &crate::look::Palette) -> gpui::AnyElement {
    div()
        .flex_none()
        .size(px(STEP_BADGE))
        .rounded_full()
        .bg(p.row_hover)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(TypeSize::Caption.points()))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text_secondary)
        .child(SharedString::from(n.to_string()))
        .into_any_element()
}

fn access_steps(view: &ImportWindowView) -> gpui::AnyElement {
    let p = view.look.p;
    div()
        .child(
            div()
                .mb(px(space::XL))
                .flex()
                .flex_col()
                .gap(px(space::ML))
                .children(ACCESS_STEPS.iter().enumerate().map(|(i, text)| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(space::ML))
                        .child(step_badge(i + 1, &p))
                        .child(div().text_size(px(TypeSize::Body.points())).child(*text))
                })),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(space::ML))
                .child(button(
                    view,
                    "import-open-fda",
                    "Open Full Disk Access Settings",
                    true,
                    "import:openAccess",
                ))
                .child(button(
                    view,
                    "import-recheck",
                    "Check Again",
                    false,
                    "import:recheck",
                )),
        )
        .into_any_element()
}

fn file_drop(view: &ImportWindowView) -> gpui::AnyElement {
    let p = view.look.p;
    let emit = view.emit.clone();
    let selected = p.form_accent.opacity(0x26 as f32 / 255.0);
    let accent = p.form_accent;
    div()
        .id("import-drop")
        .debug_selector(|| "import-drop".into())
        .drag_over::<gpui::ExternalPaths>(move |style, _, _, _| {
            style.bg(selected).border_color(accent)
        })
        .on_drop(move |paths: &gpui::ExternalPaths, window, cx| {
            if let Some(path) = paths.paths().first() {
                emit.send(
                    Msg::Command(SharedString::from(format!(
                        "import:safariFile:{}",
                        path.to_string_lossy()
                    ))),
                    window,
                    cx,
                );
            }
        })
        .h(px(DROP_HEIGHT))
        .rounded(px(radius::PANEL))
        .border(px(1.))
        .border_dashed()
        .border_color(p.group_stroke)
        .bg(p.group_box)
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(space::ML))
        .child(symbol(
            view.host.as_ref(),
            "doc.zipper",
            24.0,
            32.0,
            SymbolWeight::Regular,
            p.text_secondary,
        ))
        .child(
            div()
                .text_size(px(TypeSize::Body.points()))
                .text_color(p.text_secondary)
                .child("Choose .zip file or drag it here"),
        )
        .child(button(
            view,
            "import-choose-zip",
            "Choose .zip file",
            false,
            "import:safariZip",
        ))
        .into_any_element()
}

fn error_text(error: Option<&str>, p: &crate::look::Palette) -> Option<gpui::AnyElement> {
    error.map(|text| {
        div()
            .mt(px(space::L))
            .text_size(px(TypeSize::Caption.points()))
            .text_color(p.destructive)
            .child(SharedString::from(text.to_owned()))
            .into_any_element()
    })
}

fn app_icon(view: &ImportWindowView, browser_id: &str, side: f32) -> gpui::AnyElement {
    match view.host.browser_icon(browser_id, side) {
        Some(image) => gpui::img(image)
            .size(px(side))
            .object_fit(gpui::ObjectFit::Contain)
            .into_any_element(),
        None => symbol(
            view.host.as_ref(),
            if browser_id == "safari" {
                "safari"
            } else {
                "globe"
            },
            side * 0.7,
            side,
            SymbolWeight::Regular,
            view.look.p.icon,
        ),
    }
}

pub fn safari_body(view: &ImportWindowView, access: bool, error: Option<&str>) -> gpui::AnyElement {
    let p = view.look.p;
    if access {
        return div()
            .debug_selector(|| "import-safari".into())
            .child(title_block(
                "Import from Safari".into(),
                Some("Ardia can read Safari directly. Bring your bookmarks, history, Reading List, open tabs and sign-ins into Ardia."),
                false,
                &p,
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(space::L))
                    .child(div().size(px(SAFARI_ICON)).flex().items_center().justify_center().child(app_icon(view, "safari", SAFARI_ICON)))
                    .child(
                        div()
                            .flex_1()
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_size(px(TypeSize::Body.points()))
                                    .child("Bookmarks, history, Reading List and tabs"),
                            )
                            .child(
                                div()
                                    .text_size(px(TypeSize::Small.points()))
                                    .text_color(p.text_secondary)
                                    .child("Full Disk Access is granted."),
                            )
                            .child(
                                div().mt(px(space::M)).debug_selector(|| "import-safari-cookies".into()).child(
                                    crate::primitives::controls::Checkbox::new(
                                        "import-safari-cookies",
                                        view.safari_cookies,
                                        "Cookies (stay signed in)",
                                        &p,
                                    )
                                    .on_toggle({
                                        let emit = view.emit.clone();
                                        move |_, window, cx| emit.send(command("import:safariCookies"), window, cx)
                                    }),
                                ),
                            ),
                    )
                    .child(button(view, "import-safari-direct", "Import from Safari", true, "import:safariDirect")),
            )
            .child(section(
                "Passwords and payment cards can't be read directly — import them from an export file:",
                &p,
            ))
            .child(file_drop(view))
            .children(error_text(error, &p))
            .into_any_element();
    }
    div()
        .debug_selector(|| "import-safari-access".into())
        .child(title_block(
            "Give Ardia access to Safari".into(),
            Some("To import Safari's bookmarks, history and tabs directly, Ardia needs Full Disk Access."),
            false,
            &p,
        ))
        .child(access_steps(view))
        .child(section("Or import everything (including passwords) from an export file:", &p))
        .child(
            div()
                .mb(px(space::L))
                .flex()
                .flex_col()
                .gap(px(space::S))
                .children(EXPORT_STEPS.iter().enumerate().map(|(i, text)| {
                    div()
                        .text_size(px(TypeSize::Small.points()))
                        .text_color(p.text_secondary)
                        .child(SharedString::from(format!("{}. {text}", i + 1)))
                })),
        )
        .child(file_drop(view))
        .children(error_text(error, &p))
        .into_any_element()
}

pub fn unlock_body(
    view: &ImportWindowView,
    browser_id: &str,
    browser_name: &str,
    many: bool,
    error: Option<&str>,
) -> gpui::AnyElement {
    let p = view.look.p;
    let lead = if many {
        "Some data is encrypted, so macOS will ask for your computer password once for each selected profile.".to_owned()
    } else {
        format!(
            "Some data is encrypted, so macOS will ask for your computer password to bring it securely into {APP}."
        )
    };
    let detail = format!(
        "macOS may ask whether {APP} can use “{}” from your keychain: it's the key {browser_name} encrypts passwords, cookies, cards and open tabs with. Click Allow. Your data stays on this Mac.",
        keychain_service(browser_id, browser_name)
    );
    div()
        .debug_selector(|| "import-unlock".into())
        .child(title_block(
            "Unlock your data for import".into(),
            Some("Ardia can securely import logins, cookies and cards from your previous browser, so you stay signed in and don't have to enter your passwords again."),
            false,
            &p,
        ))
        .child(
            div()
                .mt(px(space::ML))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(space::XL))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(space::XL))
                        .child(app_icon(view, browser_id, APP_ICON))
                        .child(symbol(view.host.as_ref(), "arrow.right", 16.0, 20.0, SymbolWeight::Regular, p.text_tertiary))
                        .child(symbol(view.host.as_ref(), "lock.fill", 30.0, APP_ICON, SymbolWeight::Regular, p.icon)),
                )
                .child(
                    div()
                        .max_w(px(TEXT_MAX))
                        .text_center()
                        .text_size(px(TypeSize::Body.points()))
                        .line_height(px(18.))
                        .child(SharedString::from(lead)),
                )
                .child(
                    div()
                        .max_w(px(TEXT_MAX))
                        .text_center()
                        .text_size(px(TypeSize::Small.points()))
                        .line_height(px(17.))
                        .text_color(p.text_secondary)
                        .child(SharedString::from(detail)),
                ),
        )
        .children(error_text(error, &p))
        .into_any_element()
}

pub fn listing_body(view: &ImportWindowView, listing: &ExtensionListing) -> gpui::AnyElement {
    let p = view.look.p;
    let total = listing.listed_count();
    let source = listing.source_name.as_str();
    let already: Vec<&str> = listing
        .left_out
        .iter()
        .filter(|e| e.reason == crate::host_data::LeftOutReason::Installed)
        .map(|e| e.name.as_str())
        .collect();
    let skipped: Vec<String> = listing
        .left_out
        .iter()
        .filter(|e| e.reason != crate::host_data::LeftOutReason::Installed)
        .map(|e| e.text())
        .collect();
    let small_centered = |text: String| {
        div()
            .text_center()
            .text_size(px(TypeSize::Small.points()))
            .text_color(p.text_secondary)
            .child(SharedString::from(text))
    };
    let caption_centered = |text: String| {
        div()
            .text_center()
            .text_size(px(TypeSize::Caption.points()))
            .text_color(p.text_secondary)
            .child(SharedString::from(text))
    };
    div()
        .debug_selector(|| "import-extensions".into())
        .w_full()
        .mt(px(space::XL))
        .flex()
        .flex_col()
        .gap(px(space::M))
        .when(total > 0, |this| {
            let one = total == 1;
            this.child(small_centered(format!(
                "{source} has {} from the Chrome Web Store, named as {source} lists {}. Add the ones you want from {} store {}:",
                super::plural(total, "extension"),
                if one { "it" } else { "them" },
                if one { "its" } else { "their" },
                if one { "page" } else { "pages" },
            )))
            .children(listing.targets.iter().map(|target| {
                let profile = target.profile_id.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::XS))
                    .child(
                        div()
                            .text_size(px(TypeSize::Small.points()))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(SharedString::from(format!(
                                "For {}:",
                                if target.profile_name.is_empty() { "this profile" } else { target.profile_name.as_str() }
                            ))),
                    )
                    .children(target.extensions.iter().map(|extension| {
                        let notes = source_notes(extension, source);
                        let host = view.host.clone();
                        let profile = profile.clone();
                        let url = extension.web_store_url.clone();
                        div()
                            .flex()
                            .items_center()
                            .gap(px(space::S))
                            .child(
                                div()
                                    .flex_1()
                                    .child(
                                        div().text_size(px(TypeSize::Small.points())).child(SharedString::from(if notes.is_empty() {
                                            extension.name.clone()
                                        } else {
                                            format!("{} ({notes})", extension.name)
                                        })),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(TypeSize::Caption.points()))
                                            .text_color(p.text_secondary)
                                            .child(SharedString::from(extension.id.clone())),
                                    ),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("import-store:{}", extension.id)))
                                    .text_size(px(TypeSize::Small.points()))
                                    .text_color(p.accent)
                                    .cursor_pointer()
                                    .on_click(move |_, _, _| host.open_extension_store_pages(profile.clone(), vec![url.clone()]))
                                    .child("Store Page"),
                            )
                    }))
            }))
            .child(if listing.store_opened {
                small_centered(format!(
                    "{} open in your sidebar. Click Add to {APP} on each one you want.",
                    if one { "Its page is" } else { "Their pages are" }
                ))
                .into_any_element()
            } else {
                let host = view.host.clone();
                let targets: Vec<(crate::host_data::ExtensionTarget, Vec<String>)> = listing
                    .targets
                    .iter()
                    .map(|t| (t.clone(), t.extensions.iter().map(|e| e.web_store_url.clone()).collect()))
                    .collect();
                div()
                    .flex()
                    .justify_center()
                    .child(
                        div().debug_selector(|| "import-open-store".into()).child(
                            PushButton::new(
                                "import-open-store",
                                if one { "Open in Chrome Web Store".to_owned() } else { format!("Open {total} in Chrome Web Store") },
                                &p,
                            )
                            .on_click(move |_, _, _| {
                                for (target, urls) in &targets {
                                    host.open_extension_store_pages(target.profile_id.clone(), urls.clone());
                                }
                                host.note_store_pages_opened();
                            }),
                        ),
                    )
                    .into_any_element()
            })
        })
        .when(!already.is_empty(), |this| {
            this.child(caption_centered(format!("Already in {APP}: {}.", already.join(", "))))
        })
        .when(!skipped.is_empty(), |this| {
            this.child(caption_centered(format!(
                "Can't be added from the Chrome Web Store: {}.",
                skipped.join(", ")
            )))
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_items_are_named_like_the_old_unlock_step() {
        assert_eq!(keychain_service("chrome", "Chrome"), "Chrome Safe Storage");
        assert_eq!(
            keychain_service("edge", "Edge"),
            "Microsoft Edge Safe Storage"
        );
        assert!(needs_unlock(&["bookmarks".into(), "passwords".into()]));
        assert!(!needs_unlock(&["bookmarks".into(), "history".into()]));
    }
}
