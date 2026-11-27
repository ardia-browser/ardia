use std::collections::BTreeMap;

use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, FontWeight, IntoElement, ParentElement, SharedString, Styled, Window, div,
    prelude::*,
};

use super::OnboardingWindowView;
use super::flow::QuestionId;
use super::parts;
use crate::host::{OfficialInstallPhase, OfficialPlugin, OfficialPluginState};
use crate::icon_picker::symbols::{SymbolWeight, symbol};
use crate::scale::px;

pub const PRESELECTED: [&str; 1] = ["cli"];
pub const SOON_OPACITY: f32 = 0.6;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Offer,
    Working,
    Installed,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PluginsStep {
    pub picks: BTreeMap<String, bool>,
    pub phase: Phase,
    pub current: Option<String>,
    pub failures: BTreeMap<String, String>,
    pub installed: Vec<String>,
    pub run: u64,
    pub shown: Vec<String>,
}

pub fn official_plugin_field(surface: &str, event: &str, name: &str) -> Option<&'static str> {
    let plugin = match name {
        "cli" => 0,
        "ai" => 1,
        _ => 2,
    };
    let fields: [&'static str; 3] = match (surface, event) {
        ("onboarding", "shown") => [
            "official_plugin_onboarding_shown_cli",
            "official_plugin_onboarding_shown_ai",
            "official_plugin_onboarding_shown_other",
        ],
        ("onboarding", "installed") => [
            "official_plugin_onboarding_installed_cli",
            "official_plugin_onboarding_installed_ai",
            "official_plugin_onboarding_installed_other",
        ],
        ("onboarding", "skipped") => [
            "official_plugin_onboarding_skipped_cli",
            "official_plugin_onboarding_skipped_ai",
            "official_plugin_onboarding_skipped_other",
        ],
        ("onboarding", "failed") => [
            "official_plugin_onboarding_failed_cli",
            "official_plugin_onboarding_failed_ai",
            "official_plugin_onboarding_failed_other",
        ],
        ("settings", "shown") => [
            "official_plugin_settings_shown_cli",
            "official_plugin_settings_shown_ai",
            "official_plugin_settings_shown_other",
        ],
        ("settings", "installed") => [
            "official_plugin_settings_installed_cli",
            "official_plugin_settings_installed_ai",
            "official_plugin_settings_installed_other",
        ],
        ("settings", "failed") => [
            "official_plugin_settings_failed_cli",
            "official_plugin_settings_failed_ai",
            "official_plugin_settings_failed_other",
        ],
        _ => return None,
    };
    Some(fields[plugin])
}

pub fn note_official_plugin(surface: &str, event: &str, name: &str) {
    if let Some(field) = official_plugin_field(surface, event, name) {
        ardia_telemetry::counts::count(field);
    }
}

pub fn offered(plugins: &[OfficialPlugin]) -> Vec<OfficialPlugin> {
    plugins
        .iter()
        .filter(|p| p.state != OfficialPluginState::Unsupported)
        .cloned()
        .collect()
}

pub fn shown(catalogue: Option<&[OfficialPlugin]>) -> bool {
    catalogue.is_some_and(|plugins| {
        plugins.iter().any(|p| {
            matches!(
                p.state,
                OfficialPluginState::Available | OfficialPluginState::Installed
            )
        })
    })
}

pub fn working_status(progress: Option<OfficialInstallPhase>) -> String {
    progress
        .and_then(|phase| phase.status())
        .unwrap_or_else(|| "Installing…".to_owned())
}

impl PluginsStep {
    pub fn is_picked(&self, plugin: &OfficialPlugin) -> bool {
        plugin.state == OfficialPluginState::Available
            && self
                .picks
                .get(&plugin.name)
                .copied()
                .unwrap_or(PRESELECTED.contains(&plugin.name.as_str()))
    }

    pub fn picked(&self, plugins: &[OfficialPlugin]) -> Vec<String> {
        plugins
            .iter()
            .filter(|p| self.is_picked(p))
            .map(|p| p.name.clone())
            .collect()
    }

