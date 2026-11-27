use std::rc::Rc;
use std::sync::Arc;

use ardia_state::{Action, ProfileId, ProfilePatch};
use ardia_theme::ProfileColor;
use ardia_theme::profile_theme::{LookSource, ProfileTheme, ShownLook, ThemeMode};
use gpui::{
    AnyElement, Hsla, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*,
    relative,
};

use crate::host::{ArcThemeChoice, NativeMenuItem, UiHost};
use crate::look::Palette;
use crate::msg::{Emit, Msg};
use crate::primitives::controls::Segmented;
use crate::primitives::icons::Icon;
use crate::scale::px;
use crate::theme_editor::{self as shared, Change, ThemeEditor};

pub const PREVIEW_HEIGHT: f32 = 58.0;
pub const SWATCH: f32 = 20.0;
pub const SWATCH_GAP: f32 = 8.0;
pub const STOP_COMMAND: &str = "settings:themeStop:";
pub const NO_ARC_THEMES: &str = "No Arc spaces with a theme found";
const NO_ARC_THEMES_ID: &str = "none";

pub struct ThemeTarget {
    pub profile: ProfileId,
    pub stored: Option<Arc<ProfileTheme>>,
    pub original: ProfileTheme,
    pub preset: ProfileColor,
    pub follows_app: bool,
    pub app_dark: bool,
}

impl ThemeTarget {
    pub fn source(&self) -> LookSource {
        if self.follows_app {
            LookSource::App
        } else {
            LookSource::Own
        }
    }

    pub fn look(&self) -> ProfileTheme {
        self.stored
            .as_deref()
            .cloned()
            .unwrap_or_else(|| self.original.clone())
    }

    pub fn edits_dark(&self) -> bool {
        self.stored
            .as_deref()
            .is_some_and(|stored| stored.requested_dark(self.app_dark, self.source()))
    }

    pub fn editing(&self) -> ProfileTheme {
        match self.stored.as_deref() {
            Some(stored) if stored.dark.is_some() => stored.resolved(self.edits_dark()),
            _ => self.look(),
        }
    }

    pub fn shown(&self) -> ShownLook {
        self.look().shown(self.app_dark, self.source())
    }

    pub fn detail(&self) -> String {
        match self.stored.as_deref() {
            Some(stored) if stored.dark.is_some() => format!(
                "Separate light and dark looks. Editing keeps the {} one.",
                if self.edits_dark() { "dark" } else { "light" }
            ),
            stored => preset_label(self.preset, stored.is_some()),
        }
    }

    pub fn kept(&self, next: ProfileTheme) -> Option<ProfileTheme> {
        (!shared::is_untouched(&next, &self.original)).then_some(next)
    }
}

pub fn preset_label(color: ProfileColor, edited: bool) -> String {
    let name = color.spec().name;
    if edited {
        format!("{name}, edited")
    } else {
        name.to_owned()
    }
}

pub fn store_theme(profile: &ProfileId, theme: Option<ProfileTheme>) -> Msg {
    Msg::Store(Action::UpdateProfile {
        profile: profile.clone(),
        patch: ProfilePatch {
            theme: Some(theme.map(Arc::new)),
            ..ProfilePatch::default()
        },
    })
}

pub const PREVIEW_WIDTH: f32 = 338.0;
const PREVIEW_PIXELS_PER_POINT: usize = 2;
const PREVIEW_RADIUS: f64 = 8.0;

fn corner_coverage(x: f64, y: f64, width: f64, height: f64, radius: f64) -> f64 {
    let radius = radius.min(width / 2.0).min(height / 2.0).max(0.0);
    let cx = x.clamp(radius, width - radius);
    let cy = y.clamp(radius, height - radius);
    let distance = (x - cx).hypot(y - cy);
    (radius - distance + 0.5).clamp(0.0, 1.0)
}

pub fn backdrop_pixels(
    look: &ardia_theme::ThemeLook,
    dark: bool,
    width: usize,
    height: usize,
) -> Vec<u8> {
    let scale = PREVIEW_PIXELS_PER_POINT as f64;
    let (w, h) = (width as f64 / scale, height as f64 / scale);
    let alpha = look.layer_alpha();
    let under = ardia_theme::profile_theme::backdrop_under_grey(look.underlay_alpha(dark), dark);
    let mut bgra = vec![0u8; width * height * 4];
    for row in 0..height {
        for col in 0..width {
            let (x, y) = ((col as f64 + 0.5) / scale, (row as f64 + 0.5) / scale);
            let area = look.area(x, y, w, h);
            let coverage = corner_coverage(x, y, w, h, PREVIEW_RADIUS);
            let channel = |v: f64| {
                ((alpha * v.clamp(0.0, 1.0) + (1.0 - alpha) * under) * coverage * 255.0).round()
                    as u8
            };
            let i = (row * width + col) * 4;
            bgra[i] = channel(area[2]);
            bgra[i + 1] = channel(area[1]);
            bgra[i + 2] = channel(area[0]);
            bgra[i + 3] = (coverage * 255.0).round() as u8;
        }
    }
    bgra
}

