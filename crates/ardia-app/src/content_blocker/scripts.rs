use serde_json::Value;

pub const EXTENSION_ID: &str = "fajbdaomknpkicfjcpipdmcpoamdmilh";
pub const OFF_DIRECTIVE: &str = "/^(?:ardia-blocking-off|)/";
pub const PAGE_FILE: &str = "blank.html";
pub const RELOAD_WAIT_MS: u64 = 4000;

pub fn origin_of(extension_id: &str) -> String {
    format!("chrome-extension://{extension_id}/")
}

pub fn script_with(format: &str, args: &[Value]) -> String {
    let mut out = String::with_capacity(format.len() + 64);
    for (index, part) in format.split("%@").enumerate() {
        if index > 0 {
            match args.get(index - 1) {
                Some(arg) => {
                    out.push_str(&serde_json::to_string(arg).unwrap_or_else(|_| "null".into()))
                }
                None => out.push_str("%@"),
            }
        }
        out.push_str(part);
    }
    out
}

const PRELUDE: &str = r#"let failing = %FAILING%;
const offDirective = %OFF%;
const extensionOrigin = %ORIGIN%;
const deadline = Date.now() + %LEFT%;
const left = () => Math.max(0, deadline - Date.now());
let expired = false;
const withDeadline = (promise, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { expired = true; reject(new Error(`${what}: timed out`)); }, left());
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});
const ready = () => new Promise((resolve, reject) => {
  const look = () => {
    const ublock = chrome.extension.getBackgroundPage()?.µBlock;
    if (ublock?.isReadyPromise) return ublock.isReadyPromise.then(resolve, reject);
    if (left() === 0) return reject(new Error('uBlock Origin never started'));
    setTimeout(look, 10);
  };
  look();
});
const loadScript = (src) => new Promise((resolve, reject) => {
  const element = document.createElement('script');
  element.src = src;
  element.onload = resolve;
  element.onerror = () => reject(new Error(`${src} didn't load`));
  document.head.append(element);
});
const client = () => self.vAPI?.messaging ? Promise.resolve()
  : ['js/vapi.js', 'js/vapi-common.js', 'js/vapi-client.js'].reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve());
const send = (message) => {
  if (expired) return Promise.reject(new Error(`${message.what}: timed out`));
  if (failing) { failing = false; return Promise.reject(new Error(`${message.what}: failed (dev)`)); }
  return client().then(() => {
    if (expired) throw new Error(`${message.what}: timed out`);
    return vAPI.messaging.send('dashboard', message);
  }).then((reply) => {
    if (reply === undefined) throw new Error(`${message.what}: no reply`);
    return reply;
  });
};
const trusted = () => send({what: 'getWhitelist'}).then((t) => {
  if (!t || !Array.isArray(t.whitelist)) throw new Error('getWhitelist: no answer');
  return t;
});
const lists = () => send({what: 'getLists'}).then((l) => {
  if (!l || !l.available || typeof l.available !== 'object') throw new Error('getLists: no answer');
  return l;
});
const selected = (l) => Object.keys(l.available).filter((k) => l.available[k] && l.available[k].off !== true);
const imported = (l) => Object.keys(l.available).filter((k) => l.available[k] && l.available[k].group === 'custom').sort();
const covers = (directive, host) => !directive.includes('/') && (host === directive || host.endsWith('.' + directive));
const sameSet = (a, b) => [...a].sort().join('\n') === [...b].sort().join('\n');
const storageCall = (name, arg) => expired ? Promise.reject(new Error(`storage ${name}: timed out`))
  : new Promise((resolve, reject) => chrome.storage.local[name](arg, (v) =>
    chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(v || {})));
const local = {get: (k) => storageCall('get', k), set: (v) => storageCall('set', v), remove: (k) => storageCall('remove', k)};
const pendingReload = () => local.get('ardiaReloadPending').then((b) => b.ardiaReloadPending);
const reloadLists = () => pendingReload().then((asked) => send({what: 'reloadAllFilters'})
  .then(pendingReload)
  .then((now) => now === asked ? local.remove('ardiaReloadPending') : reloadLists()));
