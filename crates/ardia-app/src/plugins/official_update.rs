use super::consent::{ConsentContext, consent_lines};
use super::manifest::{
    CommandAction, CommandSpec, Network, Permissions, PluginManifest, ProgramSpec,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptReason {
    Baseline,
    Permissions,
    Network,
    Runtime,
    Activation,
    Programs,
    Hooks,
    Settings,
    Contributions,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateVerdict {
    Within { added: Vec<String>, runtime: bool },
    Prompt(PromptReason),
}

fn sorted_hosts(network: &Network) -> Network {
    match network {
        Network::Hosts(hosts) => {
            let mut hosts = hosts.clone();
            hosts.sort();
            Network::Hosts(hosts)
        }
        other => other.clone(),
    }
}

fn permissions_within(a: &Permissions, b: &Permissions) -> Option<PromptReason> {
    if sorted_hosts(&a.network) != sorted_hosts(&b.network) {
        return Some(PromptReason::Network);
    }
    let without_network = |p: &Permissions| Permissions {
        network: Network::Off,
        ..p.clone()
    };
    (without_network(a) != without_network(b)).then_some(PromptReason::Permissions)
}

fn grants_main_nothing(p: &Permissions) -> bool {
    p.tabs.is_none()
        && !p.full_urls
        && !p.active_page
        && !p.workspace
        && !p.commands
        && !p.storage
        && !p.secrets
        && p.network == Network::Off
        && p.state.is_none()
}

fn first_main(approved: &PluginManifest, next: &PluginManifest) -> bool {
    approved.main.is_none() && next.main.is_some()
}

fn first_main_on_demand(next: &PluginManifest) -> bool {
    let k = &next.contributes;
    let elsewhere = next.page.is_some()
        || !k.panels.is_empty()
        || !k.sidebar_views.is_empty()
        || !k.toolbar.is_empty()
        || !k.omnibox.is_empty()
        || !k.tools.is_empty()
        || !k.hooks.is_empty()
        || !k.menus_tab.is_empty()
        || !k.menus_group.is_empty();
    !elsewhere
        && next.sidecar.is_none()
        && grants_main_nothing(&next.permissions)
        && next
            .activation_events
            .iter()
            .all(|e| e.starts_with("onCommand:"))
}

fn main_within(approved: &PluginManifest, next: &PluginManifest) -> Option<PromptReason> {
    if first_main(approved, next) {
        return (approved.sidecar.is_some() || !first_main_on_demand(next))
            .then_some(PromptReason::Runtime);
    }
    (approved.main != next.main).then_some(PromptReason::Runtime)
}

type Run<'a> = (
    Vec<(&'a str, &'a str, &'a Vec<Vec<String>>)>,
    Option<&'a str>,
);

fn runs<'a>(programs: &'a [ProgramSpec], fallback: Option<&'a str>) -> Run<'a> {
    (
        programs
            .iter()
            .map(|p| (p.name.as_str(), p.path.as_str(), &p.after_update))
            .collect(),
        programs
            .iter()
            .find_map(|p| p.example.as_deref())
            .or(fallback),
    )
}

fn addable(command: &CommandSpec) -> bool {
    matches!(
        command.action,
        CommandAction::View(_) | CommandAction::Handler
    )
}

fn commands_within(approved: &PluginManifest, next: &PluginManifest) -> Option<PromptReason> {
    let (a, b) = (&approved.contributes.commands, &next.contributes.commands);
    for before in a {
        if b.iter().find(|c| c.name == before.name) != Some(before) {
            return Some(PromptReason::Contributions);
        }
    }
    for command in b {
        if !a.iter().any(|c| c.name == command.name)
            && (!addable(command) || !first_main(approved, next))
        {
            return Some(PromptReason::Contributions);
        }
    }
    let kept: Vec<&str> = b
        .iter()
        .filter(|c| a.iter().any(|x| x.name == c.name))
        .map(|c| c.name.as_str())
        .collect();
    let before: Vec<&str> = a.iter().map(|c| c.name.as_str()).collect();
    (kept != before).then_some(PromptReason::Contributions)
}

fn user_only(events: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = events
        .iter()
        .filter(|e| !e.starts_with("onCommand:"))
        .map(String::as_str)
        .collect();
    out.sort_unstable();
    out
}

fn activation_within(approved: &PluginManifest, next: &PluginManifest) -> Option<PromptReason> {
    let (a, b) = (&approved.activation_events, &next.activation_events);
    if user_only(a) != user_only(b) {
        return Some(PromptReason::Activation);
    }
    let added_commands: Vec<&str> = next
        .contributes
        .commands
        .iter()
        .filter(|c| {
            !approved
                .contributes
                .commands
                .iter()
                .any(|x| x.name == c.name)
        })
        .map(|c| c.name.as_str())
        .collect();
    let ok = b
        .iter()
        .filter(|e| e.starts_with("onCommand:") && !a.contains(e))
        .filter_map(|e| e.strip_prefix("onCommand:"))
        .all(|name| added_commands.contains(&name));
    (!ok).then_some(PromptReason::Activation)
}

fn contributions_within(
    approved: &PluginManifest,
    next: &PluginManifest,
    fallback: Option<&str>,
) -> Option<PromptReason> {
    let (a, b) = (&approved.contributes, &next.contributes);
    if let Some(reason) = commands_within(approved, next) {
        return Some(reason);
    }
    if a.tools != b.tools {
        return Some(PromptReason::Contributions);
    }
    if a.hooks != b.hooks {
        return Some(PromptReason::Hooks);
    }
    if a.settings != b.settings {
        return Some(PromptReason::Settings);
    }
    if runs(&a.programs, fallback) != runs(&b.programs, fallback) {
        return Some(PromptReason::Programs);
    }
    let same_rest = a.password_manager == b.password_manager
        && a.menus_tab == b.menus_tab
        && a.menus_group == b.menus_group
        && a.toolbar == b.toolbar
        && a.sidebar_views == b.sidebar_views
        && a.panels == b.panels
        && a.omnibox == b.omnibox
        && a.themes == b.themes
        && a.site_switches == b.site_switches
        && a.page_bar == b.page_bar;
    (!same_rest).then_some(PromptReason::Contributions)
}

fn compare(
    approved: &PluginManifest,
    next: &PluginManifest,
    fallback: Option<&str>,
) -> Option<PromptReason> {
    if approved.name != next.name || !(approved.official && next.official) {
        return Some(PromptReason::Baseline);
    }
    if let Some(reason) = permissions_within(&approved.permissions, &next.permissions) {
        return Some(reason);
    }
    if let Some(reason) = main_within(approved, next) {
        return Some(reason);
    }
    if approved.sidecar != next.sidecar {
        return Some(PromptReason::Runtime);
    }
    if let Some(reason) = activation_within(approved, next) {
        return Some(reason);
    }
    if let Some(reason) = contributions_within(approved, next, fallback) {
        return Some(reason);
    }
    if approved.always_on != next.always_on || approved.auto_install != next.auto_install {
        return Some(PromptReason::Runtime);
    }
    (approved.page != next.page).then_some(PromptReason::Contributions)
}

fn lines(m: &PluginManifest) -> Vec<String> {
    let mut sorted = m.clone();
    sorted.permissions.network = sorted_hosts(&m.permissions.network);
    let context = ConsentContext {
        control_off: false,
        official: false,
        moves_profiles: 0,
        installed: false,
    };
    consent_lines(&sorted, context)
        .into_iter()
        .map(|line| line.text)
        .collect()
}

pub fn update_within(
    approved: &PluginManifest,
    next: &PluginManifest,
    fallback_example: Option<&str>,
) -> UpdateVerdict {
    if let Some(reason) = compare(approved, next, fallback_example) {
        return UpdateVerdict::Prompt(reason);
    }
    let before = lines(approved);
    UpdateVerdict::Within {
        added: lines(next)
            .into_iter()
            .filter(|text| !before.contains(text))
            .collect(),
        runtime: first_main(approved, next),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::read_manifest;

    fn manifest(text: &str) -> PluginManifest {
        let read = read_manifest(text);
        read.manifest
            .unwrap_or_else(|| panic!("manifest loads: {:?}", read.problems))
    }

    const BASE: &str = r#"{"manifest":2,"name":"cli","title":"Command Line","version":"0.6.0","official":true,"alwaysOn":true,
        "permissions":{"control":true},
        "contributes":{"programs":[{"name":"ardia","path":"bin/ardia","claim":true,"example":"ardia tabs"}]}}"#;

    #[test]
    fn cosmetic_changes_update_by_themselves() {
        let before = manifest(BASE);
        let after = manifest(
            &BASE
                .replace("0.6.0", "0.7.0")
                .replace("\"Command Line\"", "\"Command Line Tools\""),
        );
        assert_eq!(
            update_within(&before, &after, None),
            UpdateVerdict::Within {
                added: Vec::new(),
                runtime: false
            }
        );
    }

    #[test]
    fn new_permissions_programs_and_commands_ask_first() {
        let before = manifest(BASE);
        let tabs = manifest(&BASE.replace(
            r#""permissions":{"control":true}"#,
            r#""permissions":{"control":true,"tabs":"read"}"#,
        ));
        assert_eq!(
            update_within(&before, &tabs, None),
            UpdateVerdict::Prompt(PromptReason::Permissions)
        );
        let net = manifest(&BASE.replace(
            r#""permissions":{"control":true}"#,
            r#""permissions":{"control":true,"network":["example.com"]}"#,
        ));
        assert_eq!(
            update_within(&before, &net, None),
            UpdateVerdict::Prompt(PromptReason::Network)
        );
        let program = manifest(&BASE.replace("bin/ardia", "bin/other"));
        assert_eq!(
            update_within(&before, &program, None),
            UpdateVerdict::Prompt(PromptReason::Programs)
        );
        let not_official = manifest(&BASE.replace("\"official\":true,", ""));
        assert_eq!(
            update_within(&before, &not_official, None),
            UpdateVerdict::Prompt(PromptReason::Baseline)
        );
    }

    #[test]
    fn a_first_on_demand_main_with_a_view_command_is_within() {
        let before = manifest(BASE);
        let after = manifest(&BASE.replace(
            r#""contributes":{"#,
            r#""main":"dist/main.js","contributes":{"commands":[{"name":"show-status","title":"Show Status","view":"status"}],"#,
        ));
        match update_within(&before, &after, None) {
            UpdateVerdict::Within { runtime, .. } => assert!(runtime),
            other => panic!("{other:?}"),
        }
    }
}
