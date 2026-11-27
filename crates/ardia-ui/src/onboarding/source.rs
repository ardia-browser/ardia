use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, FontWeight, Image, ImageFormat, IntoElement, ParentElement, SharedString,
    Styled, div, img, prelude::*,
};

use super::OnboardingWindowView;
use super::flow::Source;
use super::parts::{self, BUTTON_HEIGHT, Ink};
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::scale::px;
use crate::window::motion::{Curve, Motion};

pub const LAYOUT_SHIFT: Duration = Duration::from_millis(300);
pub const SWAP_IN: Duration = Duration::from_millis(300);
pub const SWAP_OUT: Duration = Duration::from_millis(150);
pub const IMPORT_FLOW_MS: f32 = 2400.0;

pub const FLOW_ICON: f32 = 88.0;
pub const FLOW_PATH: f32 = 196.0;
pub const FLOW_GLYPH: f32 = 28.0;
pub const FLOW_GLYPH_SYMBOL: f32 = 12.0;
pub const FLOW_DOTS: usize = 9;
pub const FLOW_DOT: f32 = 3.0;
pub const FLOW_TEXT_WIDTH: f32 = 300.0;
pub const FLOW_ARROW: f32 = 22.0;
pub const ROW_WIDTH: f32 = FLOW_ICON * 2.0 + FLOW_PATH + space::L * 2.0;
pub const CENTER_X: f32 = (ROW_WIDTH - FLOW_ICON) / 2.0;
pub const CAPTION_TOP: f32 = FLOW_ICON + space::HUGE;
pub const GLYPHS: [&str; 4] = ["bookmark", "clock", "key", "square.on.square"];
pub const FADE_AT: f32 = 0.18;
pub const SOURCE_TILE_HEIGHT: f32 = 68.0;
pub const SOURCE_TILE_ICON: f32 = 30.0;
pub const PICK_MARK: f32 = FLOW_ICON * 0.64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Tag,
    Idle,
    Busy,
}

