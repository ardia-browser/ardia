use ardia_state::TabId;
use ardia_state::tabs::Tab;

use crate::msg::Msg;
use crate::popovers::context_menu::{MenuEntry, MenuItem};
use crate::primitives::icons::Icon;
use crate::settings::rows::Pane;
use crate::site::SiteMsg;
use crate::site::model::{self, ReloadBlocker, SiteAnswer, SiteSound};
use crate::window::chrome::Chrome;

#[derive(Clone, Debug, PartialEq)]
pub enum SiteMenu {
    Permission { tab: TabId, kind: &'static str },
    AddExtension,
    Languages(TabId),
    Translate(TabId),
    Engine(TabId),
}

pub fn permission_menu(c: &Chrome, tab: &Tab, kind: &'static str) -> Vec<MenuEntry> {
    let Some(permission) = model::SITE_PERMISSIONS.iter().find(|p| p.kind == kind) else {
        return Vec::new();
    };
    let data = c.host.site_panel(&tab.id);
    let sound = SiteSound {
        site_muted: ardia_state::mute::site_muted(c.state, tab),
        sound_blocked: data
            .settings
            .as_ref()
            .and_then(|s| s.get("sound"))
            .is_some_and(|s| s.value == model::SettingValue::Block),
    };
    let current = model::permission_value(
        kind,
        data.settings.as_ref(),
        sound,
        c.state.settings.block_autoplay_everywhere,
    );
    permission
        .choices
        .iter()
        .map(|value| {
            MenuItem::new(
                format!("site-choice:{kind}:{}", value.as_str()),
                model::choice_title(kind, *value),
            )
            .checked(Some(*value) == current)
            .msg(Msg::Site(SiteMsg::Answer(
                tab.id.clone(),
                SiteAnswer::SetPermission {
                    kind: kind.to_owned(),
                    value: *value,
                },
            )))
            .entry()
        })
        .collect()
}

pub fn reload_blocker(c: &Chrome, tab: &TabId) -> ReloadBlocker {
    let host = c
        .state
        .tab(tab.as_str())
        .map(|tab| ardia_state::omnibox::url::host_of(&tab.url))
        .unwrap_or_default();
    ReloadBlocker::of(c.host.content_blocker().as_ref(), &host)
}

pub fn blocking_item(tab: &TabId, blocker: ReloadBlocker) -> MenuEntry {
    let item = MenuItem::new("blocking", "Block Ads & Trackers")
        .icon(Icon::Shield)
        .checked(blocker == ReloadBlocker::On)
        .enabled(blocker != ReloadBlocker::Unavailable);
    match blocker {
        ReloadBlocker::Unavailable => item,
        ReloadBlocker::OffInSettings => item.msg(Msg::SettingsAt(Pane::General)),
        ReloadBlocker::On | ReloadBlocker::Off => item.msg(Msg::Site(SiteMsg::Answer(
            tab.clone(),
            SiteAnswer::SetBlocking(blocker == ReloadBlocker::Off),
        ))),
    }
    .entry()
}

pub fn add_extension_menu() -> Vec<MenuEntry> {
    vec![
        MenuItem::new("manage", "Manage Extensions…")
            .icon(Icon::PuzzleExtension)
            .msg(Msg::CloseOverlays)
            .msg(Msg::command("manageExtensions"))
            .entry(),
        MenuItem::new("add", "Add Extension…")
            .icon(Icon::Plus)
            .msg(Msg::CloseOverlays)
            .msg(Msg::command("addExtension"))
            .entry(),
    ]
}

pub fn site_menu(c: &Chrome, menu: &SiteMenu) -> Option<Vec<MenuEntry>> {
    match menu {
        SiteMenu::Permission { tab, kind } => {
            let tab = c.state.tab(tab.as_str())?;
            Some(permission_menu(c, tab, kind))
        }
        SiteMenu::AddExtension => Some(add_extension_menu()),
        SiteMenu::Languages(tab) => Some(languages_menu(c, tab)),
        SiteMenu::Engine(tab) => {
            let tab = c.state.tab(tab.as_str())?;
            Some(engine_menu(c, tab))
        }
        SiteMenu::Translate(tab) => {
            let tab = c.state.tab(tab.as_str())?;
            Some(translate_menu(c, tab))
        }
    }
}

fn language_items(tab: &TabId, languages: Vec<model::TranslateLanguage>) -> Vec<MenuEntry> {
    languages
        .into_iter()
        .map(|language| {
            MenuItem::new(format!("translate-language:{}", language.id), language.name)
                .checked(language.current)
                .msg(Msg::Site(SiteMsg::Answer(
                    tab.clone(),
                    SiteAnswer::TranslateTo(language.id),
                )))
                .entry()
        })
        .collect()
}

pub fn languages_menu(c: &Chrome, tab: &TabId) -> Vec<MenuEntry> {
    language_items(tab, c.host.translate_languages(tab))
}

pub fn translate_menu(c: &Chrome, tab: &Tab) -> Vec<MenuEntry> {
    translate_menu_entries(
        &tab.id,
        &c.host.translate_view(&tab.id),
        c.host.translate_languages(&tab.id),
        tab.profile_id.is_incognito(),
    )
}

pub fn translate_menu_entries(
    tab: &TabId,
    view: &model::TranslateView,
    languages: Vec<model::TranslateLanguage>,
    incognito: bool,
) -> Vec<MenuEntry> {
    let answer = |answer: SiteAnswer| Msg::Site(SiteMsg::Answer(tab.clone(), answer));
    let first = if view.translated {
        MenuItem::new("original", "Show Original")
            .icon(Icon::Undo)
            .msg(answer(SiteAnswer::ShowOriginal))
            .entry()
    } else {
        MenuItem::new("translate", format!("Translate to {}", view.target_name))
            .icon(Icon::Globe)
            .msg(answer(SiteAnswer::Translate))
            .entry()
    };
    let languages = language_items(tab, languages);
    let mut lead = vec![first];
    if !languages.is_empty() {
        lead.push(MenuEntry::submenu(
            "choose",
            "Choose Another Language",
            Some(Icon::Globe),
            languages,
        ));
    }
    let never = (!incognito).then(|| {
        MenuItem::new("never", "Never Translate This Site")
            .checked(view.never)
            .msg(answer(SiteAnswer::NeverTranslate(!view.never)))
            .entry()
    });
    crate::popovers::context_menu::sections(vec![lead, never.into_iter().collect()])
}

pub struct EngineChoice {
    pub page_engine: ardia_state::model::PageEngine,
    pub rule: Option<ardia_state::model::PageEngine>,
    pub recommended: ardia_state::model::PageEngine,
    pub streaming: bool,
    pub private: bool,
}

impl EngineChoice {
    pub fn of(state: &ardia_state::BrowserState, tab: &Tab) -> Self {
        use ardia_state::engines;
        let settings = &state.settings;
        EngineChoice {
            page_engine: engines::tab_engine(state, tab.id.as_str()),
            rule: engines::rule_for(settings, &tab.url),
            recommended: engines::recommended_engine_for(settings, &tab.url),
            streaming: engines::built_in_engine(settings, &tab.url).is_some(),
            private: tab.profile_id.is_incognito(),
        }
    }

