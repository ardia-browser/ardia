use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;

use crate::scale::px;
use ardia_state::ProfileId;
use base64::Engine as _;
use gpui::{
    AnyElement, FontWeight, Image, ImageFormat, IntoElement, ObjectFit, SharedString, div, img,
    prelude::*,
};

use crate::host::UiHost;
use crate::look::Palette;
use crate::pages::InternalPage;
use crate::primitives::icons::{Icon, icon};
use crate::primitives::site_icons::{SiteIcon, site_icon};

const MAX_CACHED: usize = 384;
pub const MAX_DATA_URI: usize = 256 * 1024;

thread_local! {
    static DECODED: RefCell<HashMap<u64, Option<Arc<Image>>>> = RefCell::new(HashMap::new());
}

pub type InkFn = dyn Fn([u8; 4]) -> Option<Arc<Image>> + Send + Sync;

#[derive(Clone)]
pub struct FaviconInker(Arc<InkFn>);

impl FaviconInker {
    pub fn new(ink: impl Fn([u8; 4]) -> Option<Arc<Image>> + Send + Sync + 'static) -> Self {
        FaviconInker(Arc::new(ink))
    }

    pub fn ink(&self, color: [u8; 4]) -> Option<Arc<Image>> {
        (self.0)(color)
    }
}

impl std::fmt::Debug for FaviconInker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FaviconInker")
    }
}

impl PartialEq for FaviconInker {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub fn ink_rgba(color: gpui::Hsla) -> [u8; 4] {
    let rgba = gpui::Rgba::from(color);
    let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    [byte(rgba.r), byte(rgba.g), byte(rgba.b), byte(rgba.a)]
}

pub fn template_ink(p: &Palette) -> Option<[u8; 4]> {
    (!p.dark).then(|| ink_rgba(p.text))
}

#[derive(Clone, Debug, PartialEq)]
pub enum Favicon {
    Image(Arc<Image>),
    Template {
        image: Arc<Image>,
        inker: FaviconInker,
    },
    Remote {
        url: SharedString,
        letter: Option<char>,
        site: Option<SiteIcon>,
    },
    Emoji(SharedString),
    Letter(char),
    Glyph(Icon),
    Site(SiteIcon),
    NewTab,
}

fn format_of(mime: &str) -> Option<ImageFormat> {
    Some(match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::Webp,
        "image/gif" => ImageFormat::Gif,
        "image/svg+xml" => ImageFormat::Svg,
        "image/bmp" => ImageFormat::Bmp,
        "image/x-icon" | "image/vnd.microsoft.icon" | "image/ico" => ImageFormat::Ico,
        _ => return None,
    })
}

pub fn decode_data_uri(uri: &str) -> Option<Arc<Image>> {
    if uri.len() > MAX_DATA_URI {
        return None;
    }
    let rest = uri.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let format = format_of(parts.next()?)?;
    let base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim().as_bytes())
            .ok()?
    } else {
        payload.as_bytes().to_vec()
    };
    (!bytes.is_empty()).then(|| Arc::new(Image::from_bytes(format, bytes)))
}

fn cached_data_uri(uri: &str) -> Option<Arc<Image>> {
    let mut hasher = DefaultHasher::new();
    uri.hash(&mut hasher);
    let key = hasher.finish();
    DECODED.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(found) = cache.get(&key) {
            return found.clone();
        }
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
        let decoded = decode_data_uri(uri);
        cache.insert(key, decoded.clone());
        decoded
    })
}

pub fn initial_of(label: &str) -> char {
    label
        .trim_start_matches("www.")
        .chars()
        .find(|c| c.is_alphanumeric())
        .map_or('•', |c| c.to_uppercase().next().unwrap_or(c))
}

fn looks_like_emoji(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    !first.is_ascii() && text.chars().count() <= 8
}