const reloadWait = (ms = %RELOAD%) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, Math.max(0, left() - 1000))));
const askReload = () => local.set({ardiaReloadPending: `${Date.now()}-${Math.random()}`});
const applySelection = (details, waitMs) => askReload()
  .then(() => send({what: 'applyFilterListSelection', ...details}))
  .then(askReload)
  .then(() => Promise.race([reloadLists(), reloadWait(waitMs)]));
const applyLists = (toSelect) => applySelection({toSelect});
const resumePendingReload = () => { pendingReload().then((asked) => asked ? reloadLists() : null).catch(() => {}); };
Promise.resolve().then(() => { if (location.origin !== extensionOrigin) throw new Error(`not the extension page: ${location.href}`); })
.then(() => withDeadline(ready(), 'uBlock Origin'))
.then(() => { resumePendingReload(); return withDeadline(Promise.resolve().then(() => (%EXPRESSION%)), 'the call'); })
.then((v) => post('result', JSON.stringify({value: v === undefined ? null : v})),
(e) => post('result', JSON.stringify({error: String(e && e.message || e)})))"#;

pub fn prelude(failing: bool, extension_id: &str, left_ms: u64, expression: &str) -> String {
    let json = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let origin = format!("chrome-extension://{extension_id}");
    PRELUDE
        .replace("%FAILING%", if failing { "true" } else { "false" })
        .replace("%OFF%", &json(OFF_DIRECTIVE))
        .replace("%ORIGIN%", &json(&origin))
        .replace("%LEFT%", &left_ms.to_string())
        .replace("%RELOAD%", &RELOAD_WAIT_MS.to_string())
        .replace("%EXPRESSION%", expression)
}

pub const READ: &str = "Promise.all([lists(), trusted()]).then(([l, t]) => ({lists: selected(l).sort(), imported: imported(l), whitelist: [...t.whitelist].sort(), autoUpdate: l.autoUpdate !== false}))";

pub const FOLLOW: &str = r#"Promise.all([lists(), trusted()]).then(([l, t]) => {
  const want = %@;
  if (!Array.isArray(want.lists) || !Array.isArray(want.whitelist)) throw new Error('no settings to copy');
  const mine = imported(l);
  const wanted = Array.isArray(want.imported) ? want.imported : mine;
  const toImport = wanted.filter((u) => !mine.includes(u));
  const toRemove = mine.filter((u) => !wanted.includes(u));
  const importsDiffer = toImport.length > 0 || toRemove.length > 0;
  let written = Promise.resolve(null);
  if (importsDiffer)
    written = written.then(() => send({what: 'applyFilterListSelection', toImport: toImport.join('\n'), toRemove}));
  if (importsDiffer || !sameSet(selected(l), want.lists))
    written = written.then(() => applyLists(want.lists));
  if (!sameSet(t.whitelist, want.whitelist))
    written = written.then(() => send({what: 'setWhitelist', whitelist: want.whitelist.join('\n')}));
  if ((l.autoUpdate !== false) !== (want.autoUpdate !== false))
    written = written.then(() => send({what: 'userSettings', name: 'autoUpdate', value: want.autoUpdate !== false}));
  return written.then(() => null);
})"#;

pub const STATE: &str = r#"Promise.all([lists(), trusted(), fetch('/assets/assets.json').then((r) => r.json())]).then(([l, t, assets]) => {
  const langs = new Set([chrome.i18n.getUILanguage(), ...(navigator.languages || [])].map((x) => (/^[a-z]+/.exec(x) || [])[0]).filter(Boolean));
  const forLanguages = (lang) => typeof lang === 'string' && lang.split(/\s+/).some((x) => langs.has(x));
  const onByDefault = (id) => !!assets[id] && (assets[id].off !== true || forLanguages(assets[id].lang));
  return {
    lists: Object.entries(l.available)
      .filter(([id, list]) => list && list.content === 'filters' && list.group !== 'user')
      .map(([id, list]) => ({id, title: list.title || id, group: list.group || '', enabled: list.off !== true,
        defaultOn: list.group !== 'custom' && onByDefault(id), filters: list.entryCount || 0,
        failed: !!(l.cache && l.cache[id] && l.cache[id].error !== undefined)})),
    networkFilters: l.netFilterCount || 0,
    cosmeticFilters: l.cosmeticFilterCount || 0,
    enabled: !t.whitelist.includes(offDirective),
    allowedHosts: t.whitelist.filter((d) => !d.includes('/') && !d.startsWith('#') && !(t.whitelistDefault || []).includes(d)),
  };
})"#;