    pub fn recommended_title(&self) -> String {
        let name = ardia_state::engines::engine_name(self.recommended);
        if self.streaming {
            format!("Recommended ({name})")
        } else {
            format!("Default ({name})")
        }
    }

    pub fn opens_in(&self) -> String {
        use ardia_state::engines::engine_name;
        if self.private {
            engine_name(self.page_engine).to_owned()
        } else if let Some(rule) = self.rule {
            engine_name(rule).to_owned()
        } else {
            self.recommended_title()
        }
    }

    pub fn checked(&self, engine: ardia_state::model::PageEngine) -> bool {
        if self.private {
            self.page_engine == engine
        } else {
            self.rule == Some(engine)
        }
    }
}

pub fn engine_menu(c: &Chrome, tab: &Tab) -> Vec<MenuEntry> {
    use ardia_state::model::PageEngine;
    let choice = EngineChoice::of(c.state, tab);
    let mut entries = Vec::new();
    if !choice.private {
        entries.push(
            MenuItem::new("site-engine:default", choice.recommended_title())
                .checked(choice.rule.is_none())
                .msg(Msg::CloseOverlays)
                .msg(Msg::Site(SiteMsg::OpenIn(tab.id.clone(), None)))
                .entry(),
        );
        entries.push(MenuEntry::Separator);
    }
    for (id, engine) in [
        ("site-engine:chromium", PageEngine::Chromium),
        ("site-engine:webkit", PageEngine::Webkit),
    ] {
        entries.push(
            MenuItem::new(id, ardia_state::engines::engine_name(engine))
                .checked(choice.checked(engine))
                .msg(Msg::CloseOverlays)
                .msg(Msg::Site(SiteMsg::OpenIn(tab.id.clone(), Some(engine))))
                .entry(),
        );
    }
    entries
}

pub fn engine_titles(state: &ardia_state::BrowserState, tab: &Tab) -> Vec<(String, bool)> {
    use ardia_state::model::PageEngine;
    let choice = EngineChoice::of(state, tab);
    let mut titles = Vec::new();
    if !choice.private {
        titles.push((choice.recommended_title(), choice.rule.is_none()));
    }
    for engine in [PageEngine::Chromium, PageEngine::Webkit] {
        titles.push((
            ardia_state::engines::engine_name(engine).to_owned(),
            choice.checked(engine),
        ));
    }
    titles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::popovers::context_menu::titles;

    #[test]
    fn translate_menu_matches_the_old_button_menu() {
        let tab = TabId::new("t");
        let view = model::TranslateView {
            available: true,
            target_name: "English".into(),
            ..model::TranslateView::default()
        };
        let languages = vec![model::TranslateLanguage {
            id: "de".into(),
            name: "German".into(),
            current: false,
        }];
        let entries = translate_menu_entries(&tab, &view, languages.clone(), false);
        assert_eq!(
            titles(&entries),
            vec![
                "Translate to English",
                "Choose Another Language",
                "-",
                "Never Translate This Site"
            ]
        );
        let translated = model::TranslateView {
            translated: true,
            ..view
        };
        let entries = translate_menu_entries(&tab, &translated, Vec::new(), true);
        assert_eq!(titles(&entries), vec!["Show Original"]);
        let MenuEntry::Item(item) = &language_items(&tab, languages)[0] else {
            panic!("a language row");
        };
        assert_eq!(
            item.msgs,
            vec![Msg::Site(SiteMsg::Answer(
                tab,
                SiteAnswer::TranslateTo("de".into())
            ))]
        );
    }
}