pub fn favicon_of(
    url: &str,
    favicon: Option<&str>,
    custom_icon: Option<&str>,
    label: &str,
) -> Favicon {
    if let Some(custom) = custom_icon.map(str::trim).filter(|c| !c.is_empty()) {
        if looks_like_emoji(custom) {
            return Favicon::Emoji(SharedString::from(custom.to_owned()));
        }
        if let Some(image) = custom
            .starts_with("data:")
            .then(|| cached_data_uri(custom))
            .flatten()
        {
            return Favicon::Image(image);
        }
    }
    let _ = label;
    if url.is_empty() || matches!(InternalPage::of(url), Some(InternalPage::NewTab)) {
        return Favicon::NewTab;
    }
    let letter = host_initial(url);
    let site = site_icon(url);
    let fallback = fallback_favicon(site, letter);
    match favicon.map(str::trim).filter(|f| !f.is_empty()) {
        Some(data) if data.starts_with("data:") => cached_data_uri(data)
            .map(Favicon::Image)
            .unwrap_or(fallback),
        Some(remote) if is_remote_icon(remote) => Favicon::Remote {
            url: SharedString::from(remote.to_owned()),
            letter,
            site,
        },
        _ => fallback,
    }
}

fn fallback_favicon(site: Option<SiteIcon>, letter: Option<char>) -> Favicon {
    match (site, letter) {
        (Some(site), _) => Favicon::Site(site),
        (None, Some(letter)) => Favicon::Letter(letter),
        (None, None) => Favicon::Glyph(Icon::Globe),
    }
}

pub const FAVICON_HAIR_RADIUS: f32 = 2.0;
pub const FAVICON_CONTROL_RADIUS: f32 = 4.0;
pub const FAVICON_CONTROL_ABOVE: f32 = 18.0;

pub fn favicon_radius(side: f32) -> f32 {
    if side > FAVICON_CONTROL_ABOVE {
        FAVICON_CONTROL_RADIUS
    } else {
        FAVICON_HAIR_RADIUS
    }
}

fn rounded_image(image: Arc<Image>, side: f32) -> AnyElement {
    img(image)
        .flex_none()
        .size(px(side))
        .rounded(px(favicon_radius(side)))
        .object_fit(ObjectFit::Contain)
        .into_any_element()
}

pub fn host_initial(url: &str) -> Option<char> {
    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase());
    if !matches!(scheme.as_deref(), Some("http" | "https" | "ftp")) {
        return None;
    }
    let host = ardia_state::omnibox::url::host_of(url);
    let numeric = !host.is_empty() && host.chars().all(|c| c.is_ascii_digit() || c == '.');
    if host.is_empty() || numeric || host.starts_with('[') {
        return None;
    }
    let shown = ardia_state::omnibox::url::display_host(&host);
    let first = shown.chars().next()?;
    first.to_uppercase().next()
}

pub fn is_remote_icon(url: &str) -> bool {
    let scheme = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    scheme.starts_with("https://") || scheme.starts_with("http://")
}

pub fn resolve_favicon(favicon: Favicon, host: &dyn UiHost, profile: &ProfileId) -> Favicon {
    match favicon {
        Favicon::Remote { url, letter, site } => match host.favicon_image(profile, &url) {
            Some(image) => match host.favicon_inker(&url) {
                Some(inker) => Favicon::Template { image, inker },
                None => Favicon::Image(image),
            },
            None => fallback_favicon(site, letter),
        },
        other => other,
    }
}

pub fn page_favicon_of(host: &dyn UiHost, profile: &ProfileId, page: &str) -> Option<Favicon> {
    let image = host.page_favicon(profile, page)?;
    Some(match host.page_favicon_inker(profile, page) {
        Some(inker) => Favicon::Template { image, inker },
        None => Favicon::Image(image),
    })
}

fn shows_page_icon(favicon: &Favicon) -> bool {
    matches!(
        favicon,
        Favicon::Remote { .. } | Favicon::Site(_) | Favicon::Letter(_) | Favicon::Glyph(_)
    )
}