pub const SET_ENABLED: &str = r#"trusted().then((t) => {
  const on = %@;
  const kept = t.whitelist.filter((d) => d !== offDirective);
  return send({what: 'setWhitelist', whitelist: (on ? kept : kept.concat([offDirective])).join('\n')});
}).then(() => send({what: 'userSettings', name: 'autoUpdate', value: %@}))"#;

pub const SET_LIST: &str = r#"lists().then((l) => {
  const [id, on] = [%@, %@];
  if (!l.available[id]) throw new Error(`no list ${id}`);
  const keep = selected(l).filter((x) => x !== id);
  return applyLists(on ? keep.concat([id]) : keep);
})"#;

pub const ADD_LIST: &str = r#"lists().then((before) => {
  const url = %@;
  if (!/^https?:\/\/[^\s\/]+\S*$/i.test(url) || url.length > 2048) throw new Error('not a list address');
  const needle = url.replace(/^https?:/i, '');
  const findId = (l) => l.available[url] ? url : Object.keys(l.available).find((k) =>
    [].concat(l.available[k] && l.available[k].contentURL || []).some((u) => typeof u === 'string' && u.endsWith(needle)));
  const had = findId(before);
  return applySelection({toImport: url}, Infinity).then(lists).then((l) => {
    const id = findId(l);
    if (!id) throw new Error('uBlock Origin turned the list down');
    const entry = l.available[id];
    const cache = l.cache && l.cache[id];
    return {id, custom: entry.group === 'custom', existed: !!had && before.available[had].off !== true,
      filters: entry.entryCount || 0, failed: !!(cache && cache.error !== undefined)};
  });
})"#;

pub const REMOVE_LIST: &str = r#"lists().then((l) => {
  const id = %@;
  if (!l.available[id] || l.available[id].group !== 'custom') throw new Error(`no added list ${id}`);
  return applySelection({toRemove: [id]});
})"#;

pub const IS_ALLOWED: &str = "trusted().then((t) => t.whitelist.some((d) => covers(d, %@)))";

pub const SET_ALLOWED: &str = r#"trusted().then((t) => {
  const [allowed, host] = [%@, %@];
  const kept = t.whitelist.filter((d) => allowed ? d !== host : !covers(d, host));
  return send({what: 'setWhitelist', whitelist: (allowed ? kept.concat([host]) : kept).join('\n')});
})"#;

pub const REMOVE_ALLOWED: &str = r#"trusted().then((t) => {
  const host = %@;
  if (!t.whitelist.includes(host) || (t.whitelistDefault || []).includes(host)) return false;
  return send({what: 'setWhitelist', whitelist: t.whitelist.filter((d) => d !== host).join('\n')}).then(() => true);
})"#;

const HIDING_RULES: &str = r#"const hidingRule = /^[a-z0-9.-]+##[^+^\s][^\n{}]*$/;
const savedHidingRule = /^[a-z0-9.-]+##(?![+^\s])(?!.*\/\*)[^\0-\x1f\x7f\x85\u2028\u2029{}]+$/;
const userFilters = () => chrome.extension.getBackgroundPage().µBlock.loadUserFilters().then((d) => {
  if (!d || d.error || typeof d.content !== 'string') throw new Error(`user filters: ${d && d.error || 'unreadable'}`);
  return d.content;
});"#;

pub const READ_HIDDEN: &str = "userFilters().then((content) => content.split('\\n').map((l) => l.trim()).filter((l) => hidingRule.test(l)))";

pub const HIDE: &str = r#"Promise.resolve(%@).then((want) => {
  for (const f of want) {
    if (typeof f !== 'string' || f.length > 1024 || !savedHidingRule.test(f)) throw new Error('not a hiding rule');
    document.createDocumentFragment().querySelector(f.slice(f.indexOf('##') + 2));
  }
  return userFilters().then((content) => {
    const have = new Set(content.split('\n').map((l) => l.trim()));
    const fresh = [...new Set(want)].filter((f) => !have.has(f));
    const ublock = chrome.extension.getBackgroundPage().µBlock;
    if (!ublock.selectedFilterLists.includes(ublock.userFiltersPath))
      ublock.applyFilterListSelection({toSelect: [ublock.userFiltersPath], merge: true});
    return fresh.length ? ublock.appendUserFilters(fresh.join('\n'), {}) : null;
  });
}).then(() => null)"#;

