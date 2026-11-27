use crate::omnibox::url::fixup_url;
use crate::settings::{NewTabOpens, Settings};

pub fn home_address(typed: &str) -> Option<String> {
    let url = fixup_url(typed.trim())?;
    let lower = url.to_ascii_lowercase();
    let web = ["http://", "https://"].iter().any(|scheme| {
        lower
            .strip_prefix(scheme)
            .and_then(|rest| rest.chars().next())
            .is_some_and(|first| !"/?#".contains(first))
    });
    let page = lower
        .strip_prefix("ardia://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .is_some_and(|page| !page.is_empty());
    (web || url == "about:blank" || page).then_some(url)
}

pub fn home_url(settings: &Settings) -> Option<String> {
    if settings.new_tab_opens() != NewTabOpens::Page {
        return None;
    }
    home_address(&settings.new_tab_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{SettingsMeta, SettingsPatch};

    fn with(patch: SettingsPatch) -> Settings {
        let mut settings = Settings::default();
        settings.apply(&mut SettingsMeta::default(), &patch, false, false);
        settings
    }

    #[test]
    fn a_saved_address_opens_only_while_new_tabs_open_a_page() {
        assert_eq!(home_url(&Settings::default()), None);
        let set = with(SettingsPatch::new().set("newTabUrl", "example.com"));
        assert_eq!(home_url(&set).as_deref(), Some("https://example.com"));
        let bar = with(
            SettingsPatch::new()
                .set("newTabUrl", "example.com")
                .set("newTabOpens", "commandBar"),
        );
        assert_eq!(home_url(&bar), None);
        let minimal = with(
            SettingsPatch::new()
                .set("newTabUrl", "example.com")
                .set("minimalismMode", true),
        );
        assert_eq!(home_url(&minimal), None);
    }

    #[test]
    fn only_web_pages_blank_and_ardia_pages_are_homes() {
        assert_eq!(home_address("about:blank").as_deref(), Some("about:blank"));
        assert!(home_address("javascript:alert(1)").is_none());
        assert!(home_address("").is_none());
    }
}