pub fn resolve_tab_favicon(
    favicon: Favicon,
    page: &str,
    live: bool,
    host: &dyn UiHost,
    profile: &ProfileId,
) -> Favicon {
    if !shows_page_icon(&favicon) {
        return resolve_favicon(favicon, host, profile);
    }
    if live && matches!(favicon, Favicon::Remote { .. }) {
        let downloaded = resolve_favicon(favicon.clone(), host, profile);
        if matches!(downloaded, Favicon::Image(_) | Favicon::Template { .. }) {
            return downloaded;
        }
    }
    page_favicon_of(host, profile, page).unwrap_or_else(|| resolve_favicon(favicon, host, profile))
}

pub const LETTER_TILE_RATIO: f32 = 14.0 / 16.0;
pub const LETTER_TILE_RADIUS: f32 = 0.32;
pub const LETTER_GLYPH_SCALE: f32 = 0.64;

pub fn letter_tile(letter: char, side: f32, p: &Palette) -> AnyElement {
    let tile = (side * LETTER_TILE_RATIO).round();
    let glyph = crate::primitives::cap_letter::initial_glyph(
        tile,
        crate::primitives::cap_letter::RETINA_PIXELS_PER_POINT,
    );
    div()
        .flex_none()
        .size(px(side))
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .size(px(tile))
                .rounded(px(tile * LETTER_TILE_RADIUS))
                .bg(p.favicon_tile)
                .child(crate::primitives::cap_letter::cap_centered_letter(
                    letter.to_string(),
                    tile,
                    glyph,
                    FontWeight::SEMIBOLD,
                    p.text_secondary,
                )),
        )
        .into_any_element()
}

static NEW_TAB_MARK: std::sync::LazyLock<Arc<[u8]>> = std::sync::LazyLock::new(|| {
    let png = base64::engine::general_purpose::STANDARD
        .encode(include_bytes!("../../assets/new-tab-mark.png"));
    Arc::from(
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 16 16\"><image width=\"16\" height=\"16\" xlink:href=\"data:image/png;base64,{png}\"/></svg>"
        )
        .into_bytes(),
    )
});

pub fn new_tab_mark_mask() -> Arc<[u8]> {
    Arc::clone(&NEW_TAB_MARK)
}

pub fn new_tab_mark(side: f32, color: gpui::Hsla) -> AnyElement {
    gpui::svg()
        .data(&new_tab_mark_mask())
        .flex_none()
        .size(px(side))
        .text_color(color)
        .into_any_element()
}

pub const NEW_TAB_MARK_ALPHA: f32 = 0.28;
pub const NEW_TAB_MARK_ALPHA_LIGHT: f32 = 0.3;

