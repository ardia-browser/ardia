use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use objc2::rc::Retained;
use objc2_foundation::{
    NSMatchingOptions, NSNotFound, NSRange, NSRegularExpression, NSRegularExpressionOptions,
    NSString,
};
use serde_json::Value;

use super::inflate;

pub struct Regex(Retained<NSRegularExpression>);

thread_local! {
    static USER_PART: std::cell::RefCell<CosmeticPart> = std::cell::RefCell::new(CosmeticPart::default());
}

pub fn set_user_part(hide: HashMap<String, Vec<String>>, unhide: HashMap<String, Vec<String>>) {
    USER_PART.with(|user| {
        *user.borrow_mut() = CosmeticPart {
            hide,
            unhide,
            patterns: Vec::new(),
        };
    });
}

pub fn has_user_hides() -> bool {
    USER_PART.with(|user| !user.borrow().hide.is_empty())
}

impl Regex {
    pub fn new(source: &str, case_sensitive: bool) -> Option<Regex> {
        let options = if case_sensitive {
            NSRegularExpressionOptions::empty()
        } else {
            NSRegularExpressionOptions::CaseInsensitive
        };
        NSRegularExpression::regularExpressionWithPattern_options_error(
            &NSString::from_str(source),
            options,
        )
        .ok()
        .map(Regex)
    }

    pub fn is_match(&self, text: &str) -> bool {
        let text = NSString::from_str(text);
        let range = NSRange::new(0, text.length());
        let found = self.0.rangeOfFirstMatchInString_options_range(
            &text,
            NSMatchingOptions::empty(),
            range,
        );
        found.location != NSNotFound as usize
    }
}

pub struct HostList {
    bytes: Vec<u8>,
    starts: Vec<usize>,
}

impl HostList {
    pub fn new(bytes: Vec<u8>) -> HostList {
        let mut starts = if bytes.is_empty() {
            Vec::new()
        } else {
            vec![0]
        };
        starts.extend(
            bytes
                .iter()
                .enumerate()
                .filter(|(_, b)| **b == b'\n')
                .map(|(i, _)| i + 1),
        );
        HostList { bytes, starts }
    }

    pub fn len(&self) -> usize {
        self.starts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.starts.is_empty()
    }

    fn entry(&self, index: usize) -> &[u8] {
        let start = self.starts[index];
        let end = self
            .starts
            .get(index + 1)
            .map_or(self.bytes.len(), |next| next - 1);
        &self.bytes[start.min(end)..end]
    }

    pub fn contains(&self, host: &[u8]) -> bool {
        let (mut low, mut high) = (0, self.starts.len());
        while low < high {
            let mid = (low + high) / 2;
            match self.entry(mid).cmp(host) {
                std::cmp::Ordering::Equal => return true,
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid,
            }
        }
        false
    }
}

pub fn covered(host: &str, names: &HashSet<String>) -> bool {
    let mut rest = host;
    loop {
        if names.contains(rest) {
            return true;
        }
        match rest.find('.') {
            Some(dot) => rest = &rest[dot + 1..],
            None => return false,
        }
    }
}

pub struct StrictRule {
    block: bool,
    priority: i64,
    pattern: Option<Regex>,
    hosts: HashSet<String>,
    excluded_hosts: HashSet<String>,
    initiators: HashSet<String>,
    excluded_initiators: HashSet<String>,
}

