use std::collections::{HashMap, HashSet};

use ardia_state::groups::{self, GroupColor};
use ardia_state::model::TabPin;
use ardia_state::sync_engine::IndexMap;
use ardia_state::sync_engine::assign_positions;
use ardia_state::sync_engine::scope::{ExtractContext, Extraction};
use ardia_state::{BrowserState, ProfileId};
use serde_json::{Value, json};

use super::{
    PIN_GROUP, PIN_NEST_GROUP, PIN_NEST_TAB, PIN_ROW, PIN_TAB, choice_still_out, choices,
    group_choice_key, home_window, is_row, legacy_color, pin_sync, place_choice_key,
    settle_choices, windows_home_first,
};
use crate::sync_engine::adapters::CycleContext;

#[derive(Clone, Debug)]
pub struct PinInfo {
    pub key: String,
    pub url: String,
    pub title: String,
    pub custom_title: Option<String>,
    pub custom_icon: Option<String>,
    pub pin: Option<TabPin>,
    pub pinned_url: Option<String>,
}

#[derive(Clone, Debug)]
enum Node {
    Pin(PinInfo),
    Group(String),
}

#[derive(Clone, Debug)]
struct Info {
    name: String,
    icon: Option<String>,
    color: Option<GroupColor>,
}

#[derive(Default)]
struct Area {
    top: Vec<Node>,
    inside: HashMap<String, Vec<Node>>,
    info: IndexMap<String, Info>,
}

impl Area {
    fn enter(&mut self, chain: &[(String, Info)]) {
        for (i, (key, info)) in chain.iter().enumerate() {
            if self.info.contains_key(key) {
                continue;
            }
            let parent = i.checked_sub(1).map(|p| chain[p].0.clone());
            self.info.insert(key.clone(), info.clone());
            self.inside.insert(key.clone(), Vec::new());
            match parent {
                Some(parent) => self
                    .inside
                    .entry(parent)
                    .or_default()
                    .push(Node::Group(key.clone())),
                None => self.top.push(Node::Group(key.clone())),
            }
        }
    }

    fn flat(&self, key: &str) -> Vec<(PinInfo, String)> {
        let mut out = Vec::new();
        for n in self.inside.get(key).into_iter().flatten() {
            match n {
                Node::Pin(p) => out.push((p.clone(), key.to_owned())),
                Node::Group(g) => out.extend(self.flat(g)),
            }
        }
        out
    }
}

fn info_of_tab(t: &ardia_state::tabs::Tab) -> PinInfo {
    PinInfo {
        key: t.pin_key().to_owned(),
        url: t.url.clone(),
        title: t.title.clone(),
        custom_title: t.custom_title.clone(),
        custom_icon: t.custom_icon.clone(),
        pin: t.pin.clone(),
        pinned_url: t.pinned_url.clone(),
    }
}

fn info_of_parked(p: &ardia_state::closed::ParkedTab) -> PinInfo {
    PinInfo {
        key: p.id.clone(),
        url: p.snapshot.url.clone(),
        title: p.snapshot.title.clone(),
        custom_title: p.snapshot.custom_title.clone(),
        custom_icon: p.snapshot.custom_icon.clone(),
        pin: p.snapshot.pin.clone(),
        pinned_url: p.snapshot.pinned_url.clone(),
    }
}

fn opt(value: &Option<String>) -> Value {
    value.clone().map_or(Value::Null, Value::String)
}