pub fn render_favicon(favicon: &Favicon, side: f32, p: &Palette) -> AnyElement {
    match favicon {
        Favicon::Image(image) => rounded_image(Arc::clone(image), side),
        Favicon::Template { image, inker } => {
            let shown = template_ink(p)
                .and_then(|ink| inker.ink(ink))
                .unwrap_or_else(|| Arc::clone(image));
            rounded_image(shown, side)
        }
        Favicon::Site(site) => rounded_image(site.image(p.dark), side),
        Favicon::Remote { letter, site, .. } => {
            render_favicon(&fallback_favicon(*site, *letter), side, p)
        }
        Favicon::Glyph(glyph) => div()
            .flex_none()
            .size(px(side))
            .flex()
            .items_center()
            .justify_center()
            .child(icon(*glyph, (side - 2.0).max(1.0), p.text_secondary).fit_within(side, side))
            .into_any_element(),
        Favicon::Emoji(emoji) => div()
            .flex_none()
            .size(px(side))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(side - 2.0))
            .line_height(px(side))
            .child(emoji.clone())
            .into_any_element(),
        Favicon::Letter(letter) => letter_tile(*letter, side, p),
        Favicon::NewTab => new_tab_mark(
            side,
            p.mark.opacity(if p.dark {
                NEW_TAB_MARK_ALPHA
            } else {
                NEW_TAB_MARK_ALPHA_LIGHT
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOT: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn data_uris_decode_once_and_reject_garbage() {
        let image = decode_data_uri(DOT).expect("a png");
        assert_eq!(image.format, ImageFormat::Png);
        assert!(decode_data_uri("data:image/png;base64,@@@").is_none());
        assert!(decode_data_uri("data:text/html,<b>").is_none());
        assert!(decode_data_uri("https://example.com").is_none());
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_DATA_URI));
        assert!(decode_data_uri(&huge).is_none());
        let first = cached_data_uri(DOT);
        let second = cached_data_uri(DOT);
        assert!(Arc::ptr_eq(
            &first.expect("cached"),
            &second.expect("cached")
        ));
    }

    #[test]
    fn favicons_pick_the_best_source() {
        assert_eq!(
            favicon_of("https://example.com", None, None, "example.com"),
            Favicon::Letter('E')
        );
        assert_eq!(favicon_of("", None, None, "New Tab"), Favicon::NewTab);
        assert_eq!(
            favicon_of(
                "https://x.com",
                Some("https://abs.twimg.com/favicons/twitter.3.ico"),
                None,
                "x.com"
            ),
            Favicon::Remote {
                url: "https://abs.twimg.com/favicons/twitter.3.ico".into(),
                letter: Some('X'),
                site: None,
            },
            "the letter comes from the page, not the icon's host"
        );
        assert_eq!(
            favicon_of("https://x.com", Some("file:///etc/icon.png"), None, "x.com"),
            Favicon::Letter('X')
        );
        assert_eq!(
            favicon_of("ardia://history", None, None, "History"),
            Favicon::Glyph(Icon::Globe),
            "pages without a web host get the globe, as in the old app"
        );
        assert_eq!(
            favicon_of("http://192.168.1.4/", None, None, "router"),
            Favicon::Glyph(Icon::Globe)
        );
        assert_eq!(
            favicon_of("https://www.gitlab.com/", None, None, "Custom Name"),
            Favicon::Letter('G'),
            "the letter follows the host, not a custom title"
        );
        assert_eq!(
            favicon_of("https://www.github.com/", None, None, "github.com"),
            Favicon::Site(SiteIcon::Github),
            "a bundled site icon comes before the letter"
        );
        assert_eq!(
            favicon_of("https://mail.google.com/", Some("data:bad"), None, "gmail"),
            Favicon::Site(SiteIcon::Gmail)
        );
        assert_eq!(
            favicon_of("ardia://newtab", None, None, "New Tab"),
            Favicon::NewTab
        );
        assert!(matches!(
            favicon_of("https://x.com", Some(DOT), None, "x.com"),
            Favicon::Image(_)
        ));
        assert_eq!(
            favicon_of("https://x.com", None, Some("🚀"), "x.com"),
            Favicon::Emoji("🚀".into())
        );
        assert_eq!(initial_of("www.github.com"), 'G');
        assert_eq!(initial_of("  "), '•');
    }

    #[test]
    fn remote_icons_resolve_through_the_host() {
        let host = crate::mock::MockUiHost::fresh();
        let profile = ProfileId::default_profile();
        let remote = favicon_of(
            "https://github.com",
            Some("https://github.githubassets.com/favicons/favicon-dark.svg"),
            None,
            "github.com",
        );
        assert_eq!(
            resolve_favicon(remote.clone(), host.as_ref(), &profile),
            Favicon::Site(SiteIcon::Github),
            "until the fetched icon arrives the bundled one shows"
        );
        let unknown = favicon_of(
            "https://gitlab.com",
            Some("https://gitlab.com/favicon.ico"),
            None,
            "gitlab.com",
        );
        assert_eq!(
            resolve_favicon(unknown, host.as_ref(), &profile),
            Favicon::Letter('G')
        );
        let image = decode_data_uri(DOT).unwrap();
        host.set_favicon_image(
            "https://github.githubassets.com/favicons/favicon-dark.svg",
            Arc::clone(&image),
        );
        assert_eq!(
            resolve_favicon(remote, host.as_ref(), &profile),
            Favicon::Image(image)
        );
    }

    #[test]
    fn tab_icons_follow_the_old_download_then_page_order() {
        let host = crate::mock::MockUiHost::fresh();
        let profile = ProfileId::default_profile();
        let page = "https://ardia.dev/";
        let src = "https://ardia.dev/favicon.svg";
        let remote = favicon_of(page, Some(src), None, "ardia.dev");
        let downloaded = decode_data_uri(DOT).unwrap();
        let stored = Arc::new(Image::from_bytes(ImageFormat::Png, vec![1, 2, 3]));
        assert_eq!(
            resolve_tab_favicon(remote.clone(), page, false, host.as_ref(), &profile),
            Favicon::Letter('A')
        );
        host.set_page_favicon(page, Arc::clone(&stored));
        host.set_favicon_image(src, Arc::clone(&downloaded));
        assert_eq!(
            resolve_tab_favicon(remote.clone(), page, false, host.as_ref(), &profile),
            Favicon::Image(Arc::clone(&stored)),
            "a tab that hasn't loaded shows Chromium's stored page icon"
        );
        assert_eq!(
            resolve_tab_favicon(remote, page, true, host.as_ref(), &profile),
            Favicon::Image(downloaded),
            "a live tab shows the icon it downloaded"
        );
        let bare = favicon_of(page, None, None, "ardia.dev");
        assert_eq!(
            resolve_tab_favicon(bare, page, true, host.as_ref(), &profile),
            Favicon::Image(stored),
            "the page icon still stands in before the download"
        );
        assert_eq!(
            resolve_tab_favicon(Favicon::NewTab, "", false, host.as_ref(), &profile),
            Favicon::NewTab
        );
    }

    #[test]
    fn favicon_corners_follow_the_old_app() {
        assert_eq!(favicon_radius(16.), FAVICON_HAIR_RADIUS);
        assert_eq!(favicon_radius(18.), FAVICON_HAIR_RADIUS);
        assert_eq!(favicon_radius(20.), FAVICON_CONTROL_RADIUS);
        assert_eq!(favicon_radius(32.), FAVICON_CONTROL_RADIUS);
    }

    #[test]
    fn near_white_templates_take_the_light_theme_ink() {
        let state = crate::mock::fresh_state();
        let light = crate::look::Look::new(&state, "missing", gpui::WindowAppearance::Light);
        let dark = crate::look::Look::new(&state, "missing", gpui::WindowAppearance::Dark);
        assert_eq!(template_ink(&light.p), Some(ink_rgba(light.p.text)));
        assert_eq!(
            template_ink(&dark.p),
            None,
            "dark themes skip the ink, as in the old app"
        );

        let host = crate::mock::MockUiHost::fresh();
        let profile = ProfileId::default_profile();
        let url = "https://github.githubassets.com/favicons/favicon-dark.png";
        let plain = decode_data_uri(DOT).unwrap();
        let inked = Arc::new(Image::from_bytes(ImageFormat::Png, vec![1, 2, 3]));
        host.set_favicon_image(url, Arc::clone(&plain));
        let asked = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let seen = Arc::clone(&asked);
        let answer = Arc::clone(&inked);
        host.set_favicon_inker(
            url,
            FaviconInker::new(move |color| {
                seen.lock().push(color);
                Some(Arc::clone(&answer))
            }),
        );
        let remote = favicon_of("https://github.com", Some(url), None, "github.com");
        let resolved = resolve_favicon(remote, host.as_ref(), &profile);
        let Favicon::Template { image, inker } = &resolved else {
            panic!("a white template keeps its inker, got {resolved:?}");
        };
        assert!(Arc::ptr_eq(image, &plain));
        let ink = template_ink(&light.p).unwrap();
        assert!(Arc::ptr_eq(&inker.ink(ink).unwrap(), &inked));
        assert_eq!(asked.lock().as_slice(), &[ink]);

        let other = "https://cdn.example/colour.png";
        host.set_favicon_image(other, Arc::clone(&plain));
        let remote = favicon_of("https://example.com", Some(other), None, "example.com");
        assert_eq!(
            resolve_favicon(remote, host.as_ref(), &profile),
            Favicon::Image(plain),
            "ordinary icons are never inked"
        );
    }
}