impl Shape {
    pub const fn guess(self) -> f32 {
        match self {
            Shape::Tag => 20.0,
            Shape::Idle => 83.0,
            Shape::Busy => 43.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    source: Source,
    name: &'static str,
    app: &'static str,
    import_id: Option<&'static str>,
    only_when_found: bool,
    listed_only: bool,
}

const fn app(source: Source, name: &'static str, app: &'static str) -> Candidate {
    Candidate {
        source,
        name,
        app,
        import_id: None,
        only_when_found: false,
        listed_only: false,
    }
}

const fn variant(
    source: Source,
    name: &'static str,
    path: &'static str,
    import_id: &'static str,
) -> Candidate {
    Candidate {
        import_id: Some(import_id),
        ..app(source, name, path)
    }
}

const fn found_only(source: Source, name: &'static str, path: &'static str) -> Candidate {
    Candidate {
        only_when_found: true,
        ..app(source, name, path)
    }
}

const fn listed(source: Source, name: &'static str) -> Candidate {
    Candidate {
        only_when_found: true,
        listed_only: true,
        ..app(source, name, "")
    }
}

const GROUPS: &[&[Candidate]] = &[
    &[app(Source::Arc, "Arc", "/Applications/Arc.app")],
    &[app(Source::Dia, "Dia", "/Applications/Dia.app")],
    &[app(
        Source::Chrome,
        "Chrome",
        "/Applications/Google Chrome.app",
    )],
    &[
        app(
            Source::Safari,
            "Safari",
            "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app",
        ),
        app(Source::Safari, "Safari", "/Applications/Safari.app"),
    ],
    &[app(Source::Firefox, "Firefox", "/Applications/Firefox.app")],
    &[
        app(Source::Zen, "Zen", "/Applications/Zen.app"),
        app(Source::Zen, "Zen", "/Applications/Zen Browser.app"),
        app(
            Source::Zen,
            "Zen Twilight",
            "/Applications/Zen Twilight.app",
        ),
    ],
    &[
        app(Source::Brave, "Brave", "/Applications/Brave Browser.app"),
        variant(
            Source::Brave,
            "Brave Beta",
            "/Applications/Brave Browser Beta.app",
            "braveBeta",
        ),
        variant(
            Source::Brave,
            "Brave Nightly",
            "/Applications/Brave Browser Nightly.app",
            "braveNightly",
        ),
        app(Source::Edge, "Edge", "/Applications/Microsoft Edge.app"),
        variant(
            Source::Edge,
            "Edge Beta",
            "/Applications/Microsoft Edge Beta.app",
            "edgeBeta",
        ),
    ],
    &[found_only(
        Source::Helium,
        "Helium",
        "/Applications/Helium.app",
    )],
    &[listed(Source::Chromium, "Chromium")],
    &[listed(Source::Vivaldi, "Vivaldi")],
    &[listed(Source::Opera, "Opera")],
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceTile {
    pub source: Source,
    pub name: String,
    pub found: bool,
    pub app: Option<&'static str>,
    pub import_id: Option<&'static str>,
}

pub fn source_tiles(exists: impl Fn(&str) -> bool) -> Vec<SourceTile> {
    GROUPS
        .iter()
        .filter(|group| !group[0].listed_only)
        .filter_map(|group| {
            if let Some(found) = group.iter().find(|c| !c.app.is_empty() && exists(c.app)) {
                return Some(SourceTile {
                    source: found.source,
                    name: found.name.to_owned(),
                    found: true,
                    app: Some(found.app),
                    import_id: found.import_id,
                });
            }
            if group.iter().all(|c| c.only_when_found) {
                return None;
            }
            let mut names: Vec<&str> = Vec::new();
            for c in group.iter().filter(|c| c.import_id.is_none()) {
                if !names.contains(&c.name) {
                    names.push(c.name);
                }
            }
            let families: Vec<&str> = names
                .iter()
                .copied()
                .filter(|name| {
                    !names
                        .iter()
                        .any(|other| other != name && name.starts_with(&format!("{other} ")))
                })
                .collect();
            Some(SourceTile {
                source: group[0].source,
                name: families.join(" or "),
                found: false,
                app: None,
                import_id: None,
            })
        })
        .collect()
}

macro_rules! bundled {
    ($($source:ident => $file:literal),+ $(,)?) => {
        fn bundled_bytes(source: Source) -> Option<&'static [u8]> {
            match source {
                $(Source::$source => Some(include_bytes!(concat!("../../assets/onboarding/browsers/", $file))),)+
                _ => None,
            }
        }
    };
}

bundled! {
    Arc => "arc.png",
    Dia => "dia.png",
    Chrome => "chrome.png",
    Safari => "safari.png",
    Firefox => "firefox.png",
    Zen => "zen.png",
    Brave => "brave.png",
    Edge => "edge.png",
    Helium => "helium.png",
}

fn bundled_image(source: Source) -> Option<Arc<Image>> {
    static CACHE: OnceLock<Vec<(Source, Arc<Image>)>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            Source::ALL
                .iter()
                .filter_map(|s| {
                    bundled_bytes(*s).map(|b| {
                        (
                            *s,
                            Arc::new(Image::from_bytes(ImageFormat::Png, b.to_vec())),
                        )
                    })
                })
                .collect()
        })
        .iter()
        .find(|(s, _)| *s == source)
        .map(|(_, image)| Arc::clone(image))
}

pub fn app_icon() -> Arc<Image> {
    static ICON: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(ICON.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("../../assets/onboarding/app-icon.png").to_vec(),
        ))
    }))
}

pub fn glide(motion: &mut Motion, to: f32, now: Instant) {
    if (motion.target() - to).abs() > f32::EPSILON {
        motion.go(to, LAYOUT_SHIFT, Curve::EaseOut, now);
    }
}

#[derive(Clone, Debug)]
pub struct SwapLayer<T> {
    pub key: String,
    pub item: T,
    pub live: bool,
    pub opacity: Motion,
}

#[derive(Clone, Debug)]
pub struct Swap<T> {
    pub key: Option<String>,
    pub layers: Vec<SwapLayer<T>>,
}