fn names(entry: &Value, key: &str) -> HashSet<String> {
    entry
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

impl StrictRule {
    pub fn parse(entry: &Value) -> Option<StrictRule> {
        let pattern = match entry.get("re").and_then(Value::as_str) {
            Some(source) => Some(Regex::new(
                source,
                entry.get("cs").and_then(Value::as_bool) == Some(true),
            )?),
            None => None,
        };
        Some(StrictRule {
            block: entry.get("k").and_then(Value::as_str) == Some("block"),
            priority: entry.get("p").and_then(Value::as_i64).unwrap_or(1),
            pattern,
            hosts: names(entry, "d"),
            excluded_hosts: names(entry, "xd"),
            initiators: names(entry, "i"),
            excluded_initiators: names(entry, "xi"),
        })
    }

    fn matches(&self, url: &str, host: &str, initiator: Option<&str>) -> bool {
        if !self.hosts.is_empty() && !covered(host, &self.hosts) {
            return false;
        }
        if !self.excluded_hosts.is_empty() && covered(host, &self.excluded_hosts) {
            return false;
        }
        if !self.initiators.is_empty() && !initiator.is_some_and(|i| covered(i, &self.initiators)) {
            return false;
        }
        if !self.excluded_initiators.is_empty()
            && initiator.is_some_and(|i| covered(i, &self.excluded_initiators))
        {
            return false;
        }
        self.pattern.as_ref().is_none_or(|p| p.is_match(url))
    }
}

#[derive(Default)]
pub struct StrictBlock {
    pub host_lists: Vec<HostList>,
    pub rules: Vec<StrictRule>,
}

impl StrictBlock {
    pub fn load(rulesets: &[String], directory: &Path) -> StrictBlock {
        let mut host_lists = Vec::new();
        let mut rules = Vec::new();
        for id in rulesets {
            if let Some(hosts) = inflate_bytes(&directory.join(format!("{id}.hosts")))
                && !hosts.is_empty()
            {
                host_lists.push(HostList::new(hosts));
            }
            if let Some(raw) = inflate(&directory.join(format!("{id}.strict")))
                && let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&raw)
            {
                rules.extend(entries.iter().filter_map(StrictRule::parse));
            }
        }
        rules.sort_by_key(|rule| std::cmp::Reverse(rule.priority));
        StrictBlock { host_lists, rules }
    }

    pub fn host_count(&self) -> usize {
        self.host_lists.iter().map(HostList::len).sum()
    }

    pub fn blocks(&self, url: &str, initiator: Option<&str>) -> bool {
        let Ok(parsed) = url::Url::parse(url) else {
            return false;
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return false;
        }
        let Some(host) = parsed
            .host_str()
            .map(str::to_lowercase)
            .filter(|h| !h.is_empty())
        else {
            return false;
        };
        let mut block: Option<i64> = None;
        let mut allow: Option<i64> = None;
        for rule in &self.rules {
            let taken = if rule.block {
                block.is_some()
            } else {
                allow.is_some()
            };
            if taken || !rule.matches(url, &host, initiator) {
                continue;
            }
            if rule.block {
                block = Some(rule.priority);
            } else {
                allow = Some(rule.priority);
            }
            if block.is_some() && allow.is_some() {
                break;
            }
        }
        if let Some(block) = block {
            return allow.is_none_or(|allow| allow < block);
        }
        if allow.is_some() {
            return false;
        }
        let mut rest = host.as_str();
        loop {
            if self
                .host_lists
                .iter()
                .any(|list| list.contains(rest.as_bytes()))
            {
                return true;
            }
            match rest.find('.') {
                Some(dot) => rest = &rest[dot + 1..],
                None => return false,
            }
        }
    }
}

