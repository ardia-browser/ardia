use ardia_ui::plugins::model::ConsentLine;

use super::manifest::{
    CommandAction, HOST_ACTIONS, Network, PanelMode, Permissions, PluginManifest, RowKind,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConsentContext {
    pub control_off: bool,
    pub official: bool,
    pub moves_profiles: usize,
    pub installed: bool,
}

const COMPUTER: &str = "Mac";

pub const CONTROL_OFF_LINE: &str = "Control is off, as you set it, and installing this leaves it off. To let programs drive Ardia, turn on “Let programs control Ardia” in Settings › Advanced";

fn line(icon: &str, text: impl Into<String>) -> ConsentLine {
    ConsentLine {
        icon: icon.to_owned(),
        text: text.into(),
    }
}

fn listed(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn full_control_reach() -> String {
    format!(
        "every tab and page, your signed-in sites and their cookies, and uploads and downloads of any file on this {COMPUTER}"
    )
}

pub fn full_control_line(m: &PluginManifest, context: ConsentContext) -> Option<ConsentLine> {
    let programs = &m.contributes.programs;
    let after_updates = programs.iter().any(|p| !p.after_update.is_empty());
    if m.permissions.control {
        let who = if after_updates {
            "any program you run, and the commands Ardia runs for it after updates,"
        } else {
            "any program you run"
        };
        let when = if context.control_off || context.installed {
            "While control is on in Settings › Advanced"
        } else {
            "Turns on control in Settings › Advanced. While it's on"
        };
        return Some(line(
            "hand.raised",
            format!(
                "{when}, {who} can fully control Ardia: {}",
                full_control_reach()
            ),
        ));
    }
    if programs.is_empty() {
        return None;
    }
    let names = programs
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(" and ");
    let one = programs.len() == 1;
    let runs = format!(
        "The {names} {} as you",
        if one { "command runs" } else { "commands run" }
    );
    let who = if after_updates {
        format!(
            "{runs}, as do the commands Ardia runs for it after updates, so while control is on in Settings › Advanced, they"
        )
    } else {
        format!(
            "{runs}, so while control is on in Settings › Advanced, {}",
            if one { "it" } else { "they" }
        )
    };
    Some(line(
        "hand.raised",
        format!("{who} can fully control Ardia: {}", full_control_reach()),
    ))
}

fn runtime_lines(m: &PluginManifest) -> Vec<ConsentLine> {
    let mut lines = Vec::new();
    if m.main.is_some() {
        let background = m
            .activation_events
            .iter()
            .any(|e| e == "*" || e == "onStartupFinished" || e.starts_with("onEvent:"));
        lines.push(line(
            "shippingbox",
            if background {
                "Runs its code in the background, in Ardia's plugin sandbox"
            } else {
                "Runs its code in Ardia's plugin sandbox, starting the first time you use it and stopping when you quit Ardia or turn the plugin off"
            },
        ));
    }
    if let Some(sidecar) = &m.sidecar {
        lines.push(line(
            "gearshape",
            format!(
                "Runs a program in the background: {}",
                sidecar.run.join(" ")
            ),
        ));
    }
    for p in &m.contributes.programs {
        lines.push(line(
            "terminal.fill",
            format!(
                "Adds {} to your PATH. It runs as you, outside Ardia's sandbox",
                p.name
            ),
        ));
        if !p.after_update.is_empty() {
            let runs: Vec<String> = p
                .after_update
                .iter()
                .map(|a| {
                    std::iter::once(p.name.clone())
                        .chain(a.iter().cloned())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect();
            lines.push(line(
                "arrow.triangle.2.circlepath",
                format!("After updates, runs {}", runs.join(", ")),
            ));
        }
    }
    if !m.contributes.programs.is_empty() {
        lines.push(line(
            "doc.text",
            "Adds ~/.local/bin to your PATH in your shell's login file",
        ));
    }
    lines
}

fn network_lines(m: &PluginManifest) -> Vec<ConsentLine> {
    let who = if m.sidecar.is_some() {
        "That program"
    } else {
        "It"
    };
    match &m.permissions.network {
        Network::Any => vec![line(
            "network",
            if m.sidecar.is_some() {
                format!(
                    "That program may connect to the internet and to servers on this {COMPUTER}, and a server it starts may listen on your network address"
                )
            } else {
                format!("It may connect to any site, and to servers on this {COMPUTER}")
            },
        )],
        Network::Hosts(hosts) => vec![line(
            "network",
            format!(
                "Its code may connect only to {}, through Ardia. Its pages and views stay offline",
                hosts.join(", ")
            ),
        )],
        Network::Off if m.sidecar.is_some() || m.main.is_some() => vec![line(
            "antenna.radiowaves.left.and.right.slash",
            format!(
                "{who} can't connect to anything or accept connections, not even from this {COMPUTER}"
            ),
        )],
        Network::Off => Vec::new(),
    }
}

fn topic_words(topic: &str) -> &'static str {
    match topic {
        "tabs" => "your tabs change",
        "workspace" => "your windows and groups change",
        "navigation" => "a tab goes to a new page",
        _ => "a download starts, moves along or finishes",
    }
}

fn intent_words(intent: &str) -> &'static str {
    match intent {
        "tabs.group" => "group tabs",
        "tabs.ungroup" => "ungroup tabs",
        "tabs.move" => "move tabs",
        "tabs.pin" => "pin tabs",
        "tabs.unpin" => "unpin tabs",
        "tabs.mute" => "mute tabs",
        "tabs.unmute" => "unmute tabs",
        "tabs.activate" => "switch tabs",
        _ => "rename, recolour and fold groups",
    }
}

fn state_lines(p: &Permissions) -> Vec<ConsentLine> {
    let Some(state) = &p.state else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    if !state.events.is_empty() {
        let heard: Vec<&str> = state.events.iter().map(|t| topic_words(t)).collect();
        let downloads = if state.events.iter().any(|t| t == "downloads") {
            ", private downloads or where a file was saved"
        } else {
            ""
        };
        lines.push(line(
            "dot.radiowaves.left.and.right",
            format!(
                "Hears when {}. Never private windows{downloads}",
                heard.join(", when ")
            ),
        ));
    }
    if !state.intents.is_empty() {
        let can: Vec<&str> = state.intents.iter().map(|i| intent_words(i)).collect();
        lines.push(line(
            "arrow.up.arrow.down.square",
            format!("Can {}. Never in private windows", can.join(", ")),
        ));
    }
    lines
}

fn permission_lines(m: &PluginManifest) -> Vec<ConsentLine> {
    let p = &m.permissions;
    let mut lines = network_lines(m);
    if let Some(tabs) = &p.tabs {
        let seen = if p.full_urls {
            "Sees the full address and title of your tabs"
        } else {
            "Sees the address (without what follows ? or #) and title of your tabs"
        };
        let write = if tabs == "write" {
            ", and can open, close and switch tabs"
        } else {
            ""
        };
        lines.push(line("square.on.square", format!("{seen}{write}")));
    }
    if p.workspace {
        lines.push(line("square.grid.2x2", "Sees and rearranges every window, tab and group: it can move, close and group your tabs"));
    }
    if p.active_page {
        lines.push(line("text.magnifyingglass", "Reads the text of the tab you're on, for 30 seconds after you use it. Never in private windows"));
    }
    if !m.contributes.hooks.is_empty() {
        lines.push(line(
            "bell",
            format!("Hears these events: {}", m.contributes.hooks.join(", ")),
        ));
    }
    lines.extend(state_lines(p));
    if p.commands {
        lines.push(line(
            "command",
            "Runs Ardia commands, like opening and closing tabs",
        ));
    }
    if p.storage {
        lines.push(line(
            "internaldrive",
            format!("Keeps its own data on this {COMPUTER}"),
        ));
    }
    if p.secrets {
        lines.push(line(
            "key",
            "Keeps secrets, like sign-in tokens, in your Keychain",
        ));
    }
    lines
}

pub const DECIDE_EVENTS: [&str; 4] = [
    "tab.opening",
    "link.opening",
    "download.deciding",
    "permission.requested",
];

pub fn is_decide_event(name: &str) -> bool {
    DECIDE_EVENTS.contains(&name)
}

fn contribution_lines(m: &PluginManifest) -> Vec<ConsentLine> {
    let k = &m.contributes;
    let mut lines = Vec::new();
    let mut slots = Vec::new();
    if !k.menus_tab.is_empty() {
        slots.push("tabs".to_owned());
    }
    if !k.menus_group.is_empty() {
        slots.push("groups".to_owned());
    }
    if !slots.is_empty() {
        lines.push(line(
            "ellipsis.circle",
            format!("Adds to the menu you get on {}", listed(&slots)),
        ));
    }
    if !k.toolbar.is_empty() {
        let count = if k.toolbar.len() == 1 {
            "a button".to_owned()
        } else {
            format!("{} buttons", k.toolbar.len())
        };
        let titles: Vec<&str> = k.toolbar.iter().map(|t| t.title.as_str()).collect();
        lines.push(line(
            "menubar.rectangle",
            format!("Adds {count} to the toolbar: {}", titles.join(", ")),
        ));
    }
    if !k.sidebar_views.is_empty() {
        let titles: Vec<&str> = k.sidebar_views.iter().map(|v| v.title.as_str()).collect();
        lines.push(line(
            "sidebar.left",
            format!("Adds to the sidebar: {}", titles.join(", ")),
        ));
    }
    let extra: Vec<String> = k
        .panels
        .iter()
        .filter(|p| {
            !m.page.as_ref().is_some_and(|page| {
                p.file.as_deref() == Some(page.file.as_str()) && p.title == page.title
            })
        })
        .map(|p| {
            let mode = match p.mode {
                PanelMode::Sidecar => "a side panel",
                PanelMode::Tab => "a tab",
                PanelMode::Split => "Split View",
            };
            format!("{} (in {mode})", p.title)
        })
        .collect();
    if !extra.is_empty() {
        lines.push(line(
            "rectangle.righthalf.inset.filled",
            format!("Adds panels: {}", extra.join(", ")),
        ));
    }
    if !k.omnibox.is_empty() {
        let global = if k.omnibox.iter().any(|o| o.global) {
            " as you type"
        } else {
            ""
        };
        let titles: Vec<String> = k
            .omnibox
            .iter()
            .map(|o| match &o.keyword {
                Some(keyword) => format!("{} ({keyword})", o.title),
                None => o.title.clone(),
            })
            .collect();
        lines.push(line(
            "magnifyingglass",
            format!("Suggests results in the address bar{global}: {}. What you type there goes to the plugin", titles.join(", ")),
        ));
    }
    if !k.themes.is_empty() {
        let titles: Vec<&str> = k.themes.iter().map(|t| t.title.as_str()).collect();
        lines.push(line(
            "paintpalette",
            format!("Offers themes: {}", titles.join(", ")),
        ));
    }
    let deciding: Vec<&str> = k
        .hooks
        .iter()
        .map(String::as_str)
        .filter(|h| is_decide_event(h))
        .collect();
    if !deciding.is_empty() {
        lines.push(line(
            "arrow.triangle.swap",
            format!("Can stop or redirect {}", deciding.join(", ")),
        ));
    }
    if k.settings
        .rows
        .iter()
        .any(|r| matches!(r.kind, RowKind::Secret { .. }))
    {
        lines.push(line(
            "lock.shield",
            "Asks for secrets in its settings, which stay in your Keychain",
        ));
    }
    lines
}

fn password_manager_lines(m: &PluginManifest, context: ConsentContext) -> Vec<ConsentLine> {
    let Some(pm) = &m.contributes.password_manager else {
        return Vec::new();
    };
    let mut lines = vec![line(
        "key.fill",
        "Becomes a password manager you can pick for each profile. Profiles that use it stop offering to save passwords in Ardia",
    )];
    let moves = if context.official {
        context.moves_profiles
    } else {
        0
    };
    if moves > 0 {
        let count = if moves == 1 {
            "1 profile".to_owned()
        } else {
            format!("{moves} profiles")
        };
        lines.push(line(
            "person.2",
            format!(
                "Moves {count} that never picked a password manager to {}",
                m.title
            ),
        ));
    }
    let fields: Vec<&str> = pm
        .fields
        .iter()
        .map(|f| {
            if f == "login" {
                "login"
            } else {
                "verification code"
            }
        })
        .collect();
    lines.push(line(
        "key",
        format!("Shows a key in {} fields on every site. It opens macOS's Passwords panel there, which fills the field; the plugin never sees what's filled", fields.join(" and ")),
    ));
    if pm.verification_code_setup {
        lines.push(line(
            "qrcode",
            "Offers to set up two-factor codes a page shows in the app macOS uses for them",
        ));
    }
    lines
}

fn page_bar_lines(m: &PluginManifest) -> Vec<ConsentLine> {
    let switches = &m.contributes.site_switches;
    let mut lines = Vec::new();
    if let Some(first) = switches.first() {
        let what = if switches.len() == 1 {
            format!("a {} switch", first.title)
        } else {
            format!(
                "switches ({})",
                switches
                    .iter()
                    .map(|s| s.title.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        lines.push(line(
            &first.icon,
            format!("Adds {what} to Site Controls, for each site"),
        ));
    }
    let Some(bar) = &m.contributes.page_bar else {
        return lines;
    };
    let verbs: Vec<String> = bar
        .buttons
        .iter()
        .filter_map(|b| {
            HOST_ACTIONS
                .iter()
                .find(|(n, _)| n == b)
                .map(|(_, verb)| (*verb).to_owned())
        })
        .collect();
    let title = switches
        .iter()
        .find(|s| s.key == bar.site_switch)
        .map_or("it", |s| s.title.as_str());
    lines.push(line(
        "menubar.rectangle",
        format!(
            "Shows a striped bar on sites where {title} is on, with buttons to {}",
            listed(&verbs)
        ),
    ));
    if bar.local_addresses.is_some() {
        lines.push(line(
            "desktopcomputer",
            format!("With one of its settings on, a local address you type in (like localhost) turns {title} on for that site"),
        ));
    }
    lines
}

pub fn consent_lines(m: &PluginManifest, context: ConsentContext) -> Vec<ConsentLine> {
    let mut lines: Vec<ConsentLine> = full_control_line(m, context).into_iter().collect();
    lines.extend(runtime_lines(m));
    lines.extend(permission_lines(m));
    if m.permissions.control && context.control_off {
        lines.push(line("hand.raised.slash", CONTROL_OFF_LINE));
    }
    let defaults: Vec<&str> = m
        .contributes
        .settings
        .defaults
        .keys()
        .map(String::as_str)
        .collect();
    if !defaults.is_empty() {
        lines.push(line(
            "slider.horizontal.3",
            format!(
                "Changes these settings while it's on: {}",
                defaults.join(", ")
            ),
        ));
    }
    let rows = m.contributes.settings.rows.len();
    if rows > 0 {
        let count = if rows == 1 {
            "a setting".to_owned()
        } else {
            format!("{rows} settings")
        };
        lines.push(line(
            "list.bullet",
            format!("Adds {count} to its page here"),
        ));
    }
    if let Some(page) = &m.page {
        lines.push(line(
            &page.icon,
            format!(
                "Adds a page you open as a tab: {} (ardia://{})",
                page.title, m.name
            ),
        ));
    }
    if m.contributes
        .commands
        .iter()
        .any(|c| matches!(c.action, CommandAction::Open { context: true, .. }))
    {
        lines.push(line(
            "rectangle.split.2x1",
            "Its page can be handed the tab you're on when you open it beside that tab",
        ));
    }
    if !m.contributes.commands.is_empty() {
        let titles: Vec<&str> = m
            .contributes
            .commands
            .iter()
            .map(|c| c.title.as_str())
            .collect();
        lines.push(line(
            "command",
            format!("Adds to the command bar: {}", titles.join(", ")),
        ));
    }
    if !m.contributes.tools.is_empty() {
        let titles: Vec<&str> = m
            .contributes
            .tools
            .iter()
            .map(|t| t.title.as_str())
            .collect();
        lines.push(line(
            "wrench.and.screwdriver",
            format!(
                "Offers tools to the ardia command and other plugins: {}",
                titles.join(", ")
            ),
        ));
    }
    lines.extend(contribution_lines(m));
    lines.extend(password_manager_lines(m, context));
    lines.extend(page_bar_lines(m));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::read_manifest;

    #[test]
    fn lines_follow_the_old_order_and_copy() {
        let m = read_manifest(
            r#"{"manifest":2,"name":"dev","title":"Dev","main":"main.js","activationEvents":["onStartupFinished"],
            "permissions":{"tabs":"write","storage":true},
            "contributes":{"siteSwitches":[{"key":"on","title":"Dev Mode","icon":"hammer"}],
              "pageBar":{"look":"stripes","when":{"siteSwitch":"on"},"buttons":["console","copyLink"]},
              "toolbar":[{"id":"a","title":"A","icon":"star","view":"a"}]}}"#,
        )
        .manifest
        .unwrap();
        let lines: Vec<String> = consent_lines(&m, ConsentContext::default())
            .into_iter()
            .map(|l| l.text)
            .collect();
        assert_eq!(
            lines[0],
            "Runs its code in the background, in Ardia's plugin sandbox"
        );
        assert_eq!(
            lines[1],
            "It can't connect to anything or accept connections, not even from this Mac"
        );
        assert_eq!(
            lines[2],
            "Sees the address (without what follows ? or #) and title of your tabs, and can open, close and switch tabs"
        );
        assert_eq!(lines[3], "Keeps its own data on this Mac");
        assert_eq!(lines[4], "Adds a button to the toolbar: A");
        assert_eq!(
            lines[5],
            "Adds a Dev Mode switch to Site Controls, for each site"
        );
        assert_eq!(
            lines[6],
            "Shows a striped bar on sites where Dev Mode is on, with buttons to open the Console and copy the page address"
        );
    }

    #[test]
    fn control_and_programs_get_the_full_control_line() {
        let m = read_manifest(
            r#"{"manifest":2,"name":"cli","title":"Command Line","main":"dist/main.js","permissions":{"control":true},
            "contributes":{"programs":[{"name":"ardia","path":"bin/ardia","afterUpdate":[["skills","refresh"]]}]}}"#,
        )
        .manifest
        .unwrap();
        let lines = consent_lines(
            &m,
            ConsentContext {
                control_off: true,
                ..ConsentContext::default()
            },
        );
        assert!(lines[0].text.starts_with("While control is on in Settings › Advanced, any program you run, and the commands Ardia runs for it after updates, can fully control Ardia"));
        assert!(
            lines
                .iter()
                .any(|l| l.text == "After updates, runs ardia skills refresh")
        );
        assert!(lines.iter().any(|l| l.text == CONTROL_OFF_LINE));
    }
}