impl<T: Clone> Default for Swap<T> {
    fn default() -> Self {
        Swap {
            key: None,
            layers: Vec::new(),
        }
    }
}

impl<T: Clone> Swap<T> {
    pub fn show(&mut self, item: Option<(String, T)>, now: Instant) {
        let key = item.as_ref().map(|(k, _)| k.clone());
        if key == self.key {
            if let Some((_, item)) = item
                && let Some(live) = self.layers.iter_mut().find(|l| l.live)
            {
                live.item = item;
            }
            return;
        }
        let first = self.key.is_none() && self.layers.is_empty();
        self.key = key;
        for layer in &mut self.layers {
            if layer.live {
                layer.live = false;
                layer.opacity.go(0.0, SWAP_OUT, Curve::EaseOut, now);
            }
        }
        let Some((key, item)) = item else {
            return;
        };
        if let Some(same) = self.layers.iter_mut().find(|l| l.key == key) {
            same.item = item;
            same.live = true;
            same.opacity.go(1.0, SWAP_IN, Curve::EaseOut, now);
            return;
        }
        if self.layers.len() >= 2 {
            let quietest = self
                .layers
                .iter()
                .enumerate()
                .min_by(|a, b| a.1.opacity.value(now).total_cmp(&b.1.opacity.value(now)))
                .map_or(0, |(i, _)| i);
            self.layers.remove(quietest);
        }
        let mut opacity = Motion::rest(if first { 1.0 } else { 0.0 });
        if !first {
            opacity.go(1.0, SWAP_IN, Curve::EaseOut, now);
        }
        self.layers.push(SwapLayer {
            key,
            item,
            live: true,
            opacity,
        });
    }