pub fn inflate_bytes(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let data = std::fs::read(path).ok()?;
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(&data[..])
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

pub struct HostPattern {
    needle: String,
    pattern: Regex,
    selectors: Vec<String>,
}

#[derive(Default)]
pub struct CosmeticPart {
    pub hide: HashMap<String, Vec<String>>,
    pub unhide: HashMap<String, Vec<String>>,
    pub patterns: Vec<HostPattern>,
}

fn selector_map(value: Option<&Value>) -> HashMap<String, Vec<String>> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(host, list)| {
                    let list = list.as_array()?;
                    Some((
                        host.clone(),
                        list.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

impl CosmeticPart {
    pub fn parse(object: &Value) -> CosmeticPart {
        let patterns = object
            .get("regexes")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let entry = entry.as_array().filter(|e| e.len() == 3)?;
                        let needle = entry[0].as_str()?.to_owned();
                        let pattern = Regex::new(entry[1].as_str()?, true)?;
                        let selectors = entry[2]
                            .as_array()?
                            .iter()
                            .map(|s| s.as_str().map(str::to_owned))
                            .collect::<Option<Vec<_>>>()?;
                        Some(HostPattern {
                            needle,
                            pattern,
                            selectors,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        CosmeticPart {
            hide: selector_map(object.get("hide")),
            unhide: selector_map(object.get("unhide")),
            patterns,
        }
    }
}

#[derive(Default)]
pub struct CosmeticIndex {
    pub parts: Vec<CosmeticPart>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Found {
    pub css: Vec<String>,
    pub procedural: Vec<String>,
}

impl CosmeticIndex {
    pub fn load(rulesets: &[String], directory: &Path) -> CosmeticIndex {
        let parts = rulesets
            .iter()
            .filter_map(|id| inflate(&directory.join(format!("{id}.cosmetic"))))
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(Value::is_object)
            .map(|object| CosmeticPart::parse(&object))
            .collect();
        CosmeticIndex { parts }
    }

    pub fn selector_count(&self) -> usize {
        self.parts
            .iter()
            .map(|part| {
                part.hide.values().map(Vec::len).sum::<usize>()
                    + part
                        .patterns
                        .iter()
                        .map(|p| p.selectors.len())
                        .sum::<usize>()
            })
            .sum()
    }

    pub fn lookup(&self, hostnames: &[String], entities: &[String]) -> Found {
        let mut chosen: BTreeSet<String> = BTreeSet::new();
        let mut excepted: HashSet<String> = HashSet::new();
        let hostname = hostnames.first().map(String::as_str).unwrap_or_default();
        let mut visit = |part: &CosmeticPart| {
            for needle in hostnames.iter().chain(entities) {
                if let Some(hide) = part.hide.get(needle) {
                    chosen.extend(hide.iter().cloned());
                }
                if let Some(unhide) = part.unhide.get(needle) {
                    excepted.extend(unhide.iter().cloned());
                }
            }
            for pattern in &part.patterns {
                if hostname.contains(&pattern.needle) && pattern.pattern.is_match(hostname) {
                    chosen.extend(pattern.selectors.iter().cloned());
                }
            }
        };
        for part in &self.parts {
            visit(part);
        }
        USER_PART.with(|user| visit(&user.borrow()));
        let mut found = Found::default();
        for selector in chosen.iter().map(String::as_str).filter(|s| !excepted.contains(*s)) {
            if selector.starts_with('{') {
                found.procedural.push(selector.to_owned());
            } else {
                found.css.push(selector.to_owned());
            }
        }
        found
    }
}

pub const GATE_PLACEHOLDER: &str = "/*ardia-content-blocker-gate*/";
pub const HANDLER_NAME: &str = "ardiaContentBlocker";
pub const WORLD_NAME: &str = "ArdiaContentBlocker";

#[derive(Clone, Default)]
pub struct ScriptletSources {
    pub main: String,
    pub isolated: String,
    pub secret: String,
    pub procedural: String,
}

impl ScriptletSources {
    pub fn load(
        rulesets: &[String],
        worlds: &HashMap<String, Vec<String>>,
        secret: &str,
        directory: &Path,
    ) -> Option<ScriptletSources> {
        if secret.is_empty() {
            return None;
        }
        let file = |path: &str| inflate(&directory.join(path));
        let bundle = |world: &str| {
            let files: Vec<String> = rulesets
                .iter()
                .filter(|id| {
                    worlds
                        .get(*id)
                        .is_some_and(|w| w.iter().any(|x| x == world))
                })
                .filter_map(|id| file(&format!("scriptlets/{world}/{id}.js")))
                .collect();
            let (Some(begin), Some(end)) = (
                file(&format!("scriptlets/{world}/scriptlet-begin.js")),
                file(&format!("scriptlets/{world}/scriptlet-end.js")),
            ) else {
                return String::new();
            };
            if files.is_empty() {
                return String::new();
            }
            let mut parts = vec![begin, GATE_PLACEHOLDER.to_owned()];
            parts.extend(files);
            parts.push(end);
            parts.join("\n")
        };
        Some(ScriptletSources {
            main: bundle("main"),
            isolated: bundle("isolated"),
            secret: secret.to_owned(),
            procedural: file("scripting/css-procedural-api.js").unwrap_or_default(),
        })
    }
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

pub fn trusted_check(trusted: &[String]) -> String {
    format!(
        "((t) => {{ let h = ''; try {{ const a = location.ancestorOrigins; h = new URL(a && a.length ? a[a.length - 1] : location.href).hostname; }} catch (e) {{ h = location.hostname; }} return !!h && t.some((d) => h === d || h.endsWith('.' + d)); }})({})",
        json_string(&Value::from(trusted.to_vec()))
    )
}

pub struct MadeScripts {
    pub main: Option<String>,
    pub isolated: Option<String>,
}

pub fn make_scripts(sources: &ScriptletSources, trusted: &[String], cosmetic: bool) -> MadeScripts {
    let gate = format!(
        "(function (id) {{ const g = self[id]; if (g && {}) g.origins = []; }})({});",
        trusted_check(trusted),
        json_string(&Value::from(sources.secret.clone()))
    );
    let main = (!sources.main.is_empty()).then(|| sources.main.replace(GATE_PLACEHOLDER, &gate));
    let mut isolated = sources.isolated.replace(GATE_PLACEHOLDER, &gate);
    if cosmetic && !sources.procedural.is_empty() {
        isolated.push('\n');
        isolated.push_str(&sources.procedural);
        isolated.push('\n');
        isolated.push_str(&cosmetic_script(trusted));
    }
    MadeScripts {
        main,
        isolated: (!isolated.is_empty()).then_some(isolated),
    }
}

pub fn cosmetic_script(trusted: &[String]) -> String {
    let handler = json_string(&Value::from(HANDLER_NAME));
    let check = trusted_check(trusted);
    format!(
        r#"(() => {{
  const handler = self.webkit && self.webkit.messageHandlers && self.webkit.messageHandlers[{handler}];
  const hn = document.location.hostname;
  if (!handler || !hn || {check}) return;
  const hostnames = [hn];
  for (let pos = 0; ; ) {{ pos = hn.indexOf('.', pos) + 1; if (pos === 0) break; hostnames.push(hn.slice(pos)); }}
  hostnames.push('*');
  const entities = [];
  for (let h of hostnames) {{ for (;;) {{ const p = h.lastIndexOf('.'); if (p === -1) break; h = h.slice(0, p); entities.push(h + '.*'); }} }}
  const insert = (css) => {{
    const sheet = document.createElement('style');
    sheet.textContent = css;
    (document.head || document.documentElement).append(sheet);
  }};
  self.cssAPI = {{ insert }};
  handler.postMessage({{ hostnames, entities }}).then((reply) => {{
    if (!reply) return;
    if (reply.css && reply.css.length) insert(reply.css.map((s) => s + '\n{{display:none!important;}}').join('\n'));
    const all = (reply.procedural || []).map((s) => {{ try {{ return JSON.parse(s); }} catch (e) {{ return null; }} }}).filter(Boolean);
    if (!all.length || typeof self.ProceduralFiltererAPI !== 'function') return;
    const api = new self.ProceduralFiltererAPI();
    const declarative = (a) => a.cssable || (!a.tasks && a.action && a.action[0] === 'style');
    const declaratives = all.filter(declarative);
    if (declaratives.length) api.addDeclaratives(declaratives);
    const procedurals = all.filter((a) => !declarative(a));
    if (procedurals.length) api.addProcedurals(procedurals);
  }}, () => {{}});
}})();"#
    )
}

pub struct Extras {
    pub rulesets: Vec<String>,
    pub strict: StrictBlock,
    pub index: std::sync::Arc<CosmeticIndex>,
    pub sources: Option<ScriptletSources>,
    pub load_ms: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_lists_search_sorted_lines() {
        let list = HostList::new(b"a.com\nads.example\nzz.net".to_vec());
        assert_eq!(list.len(), 3);
        assert!(list.contains(b"ads.example"));
        assert!(!list.contains(b"ads.exampl"));
        assert!(!list.contains(b"b.com"));
        assert!(!HostList::new(Vec::new()).contains(b""));
    }

    #[test]
    fn strict_rules_weigh_priority_and_fall_back_to_hosts() {
        let block = StrictBlock {
            host_lists: vec![HostList::new(b"tracker.com".to_vec())],
            rules: vec![
                StrictRule::parse(&json!({"k": "allow", "p": 5, "d": ["ok.tracker.com"]})).unwrap(),
                StrictRule::parse(&json!({"k": "block", "p": 3, "re": "^https://evil\\."}))
                    .unwrap(),
            ],
        };
        assert!(block.blocks("https://a.tracker.com/x", None));
        assert!(!block.blocks("https://ok.tracker.com/x", None));
        assert!(block.blocks("https://EVIL.org/", None));
        assert!(!block.blocks("https://fine.org/", None));
        assert!(!block.blocks("ftp://tracker.com/", None));
        assert!(StrictRule::parse(&json!({"re": "(("})).is_none());
    }

    #[test]
    fn cosmetic_lookup_hides_minus_unhides() {
        let part = CosmeticPart::parse(&json!({
            "hide": {"example.com": [".ad", "{\"p\":1}"], "*": [".banner"]},
            "unhide": {"www.example.com": [".banner"]},
            "regexes": [["exam", "^www\\.exam", [".rx"]]]
        }));
        let index = CosmeticIndex { parts: vec![part] };
        assert_eq!(index.selector_count(), 4);
        let found = index.lookup(
            &["www.example.com".into(), "example.com".into(), "*".into()],
            &["www.example.*".into(), "example.*".into()],
        );
        assert_eq!(found.css, vec![".ad", ".rx"]);
        assert_eq!(found.procedural, vec!["{\"p\":1}"]);
    }

    #[test]
    fn scripts_gate_trusted_hosts() {
        let sources = ScriptletSources {
            main: format!("begin\n{GATE_PLACEHOLDER}\nend"),
            isolated: String::new(),
            secret: "s".into(),
            procedural: "api".into(),
        };
        let made = make_scripts(&sources, &["a.com".into()], true);
        assert!(made.main.unwrap().contains("g.origins = []"));
        let isolated = made.isolated.unwrap();
        assert!(isolated.starts_with("\napi\n"));
        assert!(isolated.contains("ardiaContentBlocker"));
        assert!(make_scripts(&sources, &[], false).isolated.is_none());
    }
}