    pub fn primary_title(&self, plugins: &[OfficialPlugin], asking: bool) -> &'static str {
        let phase = if asking { Phase::Offer } else { self.phase };
        match phase {
            Phase::Working => "Installing…",
            Phase::Offer if !self.picked(plugins).is_empty() => "Install",
            _ => "Continue",
        }
    }

    pub fn toggle(&mut self, plugin: &OfficialPlugin) {
        if self.phase != Phase::Offer || plugin.state != OfficialPluginState::Available {
            return;
        }
        let next = !self.is_picked(plugin);
        self.picks.insert(plugin.name.clone(), next);
    }

    pub fn reset(&mut self) {
        let run = self.run + 1;
        *self = PluginsStep {
            run,
            ..PluginsStep::default()
        };
    }

    pub fn installed_lines(&self, plugins: &[OfficialPlugin]) -> Vec<String> {
        plugins
            .iter()
            .filter(|p| self.installed.contains(&p.name))
            .map(|p| format!("{} installed", p.title))
            .collect()
    }

    pub fn finished_one(&mut self, name: &str, result: Result<(), String>) {
        if result.as_ref().is_err_and(|reason| reason != "Cancelled") || result.is_ok() {
            note_official_plugin(
                "onboarding",
                if result.is_ok() {
                    "installed"
                } else {
                    "failed"
                },
                name,
            );
        }
        self.failures.remove(name);
        match result {
            Ok(()) => self.installed.push(name.to_owned()),
            Err(reason) => {
                self.failures.insert(name.to_owned(), reason);
            }
        }
    }

    pub fn note_shown(&mut self, plugins: &[OfficialPlugin]) {
        for plugin in plugins {
            if !self.shown.contains(&plugin.name) {
                self.shown.push(plugin.name.clone());
                note_official_plugin("onboarding", "shown", &plugin.name);
            }
        }
    }

    pub fn note_skipped(&self, plugins: &[OfficialPlugin], installed_too: bool) {
        for plugin in plugins {
            if plugin.state == OfficialPluginState::Available
                && (installed_too || !self.installed.contains(&plugin.name))
                && !self.failures.contains_key(&plugin.name)
            {
                note_official_plugin("onboarding", "skipped", &plugin.name);
            }
        }
    }

    pub fn settle(&mut self) {
        self.current = None;
        self.phase = if self.failures.is_empty() {
            Phase::Installed
        } else {
            Phase::Failed
        };
    }
}

impl OnboardingWindowView {
    pub(crate) fn official_plugins(&self) -> Vec<OfficialPlugin> {
        offered(&self.host.official_plugins().unwrap_or_default())
    }

