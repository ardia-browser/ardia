use std::collections::HashSet;

use crate::BrowserState;
use crate::air_traffic::{LinkCondition, LinkSource, OpenAs, RoutedBy, SourceApp, Target};
use crate::group_names::{Member, group_label};
use crate::ids::ProfileId;

pub const USED_LAST: &str = "Profile you used last";
pub const CLOSED_GROUP: &str = "A closed tab group";
const PARKED_GROUP_NAME: &str = "Tab Group";

pub const COMMON_APPS: &[(&str, &str)] = &[
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("com.apple.mail", "Mail"),
    ("com.apple.MobileSMS", "Messages"),
    ("notion.id", "Notion"),
    ("com.linear", "Linear"),
    ("com.hnc.Discord", "Discord"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("us.zoom.xos", "Zoom"),
    ("com.apple.iCal", "Calendar"),
    ("com.microsoft.Outlook", "Microsoft Outlook"),
    ("ru.keepcoder.Telegram", "Telegram"),
    ("net.whatsapp.WhatsApp", "WhatsApp"),
];

pub const OPEN_CHOICES: &[(OpenAs, &str)] = &[
    (OpenAs::Tab, "New tab"),
    (OpenAs::Window, "New window"),
    (OpenAs::LittleArdia, "Little Ardia"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConditionKind {
    Any,
    Site,
    Pattern,
    Contains,
    Equals,
}

pub const CONDITION_CHOICES: &[(ConditionKind, &str)] = &[
    (ConditionKind::Any, "Any link"),
    (ConditionKind::Site, "Links to a site"),
    (ConditionKind::Pattern, "Links matching a pattern"),
    (ConditionKind::Contains, "Links containing"),
    (ConditionKind::Equals, "Links to exactly"),
];

impl ConditionKind {
    pub fn of(when: &LinkCondition) -> ConditionKind {
        match when {
            LinkCondition::Any => ConditionKind::Any,
            LinkCondition::Site(_) => ConditionKind::Site,
            LinkCondition::Pattern(_) => ConditionKind::Pattern,
            LinkCondition::Contains(_) => ConditionKind::Contains,
            LinkCondition::Equals(_) => ConditionKind::Equals,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            ConditionKind::Any => "any",
            ConditionKind::Site => "site",
            ConditionKind::Pattern => "pattern",
            ConditionKind::Contains => "contains",
            ConditionKind::Equals => "equals",
        }
    }

    pub fn from_key(key: &str) -> Option<ConditionKind> {
        CONDITION_CHOICES
            .iter()
            .map(|(kind, _)| *kind)
            .find(|kind| kind.key() == key)
    }

    pub fn placeholder(self) -> &'static str {
        match self {
            ConditionKind::Any => "",
            ConditionKind::Site => "github.com",
            ConditionKind::Pattern => "*github* or https://*.example.com/docs/*",
            ConditionKind::Contains => "meet.google.com",
            ConditionKind::Equals => "example.com/docs",
        }
    }
}

pub fn open_label(open: OpenAs) -> &'static str {
    OPEN_CHOICES
        .iter()
        .find(|(choice, _)| *choice == open)
        .map_or("New tab", |(_, label)| label)
}

pub fn open_from_key(key: &str) -> Option<OpenAs> {
    OPEN_CHOICES
        .iter()
        .map(|(open, _)| *open)
        .find(|open| open.key() == key)
}

pub fn condition_text(when: &LinkCondition) -> &str {
    match when {
        LinkCondition::Any => "",
        LinkCondition::Site(host) => host,
        LinkCondition::Pattern(pattern) => pattern,
        LinkCondition::Contains(text) | LinkCondition::Equals(text) => text,
    }
}

pub fn condition_label(when: &LinkCondition) -> String {
    match when {
        LinkCondition::Any => "any link".into(),
        LinkCondition::Site(host) => host.clone(),
        LinkCondition::Pattern(pattern) => pattern.clone(),
        LinkCondition::Contains(text) => format!("containing \u{201c}{text}\u{201d}"),
        LinkCondition::Equals(text) => format!("exactly {text}"),
    }
}

pub fn from_label(from: Option<&SourceApp>) -> String {
    from.map_or_else(|| "Any app".into(), |app| format!("From {}", app.name))
}

pub fn source_app_key(app: &SourceApp) -> String {
    app.bundle_id
        .clone()
        .unwrap_or_else(|| format!("name:{}", app.name))
        .to_lowercase()
}

pub fn typed_app(text: &str) -> Option<SourceApp> {
    let typed = text.trim();
    if typed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = typed.split('.').collect();
    let bundle_like = parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        });
    Some(SourceApp {
        bundle_id: bundle_like.then(|| typed.to_owned()),
        name: typed.to_owned(),
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PickableApps {
    pub recent: Vec<SourceApp>,
    pub common: Vec<SourceApp>,
}

pub fn pickable_apps(recent: &[SourceApp], extras: &[Option<SourceApp>]) -> PickableApps {
    let mut seen = HashSet::new();
    let mut fresh = |app: &SourceApp| seen.insert(source_app_key(app));
    let listed = recent
        .iter()
        .cloned()
        .chain(extras.iter().flatten().cloned())
        .filter(|app| fresh(app))
        .collect();
    let common = COMMON_APPS
        .iter()
        .map(|(bundle, name)| SourceApp {
            bundle_id: Some((*bundle).to_owned()),
            name: (*name).to_owned(),
        })
        .filter(|app| fresh(app))
        .collect();
    PickableApps {
        recent: listed,
        common,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteGroup {
    pub key: String,
    pub name: String,
}

pub fn routable_profiles(state: &BrowserState) -> Vec<(ProfileId, String)> {
    state
        .profile_order
        .iter()
        .filter(|id| !id.is_incognito())
        .filter_map(|id| state.profiles.get(id).map(|p| (id.clone(), p.name.clone())))
        .collect()
}

pub fn route_groups(state: &BrowserState, profile: &ProfileId) -> Vec<RouteGroup> {
    let mut seen = HashSet::new();
    let mut live: Vec<_> = state
        .groups
        .values()
        .filter(|group| &group.profile_id == profile)
        .collect();
    live.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    let mut groups = Vec::new();
    for group in live {
        let key = group.pin_key().to_owned();
        if !seen.insert(key.clone()) {
            continue;
        }
        let members: Vec<Member> = group
            .tab_ids
            .iter()
            .filter_map(|id| state.tab(id.as_str()))
            .map(|tab| Member {
                url: &tab.url,
                title: &tab.title,
            })
            .collect();
        groups.push(RouteGroup {
            key,
            name: group_label(&group.name, &members),
        });
    }
    if let Some(parked) = state.persisted.parked_pins.get(profile) {
        for group in &parked.groups {
            if !seen.insert(group.id.clone()) {
                continue;
            }
            groups.push(RouteGroup {
                key: group.id.clone(),
                name: if group.name.is_empty() {
                    PARKED_GROUP_NAME.into()
                } else {
                    group.name.clone()
                },
            });
        }
    }
    groups
}

pub fn route_group_name(state: &BrowserState, profile: &ProfileId, key: &str) -> Option<String> {
    route_groups(state, profile)
        .into_iter()
        .find(|group| group.key == key)
        .map(|group| group.name)
}

pub fn target_label(state: &BrowserState, target: &Target) -> Option<String> {
    let profile = match &target.profile_id {
        None => USED_LAST.to_owned(),
        Some(id) => state
            .profiles
            .get(id)
            .filter(|_| !id.is_incognito())?
            .name
            .clone(),
    };
    Some(match (&target.group_key, &target.profile_id) {
        (Some(key), Some(id)) => format!(
            "{profile} \u{203a} {}",
            route_group_name(state, id, key).unwrap_or_else(|| CLOSED_GROUP.into())
        ),
        _ => format!("{profile} \u{b7} {}", open_label(target.open)),
    })
}

pub fn group_gone(state: &BrowserState, target: &Target) -> bool {
    match (&target.group_key, &target.profile_id) {
        (Some(key), Some(id)) => route_group_name(state, id, key).is_none(),
        _ => false,
    }
}

pub fn rule_problem(state: &BrowserState, target: &Target) -> Option<&'static str> {
    if target_label(state, target).is_none() {
        return Some("Its profile is gone, so this rule is skipped. Edit it to pick another.");
    }
    group_gone(state, target).then_some(
        "Its tab group isn't open, so links open as a plain tab in this profile. Edit it to pick another.",
    )
}

pub fn preview_url(typed: &str) -> Option<String> {
    let text = typed.trim();
    if text.is_empty() {
        return None;
    }
    let schemed = text.find("://").is_some_and(|at| {
        at > 0
            && text.starts_with(|c: char| c.is_ascii_alphabetic())
            && text[..at]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let candidate = if schemed {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    let url = url::Url::parse(&candidate).ok()?;
    if text.contains(char::is_whitespace) {
        return None;
    }
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    Some(url.to_string())
}

fn web_page(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkPreview {
    pub title: String,
    pub detail: String,
}

pub fn preview_link(state: &BrowserState, typed: &str, source: &LinkSource) -> Option<LinkPreview> {
    let url = preview_url(typed)?;
    let decision = state.route_link(&url, source);
    let decided = decision.by.is_some();
    let open = if decided {
        decision.open
    } else if state.settings.open_links_in_little_ardia && web_page(&url) {
        OpenAs::LittleArdia
    } else {
        OpenAs::Tab
    };
    let profile_name = state
        .profiles
        .get(&decision.profile_id)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let group = decision
        .group_key
        .as_deref()
        .and_then(|key| route_group_name(state, &decision.profile_id, key));
    let used_last = match &decision.by {
        Some(RoutedBy::Rule(id)) => state
            .air_traffic
            .rules
            .iter()
            .find(|r| &r.id == id)
            .is_none_or(|r| r.target.profile_id.is_none()),
        Some(RoutedBy::Fallback) => state
            .air_traffic
            .fallback
            .as_ref()
            .is_none_or(|t| t.profile_id.is_none()),
        None => true,
    };
    let lands = format!(
        "Opens in {profile_name}{}{} \u{b7} {}",
        if used_last { " (used last)" } else { "" },
        group.map(|g| format!(" \u{203a} {g}")).unwrap_or_default(),
        open_label(open)
    );
    Some(match decision.by {
        Some(RoutedBy::Rule(id)) => {
            let (index, rule) = state
                .air_traffic
                .rules
                .iter()
                .enumerate()
                .find(|(_, r)| r.id == id)?;
            LinkPreview {
                title: format!(
                    "Rule {}: {} \u{b7} {}",
                    index + 1,
                    from_label(rule.from.as_ref()),
                    condition_label(&rule.when)
                ),
                detail: lands,
            }
        }
        Some(RoutedBy::Fallback) => LinkPreview {
            title: "Links no rule catches".into(),
            detail: lands,
        },
        None => LinkPreview {
            title: "No rule catches it".into(),
            detail: format!("Ardia's usual routing. {lands}"),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_read_like_the_old_rule_rows() {
        assert_eq!(condition_label(&LinkCondition::Any), "any link");
        assert_eq!(
            condition_label(&LinkCondition::Contains("meet".into())),
            "containing \u{201c}meet\u{201d}"
        );
        assert_eq!(
            condition_label(&LinkCondition::Equals("a.com/x".into())),
            "exactly a.com/x"
        );
        assert_eq!(from_label(None), "Any app");
        let slack = SourceApp {
            bundle_id: Some("com.tinyspeck.slackmacgap".into()),
            name: "Slack".into(),
        };
        assert_eq!(from_label(Some(&slack)), "From Slack");
        assert_eq!(open_label(OpenAs::LittleArdia), "Little Ardia");
    }

    #[test]
    fn typed_apps_tell_bundle_ids_from_names() {
        assert_eq!(
            typed_app(" com.tinyspeck.slackmacgap "),
            Some(SourceApp {
                bundle_id: Some("com.tinyspeck.slackmacgap".into()),
                name: "com.tinyspeck.slackmacgap".into()
            })
        );
        assert_eq!(
            typed_app("Linear"),
            Some(SourceApp {
                bundle_id: None,
                name: "Linear".into()
            })
        );
        assert_eq!(typed_app("   "), None);
    }

    #[test]
    fn pickable_apps_put_recent_first_and_skip_repeats() {
        let slack = SourceApp {
            bundle_id: Some("com.tinyspeck.slackmacgap".into()),
            name: "Slack".into(),
        };
        let odd = SourceApp {
            bundle_id: None,
            name: "Odd".into(),
        };
        let lists = pickable_apps(
            std::slice::from_ref(&slack),
            &[Some(odd.clone()), Some(slack.clone()), None],
        );
        assert_eq!(lists.recent.len(), 2);
        assert_eq!(lists.recent[1], odd);
        assert_eq!(lists.common.len(), COMMON_APPS.len() - 1);
        assert!(lists.common.iter().all(|a| a.name != "Slack"));
    }

    #[test]
    fn preview_urls_add_https_and_refuse_junk() {
        assert_eq!(
            preview_url("github.com/ardia").as_deref(),
            Some("https://github.com/ardia")
        );
        assert_eq!(
            preview_url("http://example.com").as_deref(),
            Some("http://example.com/")
        );
        assert_eq!(preview_url("not a link"), None);
        assert_eq!(preview_url(""), None);
    }

    #[test]
    fn condition_kinds_round_trip_their_keys() {
        for (kind, _) in CONDITION_CHOICES {
            assert_eq!(ConditionKind::from_key(kind.key()), Some(*kind));
        }
        assert_eq!(
            ConditionKind::of(&LinkCondition::Site("a.com".into())),
            ConditionKind::Site
        );
        assert_eq!(open_from_key("littleArdia"), Some(OpenAs::LittleArdia));
    }
}
