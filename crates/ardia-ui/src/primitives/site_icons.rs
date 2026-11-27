use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use gpui::{Image, ImageFormat};
use parking_lot::Mutex;

type SiteImages = HashMap<(SiteIcon, bool), Arc<Image>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SiteIcon {
    Gmail,
    Calendar,
    Docs,
    Drive,
    Slack,
    Notion,
    Figma,
    Github,
    Linear,
    Outlook,
    Youtube,
    Spotify,
    Google,
    Bing,
    Duckduckgo,
    Ecosia,
    BraveSearch,
    Kagi,
    Startpage,
}

const KEYS: &[(&str, SiteIcon)] = &[
    ("mail.google.com", SiteIcon::Gmail),
    ("calendar.google.com", SiteIcon::Calendar),
    ("docs.google.com/", SiteIcon::Docs),
    ("docs.google.com/document", SiteIcon::Docs),
    ("drive.google.com", SiteIcon::Drive),
    ("app.slack.com", SiteIcon::Slack),
    ("notion.so", SiteIcon::Notion),
    ("notion.com", SiteIcon::Notion),
    ("figma.com", SiteIcon::Figma),
    ("github.com", SiteIcon::Github),
    ("linear.app", SiteIcon::Linear),
    ("outlook.office.com", SiteIcon::Outlook),
    ("outlook.office365.com", SiteIcon::Outlook),
    ("outlook.live.com", SiteIcon::Outlook),
    ("youtube.com", SiteIcon::Youtube),
    ("open.spotify.com", SiteIcon::Spotify),
    ("google.com", SiteIcon::Google),
    ("bing.com", SiteIcon::Bing),
    ("duckduckgo.com", SiteIcon::Duckduckgo),
    ("ecosia.org", SiteIcon::Ecosia),
    ("search.brave.com", SiteIcon::BraveSearch),
    ("kagi.com", SiteIcon::Kagi),
    ("startpage.com", SiteIcon::Startpage),
];

fn icon_for(key: &str) -> Option<SiteIcon> {
    KEYS.iter()
        .find(|(known, _)| *known == key)
        .map(|(_, icon)| *icon)
}

pub fn site_icon(url: &str) -> Option<SiteIcon> {
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        return None;
    }
    let host = match authority.split_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        Some(_) => return None,
        None => authority,
    };
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").map(str::to_owned).unwrap_or(host);
    if host.is_empty() {
        return None;
    }
    let tail = &rest[authority_end..];
    let segment = tail
        .strip_prefix('/')
        .map(|path| &path[..path.find(['/', '?', '#']).unwrap_or(path.len())])
        .unwrap_or("");
    icon_for(&format!("{host}/{segment}")).or_else(|| icon_for(&host))
}

impl SiteIcon {
    pub fn bytes(self, dark: bool) -> &'static [u8] {
        match self {
            SiteIcon::Gmail => include_bytes!("../../assets/site-icons/gmail.png"),
            SiteIcon::Calendar => include_bytes!("../../assets/site-icons/calendar.png"),
            SiteIcon::Docs => include_bytes!("../../assets/site-icons/docs.png"),
            SiteIcon::Drive => include_bytes!("../../assets/site-icons/drive.png"),
            SiteIcon::Slack => include_bytes!("../../assets/site-icons/slack.png"),
            SiteIcon::Notion => include_bytes!("../../assets/site-icons/notion.png"),
            SiteIcon::Figma => include_bytes!("../../assets/site-icons/figma.png"),
            SiteIcon::Github if dark => {
                include_bytes!("../../assets/site-icons/github-dark.png")
            }
            SiteIcon::Github => include_bytes!("../../assets/site-icons/github.png"),
            SiteIcon::Linear => include_bytes!("../../assets/site-icons/linear.png"),
            SiteIcon::Outlook => include_bytes!("../../assets/site-icons/outlook.png"),
            SiteIcon::Youtube => include_bytes!("../../assets/site-icons/youtube.png"),
            SiteIcon::Spotify => include_bytes!("../../assets/site-icons/spotify.png"),
            SiteIcon::Google => include_bytes!("../../assets/site-icons/google.png"),
            SiteIcon::Bing => include_bytes!("../../assets/site-icons/bing.png"),
            SiteIcon::Duckduckgo => include_bytes!("../../assets/site-icons/duckduckgo.png"),
            SiteIcon::Ecosia => include_bytes!("../../assets/site-icons/ecosia.png"),
            SiteIcon::BraveSearch => include_bytes!("../../assets/site-icons/brave-search.png"),
            SiteIcon::Kagi => include_bytes!("../../assets/site-icons/kagi.png"),
            SiteIcon::Startpage => include_bytes!("../../assets/site-icons/startpage.png"),
        }
    }

    pub fn image(self, dark: bool) -> Arc<Image> {
        static IMAGES: LazyLock<Mutex<SiteImages>> = LazyLock::new(|| Mutex::new(HashMap::new()));
        let dark = dark && self == SiteIcon::Github;
        Arc::clone(IMAGES.lock().entry((self, dark)).or_insert_with(|| {
            Arc::new(Image::from_bytes(
                ImageFormat::Png,
                self.bytes(dark).to_vec(),
            ))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_first_path_segments_pick_the_bundled_icon() {
        assert_eq!(
            site_icon("https://github.com/ardia"),
            Some(SiteIcon::Github)
        );
        assert_eq!(site_icon("https://WWW.GitHub.com"), Some(SiteIcon::Github));
        assert_eq!(
            site_icon("http://youtube.com:8080/watch?v=1"),
            Some(SiteIcon::Youtube)
        );
        assert_eq!(site_icon("https://docs.google.com"), Some(SiteIcon::Docs));
        assert_eq!(site_icon("https://docs.google.com/"), Some(SiteIcon::Docs));
        assert_eq!(
            site_icon("https://docs.google.com/document/d/1/edit"),
            Some(SiteIcon::Docs)
        );
        assert_eq!(site_icon("https://docs.google.com/spreadsheets/d/1"), None);
        assert_eq!(
            site_icon("https://mail.google.com/mail/u/0/#inbox"),
            Some(SiteIcon::Gmail)
        );
        assert_eq!(
            site_icon("https://google.com/search?q=x"),
            Some(SiteIcon::Google)
        );
        assert_eq!(site_icon("https://maps.google.com/"), None);
        assert_eq!(site_icon("ftp://github.com/"), None);
        assert_eq!(site_icon("ardia://history"), None);
        assert_eq!(site_icon("github.com"), None);
        assert_eq!(
            site_icon("https://github.com@evil.example/"),
            None,
            "a userinfo prefix never borrows a known site's icon"
        );
        assert_eq!(site_icon("https://github.com:evil/"), None);
    }

    #[test]
    fn github_has_a_dark_variant_and_images_are_shared() {
        assert_ne!(SiteIcon::Github.bytes(true), SiteIcon::Github.bytes(false));
        assert_eq!(SiteIcon::Gmail.bytes(true), SiteIcon::Gmail.bytes(false));
        let first = SiteIcon::Github.image(true);
        assert!(Arc::ptr_eq(&first, &SiteIcon::Github.image(true)));
        assert!(!Arc::ptr_eq(&first, &SiteIcon::Github.image(false)));
        assert!(Arc::ptr_eq(
            &SiteIcon::Kagi.image(true),
            &SiteIcon::Kagi.image(false)
        ));
        for (_, icon) in KEYS {
            assert!(icon.bytes(false).starts_with(b"\x89PNG"));
        }
    }
}