    fn install_queue(
        &mut self,
        mut names: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(name) = (!names.is_empty()).then(|| names.remove(0)) else {
            self.plugins_step.settle();
            cx.notify();
            return;
        };
        let run = self.plugins_step.run;
        self.plugins_step.phase = Phase::Working;
        self.plugins_step.current = Some(name.clone());
        self.plugins_step.failures.remove(&name);
        let reply = self.host.install_official_plugin(name.clone());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = match reply {
                Some(reply) => reply.await.unwrap_or_else(|_| Err("Cancelled".to_owned())),
                None => Err("Plugins aren't available here".to_owned()),
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if this.plugins_step.run != run {
                    return;
                }
                this.plugins_step.finished_one(&name, result);
                this.install_queue(names, window, cx);
            });
        })
        .detach();
    }

    pub(crate) fn plugins_forward(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let plugins = self.official_plugins();
        match self.plugins_step.phase {
            Phase::Working => {}
            Phase::Offer => {
                let names = self.plugins_step.picked(&plugins);
                if names.is_empty() {
                    self.finish_plugins(window, cx);
                } else {
                    self.install_queue(names, window, cx);
                }
            }
            Phase::Installed | Phase::Failed => self.finish_plugins(window, cx),
        }
    }

    fn finish_plugins(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let plugins = self.official_plugins();
        let lines = self.plugins_step.installed_lines(&plugins);
        self.plugins_step.note_skipped(&plugins, false);
        self.plugins_step.reset();
        self.confirm(
            QuestionId::Plugins,
            serde_json::Map::new(),
            lines,
            window,
            cx,
        );
    }

    pub(crate) fn skip_plugins(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(current) = self.plugins_step.current.clone() {
            self.host.cancel_official_install(current);
        }
        if self.plugins_step.phase != Phase::Working {
            self.plugins_step
                .note_skipped(&self.official_plugins(), true);
        }
        self.plugins_step.reset();
        self.skip(false, window, cx);
    }

    pub(crate) fn plugin_consent_request(&self) -> Option<crate::plugins::model::ConsentRequest> {
        let current = self.plugins_step.current.as_deref()?;
        if self.plugins_step.phase != Phase::Working || self.flow.step != super::flow::Step::Plugins
        {
            return None;
        }
        self.host
            .plugins()?
            .consent()
            .filter(|request| request.name == current)
    }

    pub(crate) fn plugins_consent(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let plugins = self.host.plugins()?;
        let request = self.plugin_consent_request()?;
        let p = self.look.p;
        let key = SharedString::from(format!(
            "onboarding-plugin-consent:{}:{}",
            request.id, request.hash
        ));
        let view = window.use_keyed_state(key, cx, move |window, cx| {
            crate::plugins::consent::ConsentView::new(plugins, request, p, window, cx)
        });
        Some(view.into_any_element())
    }

    pub(crate) fn plugins_settled(&self) -> bool {
        let plugins = self.official_plugins();
        let nothing = self.plugins_step.phase == Phase::Offer
            && !plugins
                .iter()
                .any(|p| p.state == OfficialPluginState::Available);
        self.plugins_step.phase == Phase::Installed || nothing
    }

    pub(crate) fn plugins_section(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let ink = self.ink();
        let plugins = self.official_plugins();
        self.plugins_step.note_shown(&plugins);
        let asking = self.plugin_consent_request().is_some();
        let phase = if asking {
            Phase::Offer
        } else {
            self.plugins_step.phase
        };
        let nothing = phase == Phase::Offer
            && !plugins
                .iter()
                .any(|p| p.state == OfficialPluginState::Available);
        let (title, subtitle) = if nothing {
            ("You're already set", "Nothing to install.")
        } else if phase == Phase::Installed {
            ("Installed", "Open a new terminal to use it.")
        } else {
            ("Want the extras?", "Official plugins. Optional.")
        };
        let cards: Vec<AnyElement> = plugins
            .iter()
            .map(|plugin| {
                if plugin.state == OfficialPluginState::Available
                    && (self.plugins_step.phase == Phase::Offer
                        || (asking
                            && self.plugins_step.current.as_deref() == Some(plugin.name.as_str())))
                {
                    let picked = self.plugins_step.is_picked(plugin);
                    let target = plugin.clone();
                    let click = self.listen(cx, move |this, _, cx| {
                        this.plugins_step.toggle(&target);
                        cx.notify();
                    });
                    return parts::option_check(
                        SharedString::from(format!("onboarding-plugin-{}", plugin.name)),
                        Some(parts::card_symbol(&plugin.icon, &ink)),
                        &plugin.title,
                        &plugin.blurb,
                        picked,
                        false,
                        &ink,
                        click,
                    );
                }
                self.plugin_status_card(plugin, cx)
            })
            .collect();
        super::screens::section_layout(
            title,
            Some(subtitle),
            None,
            vec![
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::M))
                    .children(cards)
                    .into_any_element(),
            ],
            &ink,
        )
    }

    fn plugin_status_card(
        &mut self,
        plugin: &OfficialPlugin,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ink = self.ink();
        let working = self.plugins_step.phase == Phase::Working
            && self.plugins_step.current.as_deref() == Some(plugin.name.as_str());
        let failure = self.plugins_step.failures.get(&plugin.name).cloned();
        let soon = plugin.state == OfficialPluginState::ComingSoon;
        let installed = plugin.state == OfficialPluginState::Installed
            || self.plugins_step.installed.contains(&plugin.name);
        let status: Option<String> = if soon {
            None
        } else if let Some(reason) = &failure {
            Some(reason.clone())
        } else if working {
            Some(working_status(
                self.host.official_install_progress(plugin.name.clone()),
            ))
        } else if installed {
            Some("Installed".to_owned())
        } else {
            Some(plugin.blurb.clone())
        };
        let retry = (failure.is_some() && self.plugins_step.phase == Phase::Failed).then(|| {
            let name = plugin.name.clone();
            let click = self.listen(cx, move |this, window, cx| {
                this.install_queue(vec![name.clone()], window, cx)
            });
            div().flex().child(parts::secondary_button(
                SharedString::from(format!("onboarding-plugin-retry-{}", plugin.name)),
                "Try Again",
                false,
                &ink,
                click,
            ))
        });
        div()
            .py(px(space::M))
            .px(px(space::L))
            .rounded(px(radius::PANEL))
            .bg(ink.tile)
            .border(px(1.))
            .border_color(ink.tile_border)
            .opacity(if soon { SOON_OPACITY } else { 1.0 })
            .flex()
            .flex_col()
            .gap(px(space::M))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(space::L))
                    .child(
                        div()
                            .size(px(28.))
                            .rounded(px(radius::TILE))
                            .bg(ink.icon_container)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(symbol(
                                self.host.as_ref(),
                                &plugin.icon,
                                13.,
                                16.,
                                SymbolWeight::Regular,
                                ink.title,
                            )),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(space::XXS))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(ink.title)
                                    .child(SharedString::from(plugin.title.clone())),
                            )
                            .children(status.map(|text| {
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(15.))
                                    .text_color(ink.row_subtitle)
                                    .when(failure.is_none(), |this| this.truncate())
                                    .child(SharedString::from(text))
                            })),
                    )
                    .when(soon, |this| this.child(parts::tag("Coming soon", &ink)))
                    .when(working, |this| {
                        this.child(crate::primitives::controls::spinner(16., ink.subtitle))
                    })
                    .when(installed && failure.is_none() && !working, |this| {
                        this.child(parts::check_ring(true, false, &ink))
                    })
                    .when(failure.is_some(), |this| {
                        this.child(symbol(
                            self.host.as_ref(),
                            "exclamationmark.triangle",
                            14.,
                            18.,
                            SymbolWeight::Regular,
                            ink.title,
                        ))
                    }),
            )
            .children(retry)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(name: &str, state: OfficialPluginState) -> OfficialPlugin {
        OfficialPlugin {
            name: name.into(),
            title: format!("{name} title"),
            blurb: "blurb".into(),
            icon: "terminal".into(),
            state,
            version: None,
            update: None,
            example: None,
        }
    }

    #[test]
    fn the_working_card_reads_the_download_progress() {
        assert_eq!(
            working_status(Some(OfficialInstallPhase::Downloading {
                received: 50,
                total: 200
            })),
            "Downloading… 25%"
        );
        assert_eq!(
            working_status(Some(OfficialInstallPhase::Downloading {
                received: 50,
                total: 0
            })),
            "Downloading…"
        );
        assert_eq!(
            working_status(Some(OfficialInstallPhase::Installing)),
            "Installing…"
        );
        assert_eq!(working_status(None), "Installing…");
    }

    #[test]
    fn the_cli_starts_picked_and_titles_follow_the_phase() {
        let plugins = vec![
            plugin("cli", OfficialPluginState::Available),
            plugin("ai", OfficialPluginState::ComingSoon),
        ];
        let mut step = PluginsStep::default();
        assert_eq!(step.picked(&plugins), vec!["cli".to_owned()]);
        assert_eq!(step.primary_title(&plugins, false), "Install");
        step.toggle(&plugins[0]);
        assert_eq!(step.primary_title(&plugins, false), "Continue");
        step.phase = Phase::Working;
        assert_eq!(step.primary_title(&plugins, false), "Installing…");
        assert_eq!(step.primary_title(&plugins, true), "Continue");
    }

    #[test]
    fn installs_settle_into_installed_or_failed() {
        let plugins = vec![plugin("cli", OfficialPluginState::Available)];
        let mut step = PluginsStep::default();
        step.finished_one("cli", Ok(()));
        step.settle();
        assert_eq!(step.phase, Phase::Installed);
        assert_eq!(
            step.installed_lines(&plugins),
            vec!["cli title installed".to_owned()]
        );
        let mut failing = PluginsStep::default();
        failing.finished_one("cli", Err("offline".into()));
        failing.settle();
        assert_eq!(failing.phase, Phase::Failed);
    }

    #[test]
    fn the_step_shows_only_with_something_to_offer() {
        assert!(!shown(None));
        assert!(!shown(Some(&[plugin(
            "x",
            OfficialPluginState::Unsupported
        )])));
        assert!(shown(Some(&[plugin(
            "cli",
            OfficialPluginState::Installed
        )])));
        assert_eq!(
            offered(&[
                plugin("x", OfficialPluginState::Unsupported),
                plugin("cli", OfficialPluginState::Available)
            ])
            .len(),
            1
        );
    }
}