thread_local! {
    static PREVIEW_CACHE: std::cell::RefCell<Option<(String, bool, Arc<gpui::Image>)>> =
        const { std::cell::RefCell::new(None) };
}

fn backdrop_image(theme: &ProfileTheme, dark: bool) -> Arc<gpui::Image> {
    let key = theme.look.to_value().to_string();
    PREVIEW_CACHE.with(|cache| {
        if let Some((cached, cached_dark, image)) = cache.borrow().as_ref()
            && *cached == key
            && *cached_dark == dark
        {
            return Arc::clone(image);
        }
        let width = PREVIEW_WIDTH as usize * PREVIEW_PIXELS_PER_POINT;
        let height = PREVIEW_HEIGHT as usize * PREVIEW_PIXELS_PER_POINT;
        let pixels = backdrop_pixels(&theme.look, dark, width, height);
        let image = Arc::new(gpui::Image::from_bytes(
            gpui::ImageFormat::Bmp,
            shared::bmp(width, height, &pixels),
        ));
        *cache.borrow_mut() = Some((key, dark, Arc::clone(&image)));
        image
    })
}

fn preview(shown: &ShownLook, _p: &Palette) -> AnyElement {
    let theme = &shown.look;
    let dark = shown.dark;
    let line = if dark {
        gpui::hsla(0.0, 0.0, 1.0, 0.35)
    } else {
        gpui::hsla(0.0, 0.0, 0.0, 0.18)
    };
    let card = if dark {
        gpui::hsla(0.0, 0.0, 0.07, 0.72)
    } else {
        gpui::hsla(0.0, 0.0, 1.0, 0.82)
    };
    let backdrop = backdrop_image(theme, dark);
    div()
        .debug_selector(|| "theme-preview".into())
        .relative()
        .h(px(PREVIEW_HEIGHT))
        .rounded(px(8.))
        .overflow_hidden()
        .child(
            gpui::img(backdrop)
                .absolute()
                .size_full()
                .object_fit(gpui::ObjectFit::Fill),
        )
        .child(
            div()
                .absolute()
                .size_full()
                .p(px(6.))
                .flex()
                .gap(px(6.))
                .child(
                    div()
                        .w(px(36.))
                        .pt(px(4.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .children([1.0f32, 0.7, 0.85].into_iter().map(move |share| {
                            div().w(relative(share)).h(px(4.)).rounded(px(2.)).bg(line)
                        })),
                )
                .child(div().flex_1().rounded(px(4.)).bg(card)),
        )
        .into_any_element()
}

fn appearance_row(
    emit: &Emit,
    target: &ThemeTarget,
    editing: &ProfileTheme,
    p: &Palette,
) -> AnyElement {
    let shown = target.shown();
    let control = if target.follows_app {
        div()
            .flex_1()
            .min_w_0()
            .text_size(px(11.))
            .line_height(px(14.))
            .text_color(p.text_secondary)
            .child("Follows Settings › Appearance")
            .into_any_element()
    } else {
        let modes = [ThemeMode::Light, ThemeMode::Dark, ThemeMode::Auto];
        let index = modes
            .iter()
            .position(|mode| *mode == editing.mode)
            .unwrap_or(2);
        let emit = emit.clone();
        let base = target.look();
        let profile = target.profile.clone();
        Segmented::new("theme-mode", index, p)
            .option("Light", Some(Icon::Sun))
            .option("Dark", Some(Icon::Moon))
            .option("Match System", Some(Icon::HalfCircle))
            .on_select(move |picked, window, cx| {
                if let Some(mode) = modes.get(picked) {
                    let next = ProfileTheme {
                        mode: *mode,
                        ..base.clone()
                    };
                    emit.send(store_theme(&profile, Some(next)), window, cx);
                }
            })
            .into_any_element()
    };
    let kept = (shown.dark != shown.requested_dark).then(|| {
        div()
            .flex_1()
            .min_w_0()
            .ml(px(8.))
            .text_size(px(11.))
            .line_height(px(14.))
            .text_color(p.text_secondary)
            .child(format!(
                "Kept {} so text stays readable",
                if shown.dark { "dark" } else { "light" }
            ))
    });
    div()
        .flex()
        .flex_row()
        .items_center()
        .child(
            div()
                .w(px(shared::LABEL + 10.))
                .text_size(px(12.))
                .text_color(p.text)
                .child("Appearance"),
        )
        .child(control)
        .children(kept)
        .into_any_element()
}

fn merged_into_stored(target: &ThemeTarget, edited: ProfileTheme) -> ProfileTheme {
    match target.stored.as_deref() {
        Some(stored) if stored.dark.is_some() => {
            let mut next = stored.clone();
            if target.edits_dark() {
                next.dark = Some(edited.look);
            } else {
                next.look = edited.look;
            }
            next.mode = edited.mode;
            next
        }
        _ => edited,
    }
}

pub fn editor(
    emit: &Emit,
    host: &Arc<dyn UiHost>,
    target: ThemeTarget,
    selected: usize,
    p: &Palette,
) -> AnyElement {
    let editing = target.editing();
    let target = Rc::new(target);
    let on_change: Change = {
        let emit = emit.clone();
        let target = Rc::clone(&target);
        Rc::new(move |next, _settle, window, cx| {
            let merged = merged_into_stored(&target, next);
            emit.send(
                store_theme(&target.profile, target.kept(merged)),
                window,
                cx,
            );
        })
    };
    let on_select: shared::Pick = {
        let emit = emit.clone();
        Rc::new(move |index, window, cx| {
            emit.send(
                Msg::Command(SharedString::from(format!("{STOP_COMMAND}{index}"))),
                window,
                cx,
            );
        })
    };
    let on_reset: Option<shared::Action> = target.stored.is_some().then(|| {
        let emit = emit.clone();
        let profile = target.profile.clone();
        let host = Arc::clone(host);
        Rc::new(move |window: &mut Window, cx: &mut gpui::App| {
            host.note_theme_preset(crate::host::ThemePresetEvent::Reset);
            emit.send(store_theme(&profile, None), window, cx);
        }) as shared::Action
    });
    let on_texture_menu: shared::Action = {
        let emit = emit.clone();
        let host = Arc::clone(host);
        let target = Rc::clone(&target);
        let current = editing.clone();
        Rc::new(move |window, cx| {
            let Some(reply) = host.show_menu(shared::texture_menu_items(current.look.texture))
            else {
                return;
            };
            let emit = emit.clone();
            let next = current.clone();
            let profile = target.profile.clone();
            let kept_target = Rc::clone(&target);
            let chosen = move |id: String| -> Option<Msg> {
                let texture = ardia_theme::ThemeTexture::from_key(&id)?;
                let textured = shared::with_texture(&next, texture);
                let merged = merged_into_stored(&kept_target, textured);
                Some(store_theme(&profile, kept_target.kept(merged)))
            };
            window
                .spawn(cx, async move |cx| {
                    let Ok(Some(id)) = reply.await else {
                        return;
                    };
                    let Some(msg) = chosen(id) else {
                        return;
                    };
                    let _ = cx.update(|window, cx| emit.send(msg, window, cx));
                })
                .detach();
        })
    };
    let shown = target.shown();
    ThemeEditor {
        id: "settings-theme".into(),
        theme: editing.clone(),
        start: Some(target.original.clone()),
        selected,
        stacked: false,
        p: *p,
        on_change,
        on_select,
        on_reset,
        on_texture_menu,
        native_form: true,
    }
    .render_full(
        preview(&shown, p),
        appearance_row(emit, &target, &editing, p),
    )
}

pub fn swatches(
    emit: &Emit,
    profile: &ProfileId,
    chosen: Option<ProfileColor>,
    edited: Option<Hsla>,
    hovered: Option<ProfileColor>,
) -> AnyElement {
    div()
        .flex()
        .flex_wrap()
        .gap(px(SWATCH_GAP))
        .children(ProfileColor::ALL.into_iter().map(|color| {
            let selected = chosen == Some(color);
            let hover = hovered == Some(color);
            let ring = match edited {
                Some(accent) if selected => accent,
                _ => crate::primitives::theme_bridge::hsla(color.spec().swatch),
            };
            let disc = if selected {
                SWATCH - 12.0
            } else if hover {
                SWATCH - 6.0
            } else {
                SWATCH - 8.0
            };
            let hover_emit = emit.clone();
            div()
                .id(SharedString::from(format!("preset:{}", color.key())))
                .debug_selector(move || format!("preset:{}", color.key()))
                .relative()
                .size(px(SWATCH))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .when(selected, |this| {
                    this.child(
                        div()
                            .absolute()
                            .size_full()
                            .rounded_full()
                            .border(px(2.))
                            .border_color(ring),
                    )
                })
                .child(
                    div()
                        .size(px(disc))
                        .rounded_full()
                        .bg(ring)
                        .opacity(if hover || selected { 1.0 } else { 0.85 }),
                )
                .on_hover(move |inside, window, cx| {
                    hover_emit.send(
                        Msg::Command(SharedString::from(format!(
                            "settings:swatchHover:{}:{}",
                            if *inside { "in" } else { "out" },
                            color.key()
                        ))),
                        window,
                        cx,
                    )
                })
                .on_click(emit.click(Msg::Store(Action::UpdateProfile {
                    profile: profile.clone(),
                    patch: ProfilePatch {
                        color: Some(color),
                        theme: Some(None),
                        ..ProfilePatch::default()
                    },
                })))
        }))
        .into_any_element()
}

pub fn arc_menu_items(choices: &[ArcThemeChoice]) -> Vec<NativeMenuItem> {
    if choices.is_empty() {
        return vec![NativeMenuItem::new(NO_ARC_THEMES_ID, NO_ARC_THEMES, "").enabled(false)];
    }
    choices
        .iter()
        .map(|choice| {
            NativeMenuItem::new(&choice.id, choice.title.clone(), "").swatch(choice.swatch)
        })
        .collect()
}

pub fn arc_pick(choices: &[ArcThemeChoice], picked: &str) -> Option<ProfileTheme> {
    choices
        .iter()
        .find(|choice| choice.id == picked)
        .map(|choice| choice.theme.clone())
}

pub fn import_from_arc(
    emit: Emit,
    host: Arc<dyn UiHost>,
    profile: ProfileId,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    let themes = host.arc_themes();
    window
        .spawn(cx, async move |cx| {
            let choices = themes.await.unwrap_or_default();
            let Some(reply) = host.show_menu(arc_menu_items(&choices)) else {
                return;
            };
            let Ok(Some(picked)) = reply.await else {
                return;
            };
            let Some(theme) = arc_pick(&choices, &picked) else {
                return;
            };
            let _ =
                cx.update(|window, cx| emit.send(store_theme(&profile, Some(theme)), window, cx));
        })
        .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preview_backdrop_follows_the_arc_gradient_and_rounds_its_corners() {
        let theme = shared::preset_starting_theme(ProfileColor::Green.spec().swatch);
        let (w, h) = (40, 20);
        let pixels = backdrop_pixels(&theme.look, true, w, h);
        assert_eq!(pixels.len(), w * h * 4);
        assert_eq!(pixels[3], 0);
        let middle = (10 * w + 20) * 4;
        assert_eq!(pixels[middle + 3], 255);
        let plain = backdrop_pixels(&theme.look, true, w, h);
        assert_eq!(pixels, plain);
    }

    fn choice(id: &str) -> ArcThemeChoice {
        ArcThemeChoice {
            id: id.to_owned(),
            title: format!("🌿  {id}"),
            swatch: 0x336699,
            theme: shared::preset_starting_theme(ProfileColor::Green.spec().swatch),
        }
    }

    #[test]
    fn with_no_arc_themes_the_menu_says_so_and_cannot_be_picked() {
        let items = arc_menu_items(&[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, NO_ARC_THEMES);
        assert!(!items[0].enabled);
        assert!(arc_pick(&[], NO_ARC_THEMES_ID).is_none());
    }

    #[test]
    fn arc_spaces_list_with_their_swatch_and_picking_one_returns_its_theme() {
        let choices = vec![choice("work"), choice("home")];
        let items = arc_menu_items(&choices);
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["work", "home"]
        );
        assert_eq!(items[1].swatch, Some(0x336699));
        assert_eq!(arc_pick(&choices, "home"), Some(choices[1].theme.clone()));
    }

    #[test]
    fn the_preset_label_marks_edits() {
        assert_eq!(
            preset_label(ProfileColor::Green, false),
            ProfileColor::Green.spec().name
        );
        assert!(preset_label(ProfileColor::Green, true).ends_with(", edited"));
    }
}