pub fn pinned_values(
    s: &BrowserState,
    profile: &ProfileId,
    base: &dyn Fn(&str) -> Option<Value>,
    now: i64,
) -> IndexMap<String, Value> {
    let mut area = Area::default();
    let pinned: Vec<_> = s
        .groups
        .values()
        .filter(|g| g.pinned && g.profile_id == *profile)
        .cloned()
        .collect();
    let mut by_depth: Vec<_> = pinned
        .iter()
        .map(|g| (g.clone(), groups::depth(&s.groups, g.id.as_str())))
        .collect();
    by_depth.sort_by_key(|(_, d)| *d);
    let mut pinned_group_of: HashMap<
        ardia_state::TabId,
        std::sync::Arc<ardia_state::groups::TabGroup>,
    > = HashMap::new();
    for (g, _) in by_depth {
        for id in &g.tab_ids {
            pinned_group_of.insert(id.clone(), g.clone());
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let home = home_window(s, profile);
    for w in windows_home_first(s, home.as_ref()) {
        for id in &w.tab_ids {
            let Some(t) = s.tabs.get(id) else { continue };
            if t.profile_id != *profile || seen.contains(t.pin_key()) {
                continue;
            }
            if t.pin.is_some() {
                area.top.push(Node::Pin(info_of_tab(t)));
            } else if let Some(g) = pinned_group_of.get(id) {
                let mut chain: Vec<(String, Info)> = groups::ancestors(&s.groups, g.id.as_str())
                    .into_iter()
                    .rev()
                    .filter_map(|x| s.groups.get(&x).cloned())
                    .filter(|x| x.pinned)
                    .map(|x| {
                        (
                            x.pin_key().to_owned(),
                            Info {
                                name: x.name.clone(),
                                icon: x.icon.clone(),
                                color: x.color,
                            },
                        )
                    })
                    .collect();
                chain.push((
                    g.pin_key().to_owned(),
                    Info {
                        name: g.name.clone(),
                        icon: g.icon.clone(),
                        color: g.color,
                    },
                ));
                area.enter(&chain);
                area.inside
                    .entry(g.pin_key().to_owned())
                    .or_default()
                    .push(Node::Pin(info_of_tab(t)));
            } else {
                continue;
            }
            seen.insert(t.pin_key().to_owned());
        }
    }
    if let Some(park) = s.persisted.parked_pins.get(profile) {
        let park_groups: HashMap<&str, &ardia_state::closed::ParkedGroup> =
            park.groups.iter().map(|g| (g.id.as_str(), g)).collect();
        let park_chain = |key: &str| -> Vec<(String, Info)> {
            let mut chain: Vec<(String, Info)> = Vec::new();
            let mut at = park_groups.get(key).copied();
            while let Some(g) = at {
                if chain.iter().any(|(k, _)| *k == g.id) {
                    break;
                }
                chain.insert(
                    0,
                    (
                        g.id.clone(),
                        Info {
                            name: g.name.clone(),
                            icon: g.icon.clone(),
                            color: g.color,
                        },
                    ),
                );
                at = g
                    .parent_id
                    .as_deref()
                    .and_then(|p| park_groups.get(p).copied());
            }
            chain
        };
        for p in &park.tabs {
            match &p.group_id {
                None => area.top.push(Node::Pin(info_of_parked(p))),
                Some(g) if park_groups.contains_key(g.as_str()) => {
                    area.enter(&park_chain(g));
                    area.inside
                        .entry(g.clone())
                        .or_default()
                        .push(Node::Pin(info_of_parked(p)));
                }
                Some(_) => {}
            }
        }
        for g in &park.groups {
            area.enter(&park_chain(&g.id));
        }
    }
    let sync = pin_sync(s, profile);
    let base_tab = |key: &str| base(&format!("{PIN_TAB}{key}"));
    let base_group = |key: &str| base(&format!("{PIN_GROUP}{key}"));
    let pin_value = |t: &PinInfo, group: Option<&str>, pos: &str| -> Value {
        let was = base_tab(&t.key);
        let was_g = was
            .as_ref()
            .and_then(|w| w.get("g"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let entry = was.as_ref().and(sync.get(&t.key));
        let waiting = group.is_none()
            && was_g.is_some()
            && entry.and_then(|e| e.get("g")).and_then(Value::as_str) == was_g.as_deref()
            && now
                < entry
                    .and_then(|e| e.get("w"))
                    .and_then(Value::as_f64)
                    .map_or(0, |w| w as i64);
        let url = match group {
            Some(_) => t.url.clone(),
            None => t
                .pinned_url
                .clone()
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| t.url.clone()),
        };
        let g = if waiting {
            was_g.map_or(Value::Null, Value::String)
        } else {
            group.map_or(Value::Null, |g| Value::String(g.to_owned()))
        };
        let pos = if waiting {
            was.as_ref()
                .and_then(|w| w.get("pos"))
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            Value::String(pos.to_owned())
        };
        json!({ "g": g, "u": url, "t": opt(&t.custom_title), "i": opt(&t.custom_icon), "ti": t.title, "pos": pos })
    };
    let mut values: IndexMap<String, Value> = IndexMap::new();
    fn nest(area: &Area, key: &str, values: &mut IndexMap<String, Value>) {
        for n in area.inside.get(key).into_iter().flatten() {
            let Node::Group(g) = n else { continue };
            let info = &area.info[g];
            values.insert(
                format!("{PIN_NEST_GROUP}{g}"),
                json!({ "n": info.name, "i": opt(&info.icon), "c": legacy_color(info.color), "p": key }),
            );
            nest(area, g, values);
        }
    }
    let legacy_rank = |n: &Node| match n {
        Node::Pin(p) => usize::from(is_row(p.pin.as_ref())),
        Node::Group(_) => 2,
    };
    area.top.sort_by_key(legacy_rank);
    let existing: Vec<Option<String>> =
        area.top
            .iter()
            .map(|n| match n {
                Node::Pin(p) => base_tab(&p.key)
                    .filter(|v| v.get("g").is_none_or(Value::is_null))
                    .and_then(|v| v.get("pos").and_then(Value::as_str).map(str::to_owned)),
                Node::Group(g) => base_group(g)
                    .and_then(|v| v.get("pos").and_then(Value::as_str).map(str::to_owned)),
            })
            .collect();
    let positions = assign_positions(&existing.iter().map(Option::as_deref).collect::<Vec<_>>());
    for (i, n) in area.top.iter().enumerate() {
        match n {
            Node::Pin(p) => {
                values.insert(
                    format!("{PIN_TAB}{}", p.key),
                    pin_value(p, None, &positions[i]),
                );
            }
            Node::Group(g) => {
                let info = &area.info[g];
                values.insert(
                    format!("{PIN_GROUP}{g}"),
                    json!({ "n": info.name, "i": opt(&info.icon), "c": legacy_color(info.color), "pos": positions[i] }),
                );
                let members = area.flat(g);
                let existing: Vec<Option<String>> = members
                    .iter()
                    .map(|(p, _)| {
                        base_tab(&p.key)
                            .filter(|v| v.get("g").and_then(Value::as_str) == Some(g.as_str()))
                            .and_then(|v| v.get("pos").and_then(Value::as_str).map(str::to_owned))
                    })
                    .collect();
                let member_positions =
                    assign_positions(&existing.iter().map(Option::as_deref).collect::<Vec<_>>());
                for (j, (p, inner)) in members.iter().enumerate() {
                    values.insert(
                        format!("{PIN_TAB}{}", p.key),
                        pin_value(p, Some(g), &member_positions[j]),
                    );
                    if inner != g {
                        values.insert(format!("{PIN_NEST_TAB}{}", p.key), json!({ "g": inner }));
                    }
                }
                nest(&area, g, &mut values);
            }
        }
    }
    values
}

fn choice_of(key: &str) -> Option<String> {
    if let Some(g) = key.strip_prefix(PIN_GROUP) {
        return Some(group_choice_key(g));
    }
    key.strip_prefix(PIN_TAB).map(place_choice_key)
}

pub fn extract_pinned(
    cycle: &CycleContext,
    profile: &ProfileId,
    cx: &ExtractContext,
) -> Extraction {
    let s = cycle.host.state();
    let values = pinned_values(&s, profile, &|k| cx.base(k), cx.now);
    let chosen = choices(&s, profile);
    let republished: HashSet<String> = cx
        .state()
        .records
        .keys()
        .chain(values.keys())
        .filter(|k| k.starts_with("pin:") && !cx.queued(k))
        .filter(|k| choice_of(k).is_some_and(|c| choice_still_out(&chosen, &c, cx.stamp(k))))
        .cloned()
        .collect();
    let settle = chosen;
    let cycle = cycle.clone();
    let profile = profile.clone();
    Extraction::of(values)
        .ignoring(|k| k.starts_with(PIN_ROW))
        .republishing(move |k| republished.contains(k))
        .on_published(move |keys| {
            let published: HashMap<String, String> = keys
                .iter()
                .filter(|k| k.starts_with("pin:"))
                .filter_map(|k| choice_of(k))
                .filter_map(|c| {
                    settle
                        .get(&c)
                        .and_then(Value::as_str)
                        .map(|v| (c, v.to_owned()))
                })
                .collect();
            settle_choices(&cycle, &profile, published);
        })
}
