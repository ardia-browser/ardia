use crate::ids::{ProfileId, RuleId};
use crate::macros::string_enum;
use crate::omnibox::url::display_host;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const DOCUMENT: &str = "air-traffic.json";
pub const VERSION: u64 = 2;
pub const MAX_RULES: usize = 100;
const MAX_LINK_TEXT: usize = 2048;

string_enum!(OpenAs { Tab = "tab", Window = "window", LittleArdia = "littleArdia" } default Tab);

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSource {
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceApp {
    pub bundle_id: Option<String>,
    pub name: String,
}

impl SourceApp {
    fn from_value(value: &Value) -> Option<SourceApp> {
        let fields = value.as_object()?;
        let name = fields.get("name")?.as_str()?.trim();
        if name.is_empty() {
            return None;
        }
        let bundle_id = match fields.get("bundleId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if !id.trim().is_empty() => Some(id.clone()),
            Some(_) => return None,
        };
        Some(SourceApp {
            bundle_id,
            name: name.to_owned(),
        })
    }

    fn matches(&self, source: &LinkSource) -> bool {
        let want = self
            .bundle_id
            .as_deref()
            .unwrap_or(&self.name)
            .to_lowercase();
        [source.bundle_id.as_deref(), source.app_name.as_deref()]
            .into_iter()
            .flatten()
            .any(|given| given.to_lowercase() == want)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkCondition {
    Any,
    Site(String),
    Pattern(String),
    Contains(String),
    Equals(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub profile_id: Option<ProfileId>,
    pub open: OpenAs,
    pub group_key: Option<String>,
}

impl Target {
    fn cleaned(self) -> Target {
        let keeps_group =
            self.group_key.is_some() && self.profile_id.is_some() && self.open == OpenAs::Tab;
        Target {
            group_key: self.group_key.filter(|_| keeps_group),
            ..self
        }
    }

    fn from_fields(fields: &Map<String, Value>) -> Option<Target> {
        let profile_id = match fields.get("profileId")? {
            Value::Null => None,
            Value::String(id) if !id.is_empty() => Some(ProfileId::new(id)),
            _ => return None,
        };
        let open = OpenAs::from_key(fields.get("open")?.as_str()?)?;
        let group_key = fields
            .get("groupKey")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Some(
            Target {
                profile_id,
                open,
                group_key,
            }
            .cleaned(),
        )
    }

    fn write(&self, out: &mut Map<String, Value>) {
        out.insert(
            "profileId".into(),
            self.profile_id
                .as_ref()
                .map_or(Value::Null, |p| Value::from(p.as_str())),
        );
        out.insert("open".into(), self.open.key().into());
        if let Some(group) = &self.group_key {
            out.insert("groupKey".into(), group.clone().into());
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub id: RuleId,
    pub enabled: bool,
    pub from: Option<SourceApp>,
    pub when: LinkCondition,
    pub target: Target,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AirTrafficConfig {
    pub rules: Vec<Rule>,
    pub fallback: Option<Target>,
    pub fallback_chosen: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoutedBy {
    Rule(RuleId),
    Fallback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub by: RoutedBy,
    pub target: Target,
}

pub fn site_host(input: &str) -> Option<String> {
    let mut text = input.trim().to_lowercase();
    if text.is_empty() {
        return None;
    }
    if text.contains("://") {
        text = url::Url::parse(&text).ok()?.host_str()?.to_owned();
    } else {
        text = text.split(['/', '?', '#']).next().unwrap_or("").to_owned();
    }
    let text = text
        .strip_prefix("*.")
        .unwrap_or(&text)
        .trim_end_matches('.');
    if text.is_empty() || text.contains(['*', '%', ' ', '@', ':']) {
        return None;
    }
    let host = url::Url::parse(&format!("http://{text}/"))
        .ok()?
        .host_str()?
        .to_owned();
    Some(host)
}

fn link_text(text: &str) -> String {
    let lower = text.trim().to_lowercase();
    let rest = match lower.find("://") {
        Some(at)
            if lower[..at]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
                && lower.starts_with(|c: char| c.is_ascii_alphabetic()) =>
        {
            lower[at + 3..].to_owned()
        }
        _ => lower,
    };
    rest.strip_prefix("www.").map(str::to_owned).unwrap_or(rest)
}

fn page_of(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("");
    let host = host.strip_prefix("www.").unwrap_or(host);
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{host}{port}{}", url.path())
        .to_lowercase()
        .trim_end_matches('/')
        .to_owned()
}

fn web_address(text: &str) -> Option<url::Url> {
    url::Url::parse(text).ok().filter(|u| {
        matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty())
    })
}

fn exact_address(text: &str) -> Option<String> {
    let raw = text.trim();
    if raw.contains(['?', '#']) {
        return None;
    }
    let schemed = raw.find("://").is_some_and(|at| {
        raw[..at]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let url = web_address(&if schemed {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    })?;
    (url.username().is_empty() && url.password().is_none()).then(|| page_of(&url))
}

pub fn link_text_problem(equals: bool, text: &str) -> Option<&'static str> {
    let t = link_text(text);
    if t.chars()
        .all(|c| c.is_whitespace() || "/?#.:;,&=".contains(c))
    {
        return Some("it matches every link; pick Any link for that");
    }
    if text.len() > MAX_LINK_TEXT {
        return Some("keep it under 2048 characters");
    }
    if equals && exact_address(text).is_none() {
        return Some(
            "type a web address like example.com/docs, without ? or # (http and https only)",
        );
    }
    None
}

pub fn glob_matches(glob: &str, text: &str) -> bool {
    let (g, t): (Vec<char>, Vec<char>) = (glob.chars().collect(), text.chars().collect());
    let (mut gi, mut ti, mut star, mut resume) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if gi < g.len() && g[gi] != '*' && g[gi] == t[ti] {
            gi += 1;
            ti += 1;
        } else if gi < g.len() && g[gi] == '*' {
            star = Some(gi);
            gi += 1;
            resume = ti;
        } else if let Some(s) = star {
            gi = s + 1;
            resume += 1;
            ti = resume;
        } else {
            return false;
        }
    }
    while gi < g.len() && g[gi] == '*' {
        gi += 1;
    }
    gi == g.len()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchSpec {
    all: bool,
    schemes: Vec<&'static str>,
    host: String,
    sub: bool,
    port: Option<String>,
    file: bool,
    path: String,
}

pub fn parse_match_pattern(pattern: &str) -> Result<MatchSpec, &'static str> {
    if pattern == "<all_urls>" {
        return Ok(MatchSpec {
            all: true,
            schemes: vec!["http", "https", "file", "ftp"],
            host: String::new(),
            sub: true,
            port: None,
            file: false,
            path: "/*".into(),
        });
    }
    if pattern.contains('\0') {
        return Err("contains a null character");
    }
    let (scheme, rest) = pattern
        .split_once("://")
        .ok_or("a match pattern is <all_urls> or scheme://host/path")?;
    let schemes = match scheme {
        "*" => vec!["http", "https"],
        "http" => vec!["http"],
        "https" => vec!["https"],
        "file" => vec!["file"],
        "ftp" => vec!["ftp"],
        _ => return Err("match patterns only match *, http, https, file, ftp URLs"),
    };
    if rest.is_empty() {
        return Err("the host is empty");
    }
    if scheme == "file" {
        let slash = rest.find('/').ok_or("add a path, like file:///*")?;
        let host = &rest[..slash];
        if !host.is_empty() && host != "localhost" {
            return Err("file patterns have no host (file:///path)");
        }
        return Ok(MatchSpec {
            all: false,
            schemes,
            host: String::new(),
            sub: false,
            port: None,
            file: true,
            path: rest[slash..].to_owned(),
        });
    }
    let end = rest.find('/').ok_or("add a path, like /*")?;
    if end == 0 {
        return Err("the host is empty");
    }
    let host_and_port = &rest[..end];
    let colon = if host_and_port.starts_with('[') {
        host_and_port
            .find(']')
            .and_then(|b| host_and_port[b..].find(':').map(|c| b + c))
    } else {
        host_and_port.find(':')
    };
    let (mut host, port) = match colon {
        Some(c) => (&host_and_port[..c], Some(&host_and_port[c + 1..])),
        None => (host_and_port, None),
    };
    let port = match port {
        None | Some("*") => None,
        Some(_) if scheme == "*" => return Err("a pattern with scheme * can't name a port"),
        Some(p) if !p.bytes().all(|b| b.is_ascii_digit()) || p.is_empty() => {
            return Err("the port is a number or *");
        }
        Some(p) if p.len() > 1 && p.starts_with('0') => {
            return Err("write the port without leading zeros");
        }
        Some(p) if p.parse::<u32>().map_or(true, |n| n > 65535) => {
            return Err("the port must be 0 to 65535");
        }
        Some(p) => Some(p.to_owned()),
    };
    if host.is_empty() {
        return Err("the host is empty");
    }
    let mut sub = false;
    if host == "*" {
        sub = true;
        host = "";
    } else if let Some(rest) = host.strip_prefix("*.") {
        if rest.is_empty() {
            return Err("the host is empty");
        }
        sub = true;
        host = rest;
    }
    if host.contains('*') {
        return Err("* only works as the whole host or a *. prefix");
    }
    if host.contains('%') {
        return Err("hosts can't have %");
    }
    let host = if host.is_empty() || host.starts_with('[') {
        host.to_lowercase()
    } else {
        url::Url::parse(&format!("http://{host}/"))
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .ok_or("the host has characters a hostname can't have")?
    };
    Ok(MatchSpec {
        all: false,
        schemes,
        host,
        sub,
        port,
        file: false,
        path: rest[end..].to_owned(),
    })
}

fn is_ip(host: &str) -> bool {
    host.starts_with('[') || crate::omnibox::url::is_ipv4(host)
}

pub fn matches_url(spec: &MatchSpec, href: &str) -> bool {
    let Ok(url) = url::Url::parse(href) else {
        return false;
    };
    if !spec.schemes.contains(&url.scheme()) {
        return false;
    }
    if spec.all {
        return true;
    }
    if !spec.file {
        let host = url
            .host_str()
            .unwrap_or("")
            .trim_end_matches('.')
            .to_lowercase();
        let pattern = spec.host.trim_end_matches('.');
        let host_ok = host == pattern
            || (spec.sub && pattern.is_empty())
            || (spec.sub
                && !is_ip(&host)
                && host.len() > pattern.len() + 1
                && host.ends_with(&format!(".{pattern}")));
        if !host_ok {
            return false;
        }
    }
    if let Some(port) = &spec.port
        && url
            .port_or_known_default()
            .map(|p| p.to_string())
            .as_deref()
            != Some(port.as_str())
    {
        return false;
    }
    let path = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    if spec.path == format!("{path}/*") {
        return true;
    }
    let decoded = decode_uri(&path).unwrap_or_else(|| path.clone());
    glob_matches(&spec.path, &path) || glob_matches(&spec.path, &decoded)
}

const URI_RESERVED: &[u8] = b";/?:@&=+$,#";

fn hex_byte(bytes: &[u8], at: usize) -> Option<u8> {
    if bytes.get(at) != Some(&b'%') {
        return None;
    }
    let digit = |b: u8| (b as char).to_digit(16);
    Some((digit(*bytes.get(at + 1)?)? * 16 + digit(*bytes.get(at + 2)?)?) as u8)
}

pub fn decode_uri(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'%' {
            out.push(bytes[at]);
            at += 1;
            continue;
        }
        let lead = hex_byte(bytes, at)?;
        if lead < 0x80 {
            if URI_RESERVED.contains(&lead) {
                out.extend_from_slice(&bytes[at..at + 3]);
            } else {
                out.push(lead);
            }
            at += 3;
            continue;
        }
        let width = match lead {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut sequence = vec![lead];
        for k in 1..width {
            let next = hex_byte(bytes, at + 3 * k)?;
            if next & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(next);
        }
        out.extend_from_slice(std::str::from_utf8(&sequence).ok()?.as_bytes());
        at += 3 * width;
    }
    String::from_utf8(out).ok()
}

pub fn is_wildcard_pattern(pattern: &str) -> bool {
    pattern != "<all_urls>" && !pattern.contains("://")
}

pub fn pattern_problem(pattern: &str) -> Option<&'static str> {
    let text = pattern.trim();
    if text.is_empty() {
        return Some("type one, like *github* or https://*.example.com/docs/*");
    }
    if is_wildcard_pattern(text) {
        return text
            .contains(char::is_whitespace)
            .then_some("a pattern can't have spaces");
    }
    parse_match_pattern(text).err()
}

fn wildcard_matches(pattern: &str, href: &str) -> bool {
    let Ok(url) = url::Url::parse(href) else {
        return false;
    };
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return false;
    };
    let lower = pattern.to_lowercase();
    let glob = if lower.contains('*') {
        lower
    } else {
        format!("*{lower}*")
    };
    let rest = if glob.contains('/') {
        format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        )
        .to_lowercase()
    } else {
        String::new()
    };
    let shown = display_host(host);
    [host.to_owned(), shown]
        .iter()
        .any(|h| glob_matches(&glob, &format!("{h}{rest}")))
}

impl LinkCondition {
    pub fn matches(&self, href: &str) -> bool {
        match self {
            LinkCondition::Any => true,
            LinkCondition::Contains(text) => link_text(href).contains(&link_text(text)),
            LinkCondition::Equals(text) => {
                web_address(href).is_some_and(|u| Some(page_of(&u)) == exact_address(text))
            }
            LinkCondition::Pattern(pattern) if is_wildcard_pattern(pattern) => {
                wildcard_matches(pattern, href)
            }
            LinkCondition::Pattern(pattern) => {
                parse_match_pattern(pattern).is_ok_and(|spec| matches_url(&spec, href))
            }
            LinkCondition::Site(host) => parse_match_pattern(&format!("*://*.{host}/*"))
                .is_ok_and(|spec| matches_url(&spec, href)),
        }
    }

    fn from_value(value: &Value) -> Option<LinkCondition> {
        let fields = value.as_object()?;
        let text = |key: &str| fields.get(key).and_then(Value::as_str).map(str::to_owned);
        match fields.get("kind")?.as_str()? {
            "any" => Some(LinkCondition::Any),
            "site" => text("host")
                .filter(|h| site_host(h).as_deref() == Some(h.as_str()))
                .map(LinkCondition::Site),
            "pattern" => text("pattern")
                .filter(|p| pattern_problem(p).is_none())
                .map(LinkCondition::Pattern),
            "contains" => text("text")
                .filter(|t| link_text_problem(false, t).is_none())
                .map(LinkCondition::Contains),
            "equals" => text("text")
                .filter(|t| link_text_problem(true, t).is_none())
                .map(LinkCondition::Equals),
            _ => None,
        }
    }

    fn to_value(&self) -> Value {
        match self {
            LinkCondition::Any => json!({"kind": "any"}),
            LinkCondition::Site(host) => json!({"kind": "site", "host": host}),
            LinkCondition::Pattern(pattern) => json!({"kind": "pattern", "pattern": pattern}),
            LinkCondition::Contains(text) => json!({"kind": "contains", "text": text}),
            LinkCondition::Equals(text) => json!({"kind": "equals", "text": text}),
        }
    }
}

impl Rule {
    fn from_value(value: &Value) -> Option<Rule> {
        let fields = value.as_object()?;
        let id = fields.get("id")?.as_str().filter(|id| !id.is_empty())?;
        let enabled = fields.get("enabled")?.as_bool()?;
        let from = match fields.get("from") {
            Some(Value::Null) => None,
            Some(app) => Some(SourceApp::from_value(app)?),
            None => return None,
        };
        Some(Rule {
            id: RuleId::new(id),
            enabled,
            from,
            when: LinkCondition::from_value(fields.get("when")?)?,
            target: Target::from_fields(fields)?,
        })
    }

    fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), self.id.as_str().into());
        out.insert("enabled".into(), self.enabled.into());
        out.insert(
            "from".into(),
            serde_json::to_value(&self.from).unwrap_or(Value::Null),
        );
        out.insert("when".into(), self.when.to_value());
        self.target.write(&mut out);
        Value::Object(out)
    }
}

impl AirTrafficConfig {
    pub fn from_value(doc: &Value) -> AirTrafficConfig {
        let mut seen = std::collections::HashSet::new();
        let rules = doc
            .get("rules")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Rule::from_value)
                    .filter(|r| seen.insert(r.id.clone()))
                    .take(MAX_RULES)
                    .collect()
            })
            .unwrap_or_default();
        let fallback = doc
            .get("fallback")
            .and_then(Value::as_object)
            .and_then(Target::from_fields);
        AirTrafficConfig {
            rules,
            fallback,
            fallback_chosen: doc.get("fallbackChosen") == Some(&Value::Bool(true)),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "rules".into(),
            Value::Array(self.rules.iter().map(Rule::to_value).collect()),
        );
        out.insert(
            "fallback".into(),
            self.fallback.as_ref().map_or(Value::Null, |t| {
                let mut target = Map::new();
                t.write(&mut target);
                Value::Object(target)
            }),
        );
        if self.fallback_chosen {
            out.insert("fallbackChosen".into(), true.into());
        }
        out.insert("version".into(), VERSION.into());
        Value::Object(out)
    }

    pub fn holds_links(&self) -> bool {
        self.fallback.is_some() || self.rules.iter().any(|r| r.enabled)
    }

    pub fn route(
        &self,
        href: &str,
        source: &LinkSource,
        usable: impl Fn(&ProfileId, Option<&str>) -> bool,
    ) -> Option<Route> {
        let target_usable = |t: &Target| t.profile_id.as_ref().is_none_or(|p| usable(p, None));
        let resolved = |t: &Target| Target {
            group_key: t
                .group_key
                .clone()
                .filter(|g| t.profile_id.as_ref().is_some_and(|p| usable(p, Some(g)))),
            ..t.clone()
        };
        let rule = self.rules.iter().find(|r| {
            r.enabled
                && r.from.as_ref().is_none_or(|app| app.matches(source))
                && r.when.matches(href)
                && target_usable(&r.target)
        });
        if let Some(rule) = rule {
            return Some(Route {
                by: RoutedBy::Rule(rule.id.clone()),
                target: resolved(&rule.target),
            });
        }
        self.fallback
            .as_ref()
            .filter(|t| target_usable(t))
            .map(|t| Route {
                by: RoutedBy::Fallback,
                target: resolved(t),
            })
    }

    pub fn add(&mut self, rule: Rule) -> Result<(), &'static str> {
        if self.rules.len() >= MAX_RULES {
            return Err("full");
        }
        if self.rules.iter().any(|r| r.id == rule.id) {
            return Err("exists");
        }
        self.rules.push(Rule {
            target: rule.target.clone().cleaned(),
            ..rule
        });
        Ok(())
    }

    pub fn place(&mut self, id: &str, index: usize) -> bool {
        let Some(from) = self.rules.iter().position(|r| r.id == id) else {
            return false;
        };
        let to = index.min(self.rules.len() - 1);
        if from == to {
            return false;
        }
        let rule = self.rules.remove(from);
        self.rules.insert(to, rule);
        true
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.rules.len();
        self.rules.retain(|r| r.id != id);
        before != self.rules.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usable(p: &ProfileId, group: Option<&str>) -> bool {
        p.as_str() != "gone" && group.is_none_or(|g| g == "g-live")
    }

    fn slack() -> LinkSource {
        LinkSource {
            bundle_id: Some("com.tinyspeck.slackmacgap".into()),
            app_name: Some("Slack".into()),
        }
    }

    fn doc() -> Value {
        json!({
            "version": 2,
            "rules": [
                {"id": "r1", "enabled": true, "from": {"bundleId": "com.tinyspeck.slackmacgap", "name": "Slack"}, "when": {"kind": "site", "host": "github.com"}, "profileId": "work", "open": "tab", "groupKey": "g-live"},
                {"id": "r2", "enabled": false, "from": null, "when": {"kind": "any"}, "profileId": "personal", "open": "window"},
                {"id": "r3", "enabled": true, "from": null, "when": {"kind": "pattern", "pattern": "*figma*"}, "profileId": "gone", "open": "tab"},
                {"id": "r4", "enabled": true, "from": null, "when": {"kind": "pattern", "pattern": "https://*.example.com/docs/*"}, "profileId": null, "open": "littleArdia"},
                {"id": "r1", "enabled": true, "from": null, "when": {"kind": "any"}, "profileId": "dupe", "open": "tab"},
                {"id": "bad", "enabled": true, "from": null, "when": {"kind": "contains", "text": "/"}, "profileId": "x", "open": "tab"},
                {"id": "r5", "enabled": true, "from": null, "when": {"kind": "equals", "text": "news.ycombinator.com/item"}, "profileId": "reading", "open": "window", "groupKey": "dropped"}
            ],
            "fallback": {"profileId": "personal", "open": "littleArdia"},
            "fallbackChosen": true
        })
    }

    #[test]
    fn config_parses_validates_and_round_trips() {
        let config = AirTrafficConfig::from_value(&doc());
        assert_eq!(
            config
                .rules
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            vec!["r1", "r2", "r3", "r4", "r5"]
        );
        assert_eq!(config.rules[4].target.group_key, None);
        assert!(config.fallback_chosen && config.holds_links());
        assert_eq!(AirTrafficConfig::from_value(&config.to_value()), config);
        assert_eq!(
            AirTrafficConfig::from_value(&json!(null)),
            AirTrafficConfig::default()
        );
    }

    #[test]
    fn rules_route_by_app_site_pattern_and_exact_page() {
        let config = AirTrafficConfig::from_value(&doc());
        let route = config
            .route("https://docs.github.com/x", &slack(), usable)
            .unwrap();
        assert_eq!(route.by, RoutedBy::Rule(RuleId::new("r1")));
        assert_eq!(route.target.group_key.as_deref(), Some("g-live"));
        let mail = LinkSource {
            bundle_id: Some("com.apple.mail".into()),
            app_name: Some("Mail".into()),
        };
        assert_eq!(
            config
                .route("https://github.com/", &mail, usable)
                .unwrap()
                .by,
            RoutedBy::Fallback
        );
        assert_eq!(
            config
                .route("https://www.figma.com/file/x", &mail, usable)
                .unwrap()
                .by,
            RoutedBy::Fallback
        );
        let docs = config
            .route("https://api.example.com/docs/v1", &mail, usable)
            .unwrap();
        assert_eq!(
            (docs.by, docs.target.open),
            (RoutedBy::Rule(RuleId::new("r4")), OpenAs::LittleArdia)
        );
        assert_eq!(
            config
                .route("https://news.ycombinator.com/item/?id=1", &mail, usable)
                .unwrap()
                .by,
            RoutedBy::Rule(RuleId::new("r5"))
        );
        assert_eq!(
            config
                .route("https://news.ycombinator.com/items", &mail, usable)
                .unwrap()
                .by,
            RoutedBy::Fallback
        );
        assert_eq!(
            AirTrafficConfig::default().route("https://x", &mail, usable),
            None
        );
    }

    #[test]
    fn site_rules_take_subdomains_but_not_lookalikes() {
        let site = LinkCondition::Site("github.com".into());
        assert!(
            site.matches("https://github.com/x")
                && site.matches("http://gist.github.com/")
                && !site.matches("https://evilgithub.com/")
                && !site.matches("ftp://github.com/")
        );
        assert_eq!(
            site_host("https://WWW.GitHub.com/path"),
            Some("www.github.com".into())
        );
        assert_eq!(site_host("*.example.com/x"), Some("example.com".into()));
        assert_eq!(site_host("bad host"), None);
        assert_eq!(site_host(""), None);
    }

    #[test]
    fn decoding_keeps_reserved_escapes_like_decode_uri() {
        assert_eq!(decode_uri("/a%2Fb").as_deref(), Some("/a%2Fb"));
        assert_eq!(decode_uri("/caf%C3%A9%20x").as_deref(), Some("/café x"));
        assert_eq!(decode_uri("/%3F%23%26").as_deref(), Some("/%3F%23%26"));
        assert_eq!(decode_uri("/bad%E0%A4%A"), None);
        assert_eq!(decode_uri("/lone%C3"), None);
        assert_eq!(decode_uri("/surrogate%ED%A0%80"), None);
        assert_eq!(decode_uri("/%zz"), None);
        let spec = parse_match_pattern("https://example.com/a/b").unwrap();
        assert!(!matches_url(&spec, "https://example.com/a%2Fb"));
        let spaced = parse_match_pattern("https://example.com/a b").unwrap();
        assert!(matches_url(&spaced, "https://example.com/a%20b"));
    }

    #[test]
    fn match_patterns_follow_userscript_rules() {
        assert!(parse_match_pattern("<all_urls>").is_ok());
        assert!(parse_match_pattern("*://*/*").is_ok());
        assert_eq!(
            parse_match_pattern("https://*.ex*ample.com/*"),
            Err("* only works as the whole host or a *. prefix")
        );
        assert_eq!(
            parse_match_pattern("*://x.com:80/*"),
            Err("a pattern with scheme * can't name a port")
        );
        assert_eq!(
            parse_match_pattern("https://x.com:080/*"),
            Err("write the port without leading zeros")
        );
        assert_eq!(
            parse_match_pattern("chrome://x/*"),
            Err("match patterns only match *, http, https, file, ftp URLs")
        );
        assert_eq!(
            parse_match_pattern("https://x.com"),
            Err("add a path, like /*")
        );
        let spec = parse_match_pattern("https://x.com:8443/a/*").unwrap();
        assert!(matches_url(&spec, "https://x.com:8443/a/b?c"));
        assert!(!matches_url(&spec, "https://x.com/a/b"));
        let file = parse_match_pattern("file:///Users/*").unwrap();
        assert!(matches_url(&file, "file:///Users/me/a.txt"));
        assert!(
            glob_matches("*a*b", "xxaxxb") && !glob_matches("a*", "ba") && glob_matches("*", "")
        );
        assert_eq!(
            pattern_problem("git hub"),
            Some("a pattern can't have spaces")
        );
        assert_eq!(
            pattern_problem(" "),
            Some("type one, like *github* or https://*.example.com/docs/*")
        );
    }

    #[test]
    fn rule_lists_are_bounded_and_reorderable() {
        let mut config = AirTrafficConfig::default();
        for i in 0..MAX_RULES {
            config
                .add(Rule {
                    id: RuleId::new(format!("r{i}")),
                    enabled: true,
                    from: None,
                    when: LinkCondition::Any,
                    target: Target {
                        profile_id: None,
                        open: OpenAs::Tab,
                        group_key: None,
                    },
                })
                .unwrap();
        }
        let extra = Rule {
            id: RuleId::new("x"),
            enabled: true,
            from: None,
            when: LinkCondition::Any,
            target: Target {
                profile_id: None,
                open: OpenAs::Tab,
                group_key: None,
            },
        };
        assert_eq!(config.add(extra), Err("full"));
        assert!(config.place("r99", 0));
        assert_eq!(config.rules[0].id.as_str(), "r99");
        assert!(config.remove("r99"));
        assert!(!config.remove("r99"));
    }
}