    pub fn settle(&mut self, now: Instant) -> bool {
        self.layers
            .retain(|l| l.live || l.opacity.running(now) || l.opacity.value(now) > 0.0);
        self.layers.iter().any(|l| l.opacity.running(now))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Caption {
    Tag(String),
    Import {
        busy: bool,
        name: String,
        done: bool,
        from: String,
    },
}

impl Caption {
    fn key(&self) -> String {
        match self {
            Caption::Tag(label) => format!("tag:{label}"),
            Caption::Import { .. } => "import".into(),
        }
    }

    fn shape(&self) -> Shape {
        match self {
            Caption::Tag(_) => Shape::Tag,
            Caption::Import { busy: true, .. } => Shape::Busy,
            Caption::Import { .. } => Shape::Idle,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SourceMotion {
    row_y: Motion,
    ardia_x: Motion,
    list_y: Motion,
    list_opacity: Motion,
    path_opacity: Motion,
    flow_fade: Motion,
    flow_started: Option<Instant>,
    marks: Swap<Source>,
    captions: Swap<Caption>,
    titles: Swap<(String, bool)>,
    texts: Swap<String>,
    buttons: Swap<String>,
    placed: bool,
}

impl Default for SourceMotion {
    fn default() -> Self {
        SourceMotion {
            row_y: Motion::rest(0.0),
            ardia_x: Motion::rest(CENTER_X),
            list_y: Motion::rest(0.0),
            list_opacity: Motion::rest(0.0),
            path_opacity: Motion::rest(0.0),
            flow_fade: Motion::rest(0.0),
            flow_started: None,
            marks: Swap::default(),
            captions: Swap::default(),
            titles: Swap::default(),
            texts: Swap::default(),
            buttons: Swap::default(),
            placed: false,
        }
    }
}

pub fn list_height(count: usize) -> f32 {
    if count == 0 {
        return 0.0;
    }
    let per_row = ((FLOW_TEXT_WIDTH + space::XL) / (PICK_MARK + space::XL))
        .floor()
        .max(1.0) as usize;
    let rows = count.div_ceil(per_row) as f32;
    let row = PICK_MARK + space::S + 14.0;
    rows * row + (rows - 1.0) * space::XL + space::HUGE + FLOW_ARROW
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SourceLayout {
    pub stage: f32,
    pub top: f32,
    pub ardia_y: f32,
    pub rest_caption_top: f32,
}

pub fn source_layout(
    listed: usize,
    tile: bool,
    caption: Option<Shape>,
    list_shown: bool,
) -> SourceLayout {
    let list_block = list_height(listed) + space::HUGE;
    let chosen = |shape: Shape| CAPTION_TOP + shape.guess();
    let stage = (if listed > 0 {
        list_block + FLOW_ICON
    } else {
        0.0
    })
    .max(chosen(Shape::Idle))
    .max(chosen(Shape::Busy))
    .max(chosen(Shape::Tag));
    let pick_height = (if list_shown { list_block } else { 0.0 })
        + FLOW_ICON
        + if caption.is_some() {
            space::HUGE + Shape::Tag.guess()
        } else {
            0.0
        };
    let top = (stage
        - match caption {
            Some(shape) if tile => chosen(shape),
            _ => pick_height,
        })
        / 2.0;
    let ardia_y = if tile {
        top
    } else {
        top + if list_shown { list_block } else { 0.0 }
    };
    SourceLayout {
        stage,
        top,
        ardia_y,
        rest_caption_top: (stage - chosen(Shape::Idle)) / 2.0 + CAPTION_TOP,
    }
}

pub fn flow_point(t: f32, phase: f32) -> (f32, f32, f32) {
    let u = (t + phase).rem_euclid(1.0);
    let x = (FLOW_PATH - FLOW_GLYPH) * u;
    let lift = -space::S * (1.0 - (2.0 * u - 1.0).abs());
    let opacity = if u < FADE_AT {
        u / FADE_AT
    } else if u > 1.0 - FADE_AT {
        (1.0 - u) / FADE_AT
    } else {
        1.0
    };
    (x, lift, opacity)
}

impl OnboardingWindowView {
    pub(crate) fn browser_mark(
        &self,
        source: Option<&SourceTile>,
        side: f32,
        ink: &Ink,
    ) -> AnyElement {
        let image = source.and_then(|tile| {
            tile.app
                .and_then(|path| self.host.file_icon(path, side.max(64.)))
                .or_else(|| bundled_image(tile.source))
        });
        match image {
            Some(image) => img(image).size(px(side)).flex_none().into_any_element(),
            None => div()
                .flex_none()
                .size(px(side))
                .rounded(px(radius::HERO))
                .bg(ink.icon_container)
                .flex()
                .items_center()
                .justify_center()
                .child(symbol(
                    self.host.as_ref(),
                    "globe",
                    side / 3.0,
                    side / 2.0,
                    SymbolWeight::Regular,
                    ink.subtitle,
                ))
                .into_any_element(),
        }
    }

    pub(crate) fn tile_image(&self, tile: &SourceTile) -> Option<Arc<Image>> {
        bundled_image(tile.source)
            .or_else(|| tile.app.and_then(|path| self.host.file_icon(path, 64.)))
    }

    pub(crate) fn ring_of(&mut self, image: Option<Arc<Image>>) -> Option<parts::TileRing> {
        let image = image?;
        let key = image.id();
        let theme = match self.ring_themes.iter().find(|(k, _)| *k == key) {
            Some((_, theme)) => *theme,
            None => {
                let theme = self.host.icon_theme_of(image.bytes());
                if self.ring_themes.len() > 64 {
                    self.ring_themes.remove(0);
                }
                self.ring_themes.push((key, theme));
                theme
            }
        };
        if theme == ardia_theme::IconTheme::Default {
            return None;
        }
        let style = if self.look.glass {
            ardia_theme::SelectionStyle::Glass
        } else {
            ardia_theme::SelectionStyle::Classic
        };
        let look = crate::sidebar::pinned_grid::tile_look(&ardia_theme::dock_selection(
            theme,
            &self.look.theme.roles,
            style,
        ));
        let fill = match theme {
            ardia_theme::IconTheme::Blur { mean, .. } => look
                .fill
                .blend(crate::primitives::theme_bridge::hsla(mean).opacity(0.22)),
            _ => look.fill,
        };
        Some(parts::TileRing {
            ring: look.ring.map(|(color, width)| match theme {
                ardia_theme::IconTheme::Blur { mean, .. } => (
                    crate::primitives::theme_bridge::hsla(mean).opacity(0.85),
                    width,
                ),
                _ => (color, width),
            }),
            inner: look.inner,
            fill,
        })
    }

    pub(crate) fn source_tile_content(&self, tile: Option<&SourceTile>, ink: &Ink) -> AnyElement {
        let image = tile.and_then(|tile| {
            tile.app
                .and_then(|path| self.host.file_icon(path, 64.))
                .or_else(|| bundled_image(tile.source))
        });
        match image {
            Some(image) => img(image)
                .size(px(SOURCE_TILE_ICON))
                .flex_none()
                .into_any_element(),
            None => div()
                .m(px(space::XXS))
                .size(px(26.))
                .rounded(px(radius::TILE))
                .bg(ink.icon_container)
                .flex()
                .items_center()
                .justify_center()
                .child(symbol(
                    self.host.as_ref(),
                    if tile.is_some() { "globe" } else { "sparkles" },
                    13.,
                    16.,
                    SymbolWeight::Regular,
                    ink.subtitle,
                ))
                .into_any_element(),
        }
    }

    pub(crate) fn source_preview(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let now = Instant::now();
        let ink = self.ink();
        let source = self.flow.source;
        let tile = source
            .filter(|s| *s != Source::Fresh)
            .and_then(|s| self.tiles.iter().find(|t| t.source == s).cloned());
        let fresh = source == Some(Source::Fresh);
        let found: Vec<SourceTile> = self
            .tiles
            .iter()
            .filter(|t| t.found)
            .take(6)
            .cloned()
            .collect();
        let can_import = tile.as_ref().is_some_and(|t| t.found);
        let progress = self.host.import_progress();
        let finished = progress.as_ref().is_some_and(|p| p.finished);
        let failed = progress.as_ref().is_some_and(|p| {
            p.finished && (p.error.is_some() || !crate::import::failures(p).is_empty())
        });
        let succeeded = finished && !failed;
        let running = tile
            .as_ref()
            .is_some_and(|t| can_import && self.importing == Some(t.source) && !failed);
        let done = running && succeeded;
        let list_shown = tile.is_none() && !fresh && !found.is_empty();
        let preset = tile
            .as_ref()
            .map(|t| t.source)
            .or(source)
            .unwrap_or(Source::Dia);
        let tag = format!("Starts out {}-style", preset.name());
        let caption = match (&tile, fresh) {
            (Some(t), _) if can_import => Some(Caption::Import {
                busy: running,
                name: t.name.clone(),
                done,
                from: progress
                    .as_ref()
                    .filter(|_| done)
                    .map_or_else(|| t.name.clone(), |p| p.source.clone()),
            }),
            (Some(_), _) | (None, true) => Some(Caption::Tag(tag)),
            _ => None,
        };
        let layout = source_layout(
            found.len(),
            tile.is_some(),
            caption.as_ref().map(Caption::shape),
            list_shown,
        );
        let motion = &mut self.source_motion;
        let flowing = tile.is_some() && can_import && !done;
        if !motion.placed {
            motion.placed = true;
            motion.row_y.snap(layout.ardia_y);
            motion.ardia_x.snap(if tile.is_some() {
                ROW_WIDTH - FLOW_ICON
            } else {
                CENTER_X
            });
            motion.list_y.snap(layout.top);
            motion.list_opacity.snap(if list_shown { 1.0 } else { 0.0 });
            motion
                .path_opacity
                .snap(if tile.is_some() { 1.0 } else { 0.0 });
        }
        glide(&mut motion.row_y, layout.ardia_y, now);
        glide(
            &mut motion.ardia_x,
            if tile.is_some() {
                ROW_WIDTH - FLOW_ICON
            } else {
                CENTER_X
            },
            now,
        );
        glide(&mut motion.list_y, layout.top, now);
        glide(
            &mut motion.list_opacity,
            if list_shown { 1.0 } else { 0.0 },
            now,
        );
        glide(
            &mut motion.path_opacity,
            if tile.is_some() { 1.0 } else { 0.0 },
            now,
        );
        glide(&mut motion.flow_fade, if flowing { 1.0 } else { 0.0 }, now);
        if flowing && motion.flow_started.is_none() {
            motion.flow_started = Some(now);
        }
        if !flowing && !motion.flow_fade.running(now) && motion.flow_fade.value(now) <= 0.0 {
            motion.flow_started = None;
        }
        motion.marks.show(
            tile.as_ref().map(|t| (t.source.key().to_owned(), t.source)),
            now,
        );
        motion
            .captions
            .show(caption.clone().map(|c| (c.key(), c)), now);
        if let Some(Caption::Import {
            busy,
            name,
            done,
            from,
        }) = &caption
        {
            let title = if *done {
                format!("Imported from {from}")
            } else if *busy {
                format!("Importing from {name}…")
            } else {
                format!("Bring your stuff from {name}")
            };
            motion
                .titles
                .show(Some((title.clone(), (title, *done))), now);
            let text = if *busy {
                "It runs in its own window. Carry on here."
            } else {
                "Bookmarks, history, passwords and tabs."
            };
            motion.texts.show(Some((text.into(), text.into())), now);
            motion
                .buttons
                .show((!busy).then(|| (name.clone(), name.clone())), now);
        }
        let mut moving = motion.marks.settle(now)
            | motion.captions.settle(now)
            | motion.titles.settle(now)
            | motion.texts.settle(now)
            | motion.buttons.settle(now);
        for m in [
            &motion.row_y,
            &motion.ardia_x,
            &motion.list_y,
            &motion.list_opacity,
            &motion.path_opacity,
            &motion.flow_fade,
        ] {
            moving |= m.running(now);
        }
        let flow_t = motion
            .flow_started
            .map(|at| (now.duration_since(at).as_secs_f32() * 1000.0 / IMPORT_FLOW_MS).fract());
        if moving || flow_t.is_some() {
            window.request_animation_frame();
        }
        let row_y = motion.row_y.value(now);
        let ardia_x = motion.ardia_x.value(now);
        let list_y = motion.list_y.value(now);
        let list_opacity = motion.list_opacity.value(now);
        let path_opacity = motion.path_opacity.value(now);
        let flow_fade = motion.flow_fade.value(now);
        let caption_top = row_y + CAPTION_TOP;
        let marks: Vec<(Source, f32)> = motion
            .marks
            .layers
            .iter()
            .map(|l| (l.item, l.opacity.value(now)))
            .collect();
        #[expect(
            clippy::needless_collect,
            reason = "the collect ends the borrow of self before the &mut self and cx calls below"
        )]
        let captions: Vec<(Caption, f32, bool)> = motion
            .captions
            .layers
            .iter()
            .map(|l| (l.item.clone(), l.opacity.value(now), l.live))
            .collect();
        let titles: Vec<((String, bool), f32)> = motion
            .titles
            .layers
            .iter()
            .map(|l| (l.item.clone(), l.opacity.value(now)))
            .collect();
        let texts: Vec<(String, f32)> = motion
            .texts
            .layers
            .iter()
            .map(|l| (l.item.clone(), l.opacity.value(now)))
            .collect();
        let buttons: Vec<(String, f32, bool)> = motion
            .buttons
            .layers
            .iter()
            .map(|l| (l.item.clone(), l.opacity.value(now), l.live))
            .collect();
        let pick_list = div()
            .absolute()
            .top(px(list_y))
            .left_0()
            .right_0()
            .opacity(list_opacity)
            .flex()
            .flex_col()
            .items_center()
            .gap(px(space::HUGE))
            .child(
                div()
                    .max_w(px(FLOW_TEXT_WIDTH))
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .justify_center()
                    .gap(px(space::XL))
                    .children(found.iter().map(|t| {
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(space::S))
                            .child(self.browser_mark(Some(t), PICK_MARK, &ink))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .line_height(px(14.))
                                    .text_color(ink.subtitle)
                                    .child(SharedString::from(t.name.clone())),
                            )
                    })),
            )
            .child(symbol(
                self.host.as_ref(),
                "arrow.down",
                16.,
                FLOW_ARROW,
                SymbolWeight::Medium,
                ink.steps,
            ));
        let marks_el = marks.iter().map(|(source, opacity)| {
            let tile = self.tiles.iter().find(|t| t.source == *source).cloned();
            div()
                .absolute()
                .left_0()
                .top(px(row_y))
                .opacity(*opacity)
                .child(self.browser_mark(tile.as_ref(), FLOW_ICON, &ink))
                .into_any_element()
        });
        let glyph_flow = div()
            .absolute()
            .left(px(FLOW_ICON + space::L))
            .top(px(row_y + (FLOW_ICON - FLOW_GLYPH) / 2.0))
            .w(px(FLOW_PATH))
            .h(px(FLOW_GLYPH))
            .opacity(path_opacity)
            .flex()
            .items_center()
            .child(
                div()
                    .w_full()
                    .px(px(space::XS))
                    .flex()
                    .flex_row()
                    .justify_between()
                    .children((0..FLOW_DOTS).map(|_| {
                        div()
                            .size(px(FLOW_DOT))
                            .rounded_full()
                            .bg(ink.progress_track)
                    })),
            )
            .children(
                flow_t
                    .into_iter()
                    .flat_map(|t| {
                        GLYPHS
                            .iter()
                            .enumerate()
                            .map(move |(i, name)| (t, i, *name))
                    })
                    .map(|(t, i, name)| {
                        let (x, lift, opacity) = flow_point(t, i as f32 / GLYPHS.len() as f32);
                        div()
                            .absolute()
                            .left(px(x))
                            .top(px(lift))
                            .opacity(opacity * flow_fade)
                            .child(
                                parts::choice_card(FLOW_GLYPH / 2.0, false, false, &ink)
                                    .size(px(FLOW_GLYPH))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(symbol(
                                        self.host.as_ref(),
                                        name,
                                        FLOW_GLYPH_SYMBOL,
                                        FLOW_GLYPH / 2.0,
                                        SymbolWeight::Medium,
                                        ink.flow_glyph,
                                    )),
                            )
                            .into_any_element()
                    }),
            );
        let ardia = div()
            .absolute()
            .left(px(ardia_x))
            .top(px(row_y))
            .child(img(app_icon()).size(px(FLOW_ICON)));
        let host = self.host.clone();
        let captions_el: Vec<AnyElement> = captions
            .into_iter()
            .map(|(caption, opacity, live)| {
                let body = match &caption {
                    Caption::Tag(label) => parts::tag(label.clone(), &ink),
                    Caption::Import { .. } => {
                        let titles = titles.iter().map(|((title, done), o)| {
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .right_0()
                                .opacity(*o)
                                .flex()
                                .flex_row()
                                .justify_center()
                                .items_center()
                                .gap(px(space::S))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(ink.title)
                                        .child(SharedString::from(title.clone())),
                                )
                                .when(*done, |this| {
                                    this.child(parts::check_ring(true, true, &ink))
                                })
                                .into_any_element()
                        });
                        let texts = texts.iter().map(|(text, o)| {
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .right_0()
                                .opacity(*o)
                                .text_size(px(12.))
                                .line_height(px(15.))
                                .text_center()
                                .text_color(ink.row_subtitle)
                                .child(SharedString::from(text.clone()))
                                .into_any_element()
                        });
                        let has_button = buttons.iter().any(|(_, _, live)| *live);
                        let buttons_el = buttons.iter().map(|(name, o, live)| {
                            let chosen = self.flow.source;
                            let click: parts::Click =
                                Box::new(cx.listener(move |this, _: &gpui::ClickEvent, _, cx| {
                                    if let Some(source) = chosen {
                                        this.open_import(source, cx);
                                    }
                                }));
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .right_0()
                                .opacity(*o)
                                .flex()
                                .justify_center()
                                .when(!*live, |this| this.occlude())
                                .child(parts::secondary_button(
                                    "onboarding-import",
                                    format!("Import from {name}"),
                                    true,
                                    &ink,
                                    click,
                                ))
                                .into_any_element()
                        });
                        div()
                            .w(px(FLOW_TEXT_WIDTH))
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(space::L))
                            .child(
                                div()
                                    .w_full()
                                    .flex()
                                    .flex_col()
                                    .gap(px(space::XS))
                                    .child(div().relative().w_full().h(px(16.)).children(titles))
                                    .child(div().relative().w_full().h(px(15.)).children(texts)),
                            )
                            .child(
                                div()
                                    .relative()
                                    .w_full()
                                    .h(px(if has_button { BUTTON_HEIGHT } else { 0.0 }))
                                    .children(buttons_el),
                            )
                            .into_any_element()
                    }
                };
                div()
                    .absolute()
                    .top(px(caption_top))
                    .left_0()
                    .right_0()
                    .opacity(opacity)
                    .flex()
                    .justify_center()
                    .when(!live, |this| this.occlude())
                    .child(body)
                    .into_any_element()
            })
            .collect();
        drop(host);
        div()
            .id("onboarding-source-preview")
            .debug_selector(|| "onboarding-source-preview".into())
            .relative()
            .w(px(ROW_WIDTH))
            .h(px(layout.stage))
            .child(pick_list)
            .children(marks_el)
            .child(glyph_flow)
            .child(ardia)
            .children(captions_el)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiles_group_brave_and_edge_and_hide_found_only_browsers() {
        let none = source_tiles(|_| false);
        let names: Vec<&str> = none.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Arc",
                "Dia",
                "Chrome",
                "Safari",
                "Firefox",
                "Zen",
                "Brave or Edge"
            ]
        );
        let found = source_tiles(|path| {
            path == "/Applications/Microsoft Edge Beta.app" || path == "/Applications/Helium.app"
        });
        let edge = found
            .iter()
            .find(|t| t.source == Source::Edge)
            .expect("edge");
        assert_eq!(
            (edge.name.as_str(), edge.import_id, edge.found),
            ("Edge Beta", Some("edgeBeta"), true)
        );
        assert!(found.iter().any(|t| t.source == Source::Helium && t.found));
        assert!(!found.iter().any(|t| t.source == Source::Brave));
    }

    #[test]
    fn the_source_stage_matches_the_old_geometry() {
        assert_eq!(ROW_WIDTH, 396.0);
        assert_eq!(CENTER_X, 154.0);
        assert_eq!(list_height(1), 130.32);
        let picking = source_layout(1, false, None, true);
        assert_eq!(picking.stage, list_height(1) + space::HUGE + FLOW_ICON);
        assert_eq!(picking.top, 0.0);
        let chosen = source_layout(1, true, Some(Shape::Idle), false);
        assert_eq!(chosen.ardia_y, (chosen.stage - (CAPTION_TOP + 83.0)) / 2.0);
    }

    #[test]
    fn glyphs_fade_at_the_ends_of_the_path_and_lift_in_the_middle() {
        let (x, lift, opacity) = flow_point(0.0, 0.5);
        assert_eq!(x, (FLOW_PATH - FLOW_GLYPH) * 0.5);
        assert_eq!(lift, -space::S);
        assert_eq!(opacity, 1.0);
        assert_eq!(flow_point(0.0, 0.0).2, 0.0);
        assert!((flow_point(0.09, 0.0).2 - 0.5).abs() < 1e-5);
    }

    #[test]
    fn swaps_cross_fade_and_reuse_a_layer_on_return() {
        let start = Instant::now();
        let mut swap: Swap<u8> = Swap::default();
        swap.show(Some(("a".into(), 1)), start);
        assert_eq!(swap.layers[0].opacity.value(start), 1.0);
        swap.show(Some(("b".into(), 2)), start);
        assert_eq!(swap.layers.len(), 2);
        assert!(swap.settle(start + Duration::from_millis(10)));
        swap.show(Some(("a".into(), 1)), start + Duration::from_millis(20));
        assert_eq!(swap.layers.len(), 2);
        assert!(!swap.settle(start + Duration::from_secs(1)));
        assert_eq!(swap.layers.len(), 1);
    }
}