pub const RESTORE: &str = r#"Promise.resolve(new Set(%@)).then((drop) => userFilters().then((content) => {
  const lines = content.split('\n');
  const kept = lines.filter((l) => !drop.has(l.trim()));
  if (kept.length === lines.length) return null;
  const ublock = chrome.extension.getBackgroundPage().µBlock;
  return ublock.saveUserFilters(kept.join('\n')).then(() => ublock.loadFilterLists());
})).then(() => null)"#;

pub fn with_hiding_rules(body: &str) -> String {
    format!("(() => {{ {HIDING_RULES} return {body}; }})()")
}

pub fn answer(result: Option<Value>) -> Result<Value, String> {
    let Some(Value::Object(answer)) = result else {
        return Err("no answer".into());
    };
    if let Some(error) = answer.get("error") {
        return Err(error
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| "no answer".into()));
    }
    Ok(answer.get("value").cloned().unwrap_or(Value::Null))
}

const RETRIABLE: [&str; 6] = [
    "no reply",
    "no answer",
    "context invalidated",
    "not the extension page",
    "renderer ",
    "closed",
];

pub fn retriable(error: &str, on_own_page: bool) -> bool {
    !on_own_page || RETRIABLE.iter().any(|sign| error.contains(sign))
}

pub fn category(id: &str, group: &str) -> &'static str {
    match group {
        "custom" => return "custom",
        "regions" => return "regional",
        _ => {}
    }
    if id.contains("cookie") {
        "cookies"
    } else if group == "privacy" || id == "ublock-privacy" {
        "trackers"
    } else if group == "malware" || id == "ublock-badware" {
        "security"
    } else if group == "annoyances" || group == "social" {
        "annoyances"
    } else {
        "ads"
    }
}

const PICKER_INSTALL: &str = include_str!("../../assets/content_blocker/element_picker.js");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerOp {
    Start,
    Cancel,
    Apply,
    Unhide,
}

impl PickerOp {
    fn name(self) -> &'static str {
        match self {
            PickerOp::Start => "start",
            PickerOp::Cancel => "cancel",
            PickerOp::Apply => "apply",
            PickerOp::Unhide => "unhide",
        }
    }
}

pub struct PickerKeys {
    secret: u32,
    challenge: u32,
}

impl PickerKeys {
    pub fn new() -> PickerKeys {
        let mut bytes = [0u8; 8];
        let filled = getrandom_bytes(&mut bytes);
        let word = |b: &[u8]| (u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % (1 << 30)) + 1;
        if filled {
            PickerKeys {
                secret: word(&bytes[..4]),
                challenge: word(&bytes[4..]),
            }
        } else {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(7);
            PickerKeys {
                secret: ((seed % (1 << 30)) + 1) as u32,
                challenge: (((seed >> 17) % (1 << 30)) + 1) as u32,
            }
        }
    }

    pub fn answer(&self) -> u64 {
        u64::from((self.secret ^ self.challenge) % 65521) * 65537 + u64::from(self.challenge % 9973)
    }
}

impl Default for PickerKeys {
    fn default() -> Self {
        PickerKeys::new()
    }
}

fn getrandom_bytes(bytes: &mut [u8]) -> bool {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .is_ok()
}

fn edited(source: &str, edits: &[(&str, String)]) -> Option<String> {
    let mut text = source.to_owned();
    for (from, to) in edits {
        if text.matches(from).count() != 1 {
            return None;
        }
        text = text.replacen(from, to, 1);
    }
    Some(text)
}

pub fn trusted_install(keys: &PickerKeys) -> Option<String> {
    edited(
        PICKER_INSTALL,
        &[
            (
                "const KEY = Symbol.for(\"ardia.elementPicker\");\nif (!window[KEY]) {\n",
                "const KEY = Symbol.for(\"ardia.elementPicker\");\nif (!Object.prototype.hasOwnProperty.call(window, KEY)) {\n".into(),
            ),
            (
                "  const p = (window[KEY] = {\n    session: null,\n",
                format!(
                    "  const p = {{\n    session: null,\n    prove: (challenge) => ((({} ^ challenge) >>> 0) % 65521) * 65537 + (challenge % 9973),\n",
                    keys.secret
                ),
            ),
            (
                "        const onMove = (e) => {\n",
                "        const onMove = (e) => {\n          if (!e.isTrusted) return;\n".into(),
            ),
            (
                "          if (e.button !== 0) return;\n",
                "          if (!e.isTrusted || e.button !== 0) return;\n".into(),
            ),
            (
                "        const onKey = (e) => {\n",
                "        const onKey = (e) => {\n          if (!e.isTrusted) return;\n".into(),
            ),
            (
                "      });\n    },\n  });\n}\n",
                "      });\n    },\n  };\n  Object.defineProperty(window, KEY, { value: p, configurable: false, enumerable: false, writable: false });\n}\n".into(),
            ),
        ],
    )
}

pub const REFUSED_PICKER: &str = "{\"refused\":true}";

pub fn picker_call(keys: &PickerKeys, op: PickerOp, args: &[Value]) -> String {
    let install = trusted_install(keys).unwrap_or_default();
    let args = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
    let refused = serde_json::to_string(REFUSED_PICKER).unwrap_or_default();
    format!(
        "try {{\n{install}\n}} catch (e) {{}}\nconst picker = window[Symbol.for(\"ardia.elementPicker\")];\nif (!picker || typeof picker.prove !== \"function\" || picker.prove({challenge}) !== {answer}) post(\"result\", {refused});\nelse {{\n  picker.ensure?.();\n  Promise.resolve(picker.{op}(...{args})).then((v) => post(\"result\", JSON.stringify(v)), () => post(\"result\", \"null\"));\n}}",
        challenge = keys.challenge,
        answer = keys.answer(),
        op = op.name(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scripts_substitute_json_arguments_in_order() {
        assert!(
            script_with(SET_ALLOWED, &[json!(true), json!("ads.example")])
                .contains("[true, \"ads.example\"]")
        );
        assert_eq!(
            script_with("a %@ b %@", &[json!("x\"y")]),
            "a \"x\\\"y\" b %@"
        );
        let wrapped = prelude(false, EXTENSION_ID, 1500, "null");
        assert!(wrapped.contains("const deadline = Date.now() + 1500;"));
        assert!(wrapped.contains("\"chrome-extension://fajbdaomknpkicfjcpipdmcpoamdmilh\""));
        assert!(wrapped.contains("const offDirective = \"/^(?:ardia-blocking-off|)/\";"));
        assert!(wrapped.contains("(null)), 'the call'"));
        assert!(!wrapped.contains('%'));
        assert!(with_hiding_rules(READ_HIDDEN).starts_with("(() => { const hidingRule"));
    }

    #[test]
    fn answers_and_retries() {
        assert_eq!(answer(Some(json!({"value": 3}))), Ok(json!(3)));
        assert_eq!(answer(Some(json!({"value": null}))), Ok(Value::Null));
        assert_eq!(
            answer(Some(json!({"error": "getLists: no reply"}))),
            Err("getLists: no reply".into())
        );
        assert_eq!(answer(None), Err("no answer".into()));
        assert!(retriable("getLists: no reply", true));
        assert!(!retriable("not a list address", true));
        assert!(retriable("not a list address", false));
        assert_eq!(category("fanboy-cookiemonster", "annoyances"), "cookies");
        assert_eq!(category("ublock-privacy", ""), "trackers");
        assert_eq!(category("easylist", "ads"), "ads");
        assert_eq!(category("x", "regions"), "regional");
    }

    #[test]
    fn the_trusted_picker_applies_every_edit_and_answers_its_challenge() {
        let keys = PickerKeys {
            secret: 12345,
            challenge: 678,
        };
        let install = trusted_install(&keys).expect("every edit lands once");
        assert!(install.contains("Object.defineProperty(window, KEY"));
        assert!(install.contains("if (!e.isTrusted) return;"));
        let call = picker_call(&keys, PickerOp::Unhide, &[json!([".ad"])]);
        assert!(call.contains("picker.unhide(...[[\".ad\"]])"));
        assert!(call.contains(&format!("picker.prove(678) !== {}", keys.answer())));
        assert_eq!(keys.answer(), u64::from(12345u32 ^ 678) * 65537 + 678);
    }
}
