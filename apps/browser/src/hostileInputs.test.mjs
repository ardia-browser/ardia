import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { embedded, FILTER_SYNTAX, HOSTILE_STRINGS, HOSTILE_VALUES, LINE_BREAKS, LINE_TERMINATORS, PROTOTYPE_KEYS, UBLOCK_LINE_BREAK, URL_SCHEMES } from "../../../scripts/security/hostile-inputs.mjs";

globalThis.__DEV__ = false;
const stub = await import("./test-native/index.ts");
const { useBrowser } = await import("./state/browser/store.ts");
const { activeTabId } = await import("./state/browser/model.ts");
const { webviews } = await import("./platform/webviews.ts");
const { acceptedPick, hidingFilter, hidingHost, parseHidingFilter, savablePickedSelector, startHidingElement } = await import("./state/site/hiddenElements.ts");
const { openExternalUrls } = await import("./state/littleArdia/actions.ts");
const { runCommand } = await import("./state/commands/commands.ts");
const { startReader, toggleReader } = await import("./state/reader/reader.ts");
const { pluginWebUrl } = await import("./lib/pluginWebUrl.ts");
const { parseOps, openableUrl } = await import("./state/automation/workspaceOps.ts");
const { pluginUrlRule } = await import("./state/plugins/channelApi.ts");
const { DEFAULT_SETTINGS, SETTING_KEYS, SETTING_SPECS, parseSettings, searchUrlPrefix, writableSettingsPatch } = await import("./state/settings/settings.ts");
const { settingsAdapter, SYNCED_SETTINGS } = await import("./state/sync/settingsAdapter.ts");
const { customEnginesFrom } = await import("@ardia/core");
const { bookmarkValue, deviceTabs, sendRecord } = await import("./state/sync/records.ts");
const { syncedHome } = await import("./state/sync/pinRecords.ts");
const { sendableUrl } = await import("./state/sync/sentTabsAdapter.ts");
const { filterListAddress } = await import("./state/site/contentBlocking.ts");
const { CLEAN_UP_KEY, LEGACY_CLEAN_UP_KEY } = await import("./state/settings/cleanUpAfter.ts");
const { updateWithin } = await import("./state/plugins/officialUpdate.ts");
const { readManifest } = await import("./lib/pluginManifest.ts");
const { parseIntent, INTENT_SPECS } = await import("./state/plugins/stateIntents.ts");
const { pluginStateUrl, redactedTabs } = await import("./state/plugins/pluginEventRedaction.ts");
const { copyLinkFromPageMenu } = await import("./state/site/pageLinkCopy.ts");
const { cleanUrl } = await import("@ardia/core");

const S = () => useBrowser.getState();
const show = (value) => {
  try {
    return JSON.stringify(value)?.slice(0, 120) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};
const strings = HOSTILE_STRINGS.map((h) => h.value);

const nativeRule = (source, name) => {
  const found = new RegExp(`const ${name} = /(.+?)/;`).exec(source)?.[1];
  assert.ok(found, `${name} is still declared where the test reads it`);
  return new RegExp(found.replace(/\\\\/g, "\\"));
};
const blockerSource = readFileSync(new URL("../../../packages/ardiacore/ios/ArdiaContentBlocker.mm", import.meta.url), "utf8");
const MAC_WRITE_RULE = nativeRule(blockerSource, "savedHidingRule");
const linuxBridge = readFileSync(new URL("../../../engine/ardiacore-linux/content-blocker/ardia-linux-bridge.js", import.meta.url), "utf8");
const LINUX_WRITE_RULE = new RegExp(/const hidingRule = \/(.+?)\/;/.exec(linuxBridge)[1]);
const LINUX_NATIVE_REFUSES = /[\n\r\0]/;

const HOST = "ardia-fixture.test";

function assertInertFilter(filter, input) {
  if (filter === null) return;
  const where = show(input);
  assert.equal(typeof filter, "string", where);
  assert.ok(filter.startsWith(`${HOST}##`), `${where}: the rule stays on the page's host`);
  assert.ok(filter.length <= 1024, `${where}: within the length cap`);
  assert.doesNotMatch(filter, UBLOCK_LINE_BREAK, `${where}: one uBlock line`);
  assert.doesNotMatch(filter, LINE_TERMINATORS, `${where}: no line terminator of any kind`);
  assert.ok(MAC_WRITE_RULE.test(filter), `${where}: the Mac write guard takes what the app sends`);
  assert.ok(LINUX_WRITE_RULE.test(filter) && !LINUX_NATIVE_REFUSES.test(filter), `${where}: the Linux write guards take what the app sends`);
  assert.equal(parseHidingFilter(filter)?.filter, filter, `${where}: the listing reads it back as the same rule`);
  const selector = filter.slice(HOST.length + 2);
  assert.ok(!/^[+^\s]/.test(selector), `${where}: not a scriptlet, HTML filter or blank`);
}

const selectorShapes = (s) => [...embedded(s, "div", "p"), `[data-testid="${s}"]`, `section[data-testid="a${s}b"]`, `div > a[data-qa="${s}"] span`];

test("every hostile selector either saves as one inert hiding rule or saves nothing", () => {
  for (const s of strings)
    for (const selector of selectorShapes(s)) {
      assertInertFilter(hidingFilter(HOST, selector), selector);
      const savable = savablePickedSelector(selector);
      assertInertFilter(savable === null ? null : hidingFilter(HOST, savable), selector);
    }
});

test("the shared rule, the Mac write guard and the listing agree on every hostile filter", () => {
  for (const s of strings)
    for (const selector of selectorShapes(s)) {
      const raw = `${HOST}##${selector}`;
      assert.equal(parseHidingFilter(raw) !== null, MAC_WRITE_RULE.test(raw), show(raw));
    }
});

test("a hiding host is only a plain lowercase hostname, whatever the page's URL holds", () => {
  for (const s of strings)
    for (const url of [s, `https://${s}/`, `https://a.test/${s}`, `http://${s}.test/`]) {
      const host = hidingHost(url);
      assert.ok(host === null || /^[a-z0-9.-]+$/.test(host), show(url));
    }
});

test("a picker answer is a string selector or nothing, whatever shape the page gives it", () => {
  for (const { value } of HOSTILE_VALUES) {
    for (const answer of [value, { selector: value }, { selector: value, refused: false }, [value]]) {
      const picked = acceptedPick(answer, true, true);
      assert.ok(picked === null || (typeof picked === "string" && typeof answer?.selector === "string"), show(answer));
    }
  }
});

function hideCalls() {
  const blocker = stub.ardiaCoreNativeModules.ArdiaContentBlocker;
  const original = blocker.call;
  const sent = [];
  blocker.call = (verb, profile, json) => {
    if (verb === "hideElements") {
      sent.push(JSON.parse(json).filters);
      return Promise.resolve("null");
    }
    return original(verb, profile, json);
  };
  return { sent, restore: () => (blocker.call = original) };
}

function plantedTab(answer, { confirmed }) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${HOST}/article` });
  const tab = activeTabId(S(), w);
  webviews.set(tab, {
    evaluate: async () => answer,
    focus: async () => {},
    armElementPick: async () => 1,
    takeElementPick: async () => confirmed,
  });
  return tab;
}

test("A1 C1: a pick the browser never saw confirmed writes nothing, whatever the page answers", async () => {
  const { sent, restore } = hideCalls();
  try {
    for (const { value } of HOSTILE_VALUES.slice(0, 60)) {
      await startHidingElement(plantedTab({ selector: value }, { confirmed: false }));
      await startHidingElement(plantedTab({ selector: "#fixture-banner" }, { confirmed: false }));
    }
    assert.deepEqual(sent, []);
  } finally {
    restore();
  }
});

test("A3: a confirmed pick whose selector the page controls still reaches the blocker only as one inert rule", async () => {
  const { sent, restore } = hideCalls();
  try {
    for (const s of strings) for (const selector of selectorShapes(s).slice(0, 4)) await startHidingElement(plantedTab({ selector }, { confirmed: true }));
    assert.ok(sent.length > 0, "some hostile selectors still make plain rules");
    for (const filters of sent) {
      assert.equal(filters.length, 1);
      assertInertFilter(filters[0], filters[0]);
    }
  } finally {
    restore();
  }
});

const ADMITTED_FROM_APPS = /^(?:https?:\/\/[^/?#\\]|file:\/\/|about:blank$|ardia:\/\/)/i;
const NEVER_NAVIGATED = /^\s*(?:javascript|vbscript|data|chrome|chrome-untrusted|chrome-extension|devtools|view-source|blob|filesystem):/i;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tabUrls = () => Object.values(S().tabs).map((t) => t.url).filter((u) => u !== undefined && u !== "");

test("D5: a link from another app reaches a tab only as a web, file, blank or listed Ardia address", async () => {
  S().hydrate({});
  const given = strings.flatMap((s) => [s, `https://a.test/${s}`, `ardia://${s}`, `arc://${s}`, `${s}https://a.test/`]);
  const named = ["javascript", "javascriptMixedCase", "data", "dataBase64", "extension", "devtools", "viewSource", "ardiaUnknown", "arcLegacyUnknown", "blob", "filesystem", "vbscript"].map((n) => URL_SCHEMES[n]);
  for (const url of [...given, ...named]) openExternalUrls([url]);
  openExternalUrls(["https://ardia-fixture.test/from-another-app"]);
  await wait(50);
  const opened = tabUrls();
  assert.ok(opened.length > 50, `the admitted links opened (${opened.length})`);
  assert.ok(opened.includes("https://ardia-fixture.test/from-another-app"), "an ordinary web link still opens");
  for (const url of opened) {
    assert.match(url, ADMITTED_FROM_APPS, show(url));
    assert.doesNotMatch(url, NEVER_NAVIGATED, show(url));
    assert.doesNotMatch(url, LINE_TERMINATORS, show(url));
  }
  for (const url of named) assert.ok(!opened.includes(url), show(url));
});

test("D4: a plugin's URL, through open, apply and group.create, is only ever http or https", () => {
  for (const { value } of HOSTILE_VALUES) {
    for (const url of typeof value === "string" ? [value, `https://a.test/${value}`, `${value}https://a.test/`] : [value]) {
      const checked = pluginWebUrl(url);
      if ("url" in checked) {
        assert.match(checked.url, /^https?:\/\/[^/?#\s]/i, show(url));
        assert.doesNotMatch(checked.url, /[\u0000-\u001f\u007f-\u009f\s\\]/u, show(url));
      }
      for (const op of [{ op: "open", urls: [url] }, { op: "group.create", urls: [url] }]) {
        const parsed = parseOps([op], pluginUrlRule);
        if (!Array.isArray(parsed)) continue;
        for (const u of parsed[0].urls) assert.match(u, /^https?:\/\//i, show(op));
      }
    }
  }
});

test("the owner's URL rule never opens script, data or engine-internal addresses", () => {
  for (const s of strings)
    for (const url of [s, `https://a.test/${s}`, `${s}https://a.test/`]) {
      const opened = openableUrl(url);
      if (typeof opened !== "string" || opened === "") continue;
      assert.doesNotMatch(opened, /^\s*(?:javascript|vbscript|data|chrome-extension|devtools|blob|filesystem):/i, show(url));
    }
});

test("a plugin's state event never carries a hostile address, whatever its tab holds", () => {
  for (const r of [{ full: false, urls: true }, { full: true, urls: true }, { full: true, urls: false }]) {
    for (const { value } of HOSTILE_VALUES) {
      for (const url of typeof value === "string" ? [value, `https://a.test/${value}`, `${value}https://a.test/`, `https://a.test/?q=${value}#${value}`] : [value]) {
        const shown = pluginStateUrl(url, r);
        if (shown === null) continue;
        assert.ok(r.urls, show(url));
        assert.match(shown, /^https?:\/\/[^/?#\s@]+(?:[/?]|$)/i, show(url));
        assert.doesNotMatch(shown, /[\u0000-\u001f\u007f-\u009f\u2028\u2029#]/u, show(url));
        if (!r.full) assert.doesNotMatch(shown, /\?/, show(url));
      }
    }
  }
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.test/" });
  for (const s of strings) S().newTab(w, { url: s });
  for (const t of redactedTabs(S(), { full: true, urls: true })) {
    if (t.url !== null) assert.match(t.url, /^https?:\/\//i, show(t.url));
    if (t.title !== null) assert.doesNotMatch(t.title, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u, show(t.title));
  }
});

test("a hostile value in any intent field is refused before it reaches a reducer", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.test/" });
  const tab = activeTabId(S(), w);
  const other = S().newTab(w, { url: "https://b.test/" });
  const group = S().createGroup([other], { name: "G" });
  assert.ok(S().groups[group], "the fixture's group exists");
  const defaults = (spec) => {
    const args = { tabs: [tab], tab, group, collapsed: false };
    for (const key of Object.keys(args)) if (!Object.hasOwn(spec.fields, key)) delete args[key];
    return args;
  };
  for (const [intent, spec] of Object.entries(INTENT_SPECS)) assert.ok("op" in parseIntent(intent, defaults(spec)), `${intent}'s fixture parses, so each field below is what's tested`);
  for (const [intent, spec] of Object.entries(INTENT_SPECS)) {
    for (const field of Object.keys(spec.fields)) {
      for (const { value } of HOSTILE_VALUES) {
        const args = { ...defaults(spec), [field]: value };
        const parsed = parseIntent(intent, args);
        if (!("op" in parsed)) {
          assert.ok(parsed.code === "bad_request" || parsed.code === "refused", show(value));
          continue;
        }
        for (const [key, out] of Object.entries(parsed.op)) {
          if (typeof out === "string") assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/u, `${intent}.${key} ${show(value)}`);
          if (key === "tabs") for (const id of out) assert.equal(id, tab, show(value));
        }
        assert.ok(!("profile" in parsed.op) && !("urls" in parsed.op), show(value));
      }
    }
  }
  for (const key of PROTOTYPE_KEYS) {
    assert.equal(parseIntent(key, { tabs: [tab] }).code, "bad_request", key);
    assert.equal(parseIntent("tabs.pin", JSON.parse(`{"tabs":[${JSON.stringify(tab)}],${JSON.stringify(key)}:1}`)).code, "bad_request", key);
  }
});

test("an operation named after an Object prototype key is a bad request, not a crash", () => {
  for (const key of PROTOTYPE_KEYS)
    for (const op of [{ op: key }, { op: key, tab: "t1" }, { op: key, urls: ["https://a.test/"] }]) {
      const parsed = parseOps([op]);
      assert.equal(Array.isArray(parsed), false, key);
      assert.equal(parsed.code, "bad_request", key);
    }
});

const freshSettings = () => {
  S().hydrate({});
  useBrowser.setState({ settings: { ...DEFAULT_SETTINGS }, settingsMeta: { chosen: [], inferred: [] } });
};

function assertSettingsInSpec(before, label) {
  const now = S().settings;
  for (const key of SETTING_KEYS) {
    assert.ok(SETTING_SPECS[key].valid(now[key]), `${label}: ${key} holds ${show(now[key])}`);
  }
  for (const key of Object.keys(now)) assert.ok(Object.hasOwn(SETTING_SPECS, key), `${label}: no unknown key ${key}`);
  if (before) for (const key of SETTING_KEYS) if (now[key] !== before[key]) assert.ok(SETTING_SPECS[key].valid(now[key]), `${label}: ${key}`);
}

test("no hostile value reaches settings storage through a local write, a sync write or a synced record", () => {
  for (const { id, value } of HOSTILE_VALUES) {
    const rejectedEverywhere = SETTING_KEYS.filter((key) => !SETTING_SPECS[key].valid(value));
    for (const fromSync of [false, true]) {
      freshSettings();
      const before = S().settings;
      S().updateSettings(Object.fromEntries(SETTING_KEYS.map((key) => [key, value])), { fromSync });
      assertSettingsInSpec(before, `${id} fromSync=${fromSync}`);
      for (const key of rejectedEverywhere) assert.equal(S().settings[key], before[key], `${id}: ${key} is unchanged`);
    }
    freshSettings();
    const before = S().settings;
    const visible = new Map(SYNCED_SETTINGS.map((key) => [`set:${key === CLEAN_UP_KEY ? LEGACY_CLEAN_UP_KEY : key}`, { v: value }]));
    settingsAdapter.apply(visible, [...visible.keys()]);
    assertSettingsInSpec(before, `${id} through the sync adapter`);
    const fromDisk = parseSettings(Object.fromEntries(SETTING_KEYS.map((key) => [key, value])));
    for (const key of SETTING_KEYS) assert.ok(SETTING_SPECS[key].valid(fromDisk[key]), `${id}: ${key} read from disk`);
  }
});

test("a settings write keyed by an Object prototype name changes nothing and pollutes nothing", () => {
  freshSettings();
  const before = S().settings;
  for (const key of PROTOTYPE_KEYS) {
    const patch = JSON.parse(`{"${key}": {"ardiaPolluted": true}}`);
    assert.deepEqual(writableSettingsPatch(patch).patch, {}, key);
    S().updateSettings(patch);
    S().updateSettings(patch, { fromSync: true });
  }
  assert.deepEqual(S().settings, before);
  assert.equal({}.ardiaPolluted, undefined);
  assert.equal(Object.prototype.ardiaPolluted, undefined);
});

test("C2 R4 R5: whatever reaches the search settings, a search goes to an http or https template and a bad list never clears the saved one", () => {
  const saved = [{ id: "c1", name: "Mine", keyword: "m", url: "https://search.example/?q=%s" }];
  for (const { id, value } of HOSTILE_VALUES) {
    for (const engine of [value, { id: "x", name: "x", keyword: "x", url: value }, { id: "x", name: "x", keyword: "x", url: "https://a.test/?q=%s", suggestUrl: value }]) {
      for (const e of customEnginesFrom([engine])) {
        assert.match(e.url, /^https?:\/\/[^/?#\s]+/i, id);
        assert.deepEqual(Object.keys(e).sort(), ["id", "keyword", "name", "url"], `${id}: only the declared fields survive`);
      }
    }
    freshSettings();
    useBrowser.setState({ settings: { ...DEFAULT_SETTINGS, customSearchEngines: saved } });
    S().updateSettings({ customSearchEngines: value, customSearchUrl: value, searchEngine: "custom" }, { fromSync: true });
    S().updateSettings({ customSearchEngines: value, customSearchUrl: value, searchEngine: value });
    assert.match(searchUrlPrefix(S().settings), /^https?:\/\//i, id);
    if (!SETTING_SPECS.customSearchEngines.valid(value)) assert.deepEqual(S().settings.customSearchEngines, saved, `${id}: the saved list survives`);
  }
});

test("sync record decoders hand on only the shapes they declare", () => {
  for (const { id, value } of HOSTILE_VALUES) {
    for (const record of [value, { n: value, tabs: value }, { n: "d", tabs: [value] }, { n: "d", tabs: [{ u: value, t: value }] }]) {
      const decoded = deviceTabs(record);
      if (decoded) assert.ok(typeof decoded.n === "string" && decoded.tabs.every((t) => typeof t.u === "string" && typeof t.t === "string"), id);
    }
    for (const record of [value, { k: "u", p: value, t: "t", u: value, a: 1, pos: "a" }, { k: value, p: "p", t: "t", a: value, pos: "a" }]) {
      const decoded = bookmarkValue(record);
      if (decoded) assert.ok(typeof decoded.p === "string" && typeof decoded.t === "string" && (decoded.u === undefined || typeof decoded.u === "string"), id);
    }
    for (const record of [value, { u: value, t: "t", to: "d", from: "e", at: 1 }]) {
      const decoded = sendRecord(record);
      if (decoded) assert.equal(typeof decoded.u, "string", id);
      if (decoded && sendableUrl(decoded.u)) assert.match(decoded.u, /^https?:\/\/\S/i, `${id}: a sent tab opens only a web address`);
    }
  }
});

test("C5: a synced pinned group home or a recent-device tab with a non-web address is refused", { todo: "C5 open, #3569: synced homes and recent-device tabs take any address" }, () => {
  for (const name of ["javascript", "data", "file", "chrome", "extension"]) {
    assert.equal(syncedHome(URL_SCHEMES[name]), undefined, name);
    assert.equal(deviceTabs({ n: "d", tabs: [{ u: URL_SCHEMES[name], t: "t" }] }), null, name);
  }
});

test("B1 R3: a page's own Reader helper can't change the Reader look the user chose", async () => {
  const stop = startReader();
  try {
    S().hydrate({});
    useBrowser.setState({ settings: { ...DEFAULT_SETTINGS }, settingsMeta: { chosen: [], inferred: [] } });
    const w = S().createWindow({ url: "http://127.0.0.1:9/article-hostile" });
    const tab = activeTabId(S(), w);
    const looks = [{ dark: false, size: 4, font: "sans" }, { size: "length" }, { size: "constructor", font: "__proto__" }, "big", null];
    let n = 0;
    webviews.set(tab, { evaluate: async () => ({ active: true, readerable: true, look: looks[n++ % looks.length] }) });
    await wait(350);
    await toggleReader(tab);
    await toggleReader(tab);
    assert.ok(n >= 3, "the reader asked the page several times");
    assert.deepEqual([S().settings.readerTextSize, S().settings.readerFont], [DEFAULT_SETTINGS.readerTextSize, DEFAULT_SETTINGS.readerFont]);
    assert.deepEqual(S().settingsMeta.chosen.filter((k) => k.startsWith("reader")), []);
  } finally {
    stop();
  }
});

test("B5: Use Selection for Find takes only a string from the page, whatever it returns", async () => {
  for (const { id, value } of HOSTILE_VALUES.filter((h) => h.id.startsWith("type.") || h.id.startsWith("overlong.") || h.id.startsWith("prototype."))) {
    S().hydrate({});
    const w = S().createWindow({ url: "http://127.0.0.1:9/page" });
    const tab = activeTabId(S(), w);
    webviews.set(tab, { evaluate: async () => value });
    runCommand({ command: "useSelectionForFind", windowId: w });
    await wait(5);
    const find = S().find[tab];
    if (find?.query !== undefined) {
      assert.equal(typeof find.query, "string", id);
      assert.ok(find.query.length <= 500, id);
    }
  }
});

test("C9: a filter list address is one parsed http or https URL", () => {
  for (const s of strings)
    for (const typed of [s, `https://lists.example/${s}`, `${s}lists.example/a.txt`]) {
      const url = filterListAddress(typed);
      if (url === null) continue;
      assert.match(url, /^https?:\/\/[^/?#\s]+/i, show(typed));
      assert.doesNotMatch(url, /[\s\u0000-\u001f]/, show(typed));
    }
});

test("the release's original smuggled hide is refused at every layer", () => {
  const smuggled = `head${FILTER_SYNTAX.commentOpener}${LINE_BREAKS.cr}*${FILTER_SYNTAX.scriptlet}${LINE_BREAKS.cr}${FILTER_SYNTAX.commentCloser}`;
  assert.equal(savablePickedSelector(smuggled), null);
  assert.equal(hidingFilter(HOST, smuggled), null);
  assert.equal(MAC_WRITE_RULE.test(`${HOST}##${smuggled}`), false);
  assert.equal(LINUX_NATIVE_REFUSES.test(`${HOST}##${smuggled}`), true);
});

test("an official update's manifest with any hostile value in a field that counts is never approved without a sheet", () => {
  const steps = [["skills", "install", "--auto"], ["skills", "refresh"], ["computer", "refresh"]];
  const approved = readManifest(JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version: "0.4.0", alwaysOn: true, official: true, permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: steps }] })).manifest;
  const next = readManifest(JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.6.0", alwaysOn: true, official: true, main: "dist/main.js", permissions: { control: true }, contributes: { commands: [{ name: "show-status", title: "Status", icon: "terminal", view: "status" }], programs: [{ name: "ardia", path: "bin/ardia", claim: true, afterUpdate: steps }] } })).manifest;
  assert.equal(updateWithin(approved, next).ok, true, "the real move passes, so the refusals below aren't vacuous");
  const COSMETIC = new Set(["manifest", "declaredManifest", "title", "description", "version", "requires", "icon", "keywords", "telemetry"]);
  const unchanged = (a, b) => typeof a === typeof b && JSON.stringify(a) === JSON.stringify(b);
  let refused = 0;
  for (const { value } of HOSTILE_VALUES) {
    for (const key of Object.keys(next).filter((k) => !COSMETIC.has(k) && !unchanged(value, next[k]) && !unchanged(value, approved[k]))) {
      const verdict = updateWithin(approved, { ...next, [key]: value });
      assert.equal(verdict.ok, false, `${key} = ${show(value)}`);
      refused++;
    }
    for (const key of Object.keys(next.permissions).filter((k) => !unchanged(value, next.permissions[k]) && !unchanged(value, approved.permissions[k]))) assert.equal(updateWithin(approved, { ...next, permissions: { ...next.permissions, [key]: value } }).ok, false, `permissions.${key} = ${show(value)}`);
    for (const key of Object.keys(next.contributes).filter((k) => !unchanged(value, next.contributes[k]) && !unchanged(value, approved.contributes[k]))) assert.equal(updateWithin(approved, { ...next, contributes: { ...next.contributes, [key]: value } }).ok, false, `contributes.${key} = ${show(value)}`);
    assert.equal(updateWithin(approved, { ...next, programs: [{ ...next.programs[0], afterUpdate: [...steps, [value]] }] }).ok, false, `afterUpdate step ${show(value)}`);
  }
  for (const key of PROTOTYPE_KEYS) {
    const extra = JSON.parse(`{${JSON.stringify(key)}: true}`);
    assert.equal(updateWithin(approved, { ...next, ...extra }).ok, false, `manifest key ${key}`);
    assert.equal(updateWithin(approved, { ...next, permissions: { ...next.permissions, ...extra } }).ok, false, `permission key ${key}`);
    assert.equal(updateWithin(approved, { ...next, contributes: { ...next.contributes, ...extra } }).ok, false, `contributes key ${key}`);
  }
  assert.ok(refused > 1000);
});

test("a WebKit page menu address reaches native's writer only as a string the cleaner returned, whatever the page holds", async () => {
  const { webKitAddressWrites } = stub;
  webKitAddressWrites.written.length = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    webKitAddressWrites.written.length = 0;
    await copyLinkFromPageMenu(value, 7, null);
    if (typeof value !== "string" || !value) assert.deepEqual(webKitAddressWrites.written, [], id);
    else assert.deepEqual(webKitAddressWrites.written, [{ request: 7, url: cleanUrl(value) }], id);
  }
  for (const s of strings) {
    for (const address of [s, `https://a.example/?utm_source=${s}&q=1`, `https://a.example/${s}?fbclid=1`]) {
      webKitAddressWrites.written.length = 0;
      await copyLinkFromPageMenu(address, 7, null);
      assert.deepEqual(webKitAddressWrites.written, address ? [{ request: 7, url: cleanUrl(address) }] : [], show(address));
    }
  }
});

const { logpointCondition, checkedExpression } = await import("./state/automation/devToolsLogpoints.ts");
const { inlineMapText, SourceMapResolver } = await import("./state/automation/devToolsSourceMaps.ts");
const { fieldDataOrigin } = await import("./state/automation/devToolsFieldData.ts");
const { describeIssue } = await import("./state/automation/devToolsIssues.ts");
const { schemaProblem } = await import("./state/automation/socketSchema.ts");
const { DEVTOOLS_INSPECT_METHODS } = await import("./state/automation/socketDevToolsInspect.ts");
const vm = await import("node:vm");

test("no hostile expression or condition makes a logpoint's condition truthy, so it never pauses the page", () => {
  const run = (code) => {
    const logged = [];
    const context = vm.createContext({ console: { log: (...args) => logged.push(args) }, String });
    return { result: vm.runInContext(`(function () { const total = 3; return ${code}; })()`, context, { timeout: 500 }), logged };
  };
  const control = run(logpointCondition("c", "total", null));
  assert.deepEqual([control.result, control.logged], [false, [["[ardia logpoint c]", 3]]], "a plain logpoint logs");
  for (const s of strings) {
    let usable = true;
    try {
      checkedExpression(s, "expression");
    } catch {
      usable = false;
    }
    if (!usable) continue;
    for (const code of [logpointCondition("h", s, null), logpointCondition("h", "total", s), logpointCondition("h", s, s)]) assert.equal(run(code).result, false, show(s));
  }
});

test("a source map is only ever an inline data: map or one the caller passed, and nothing goes to the network, whatever the page names", () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("source maps never go to the network");
  try {
    const map = JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" });
    assert.equal(inlineMapText(`data:application/json;base64,${Buffer.from(map).toString("base64")}`), map, "an inline map decodes");
    for (const s of strings)
      for (const ref of [s, `${s}.map`, `https://evil.example/${s}`, `\u002f/evil.example/${s}`, `data:application/json;base64,${s}`]) {
        const text = inlineMapText(ref);
        if (text !== null) assert.ok(ref.startsWith("data:application/json"), show(ref));
        const resolver = new SourceMapResolver({ scripts: { "https://shop.example/a.js": `x()\n//# sourceMappingURL=${ref}` } });
        const parsed = resolver.mapFor("https://shop.example/a.js");
        if (parsed) assert.ok(ref.startsWith("data:"), show(ref));
      }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("field data asks only for a web origin, never another scheme, credentials, a path or a query", () => {
  assert.equal(fieldDataOrigin("https://shop.example/a?b=1#c"), "https://shop.example");
  for (const s of strings)
    for (const page of [s, `https://shop.example/${s}`, `${s}://shop.example/`]) {
      let origin = null;
      try {
        origin = fieldDataOrigin(page);
      } catch {
        continue;
      }
      assert.match(origin, /^https?:\/\/[^/?#@\s]+$/, show(page));
    }
});

test("DevTools issue codes and the styles method's property names refuse hostile values", () => {
  const styles = DEVTOOLS_INSPECT_METHODS.find((m) => m.name === "devtools.styles");
  assert.equal(schemaProblem(styles.params, { tab: "t", selector: "a", properties: ["color", "--brand-1"] }, "params"), null);
  for (const { id, value } of HOSTILE_VALUES) {
    const described = describeIssue({ issue: { code: value, details: {} } });
    if (described) assert.match(described.code, /^[A-Za-z]+$/, id);
    if (typeof value === "string" && /^[a-z][a-z-]*$/i.test(value)) continue;
    assert.notEqual(schemaProblem(styles.params, { tab: "t", selector: "a", properties: [value] }, "params"), null, id);
  }
});

const { analyzeTrace } = await import("./state/automation/devToolsInsights.ts");
const { cascadeFor, declaredProperties } = await import("./state/automation/devToolsCascade.ts");

function assertBoundedTree(value, label, depth = 0) {
  assert.ok(depth < 12, `${label}: nesting stays shallow`);
  if (typeof value === "string") assert.ok(value.length <= 4096, `${label}: a string of ${value.length} characters`);
  else if (typeof value === "number") assert.ok(Number.isFinite(value), `${label}: a finite number`);
  else if (Array.isArray(value)) {
    assert.ok(value.length <= 64, `${label}: a list of ${value.length}`);
    value.forEach((item, i) => assertBoundedTree(item, `${label}[${i}]`, depth + 1));
  } else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) assertBoundedTree(item, `${label}.${key}`, depth + 1);
}

test("every hostile value in a page's trace events gives a bounded, well-shaped analysis and pollutes nothing", () => {
  const navigation = { name: "navigationStart", ph: "R", pid: 2, tid: 3, ts: 1_000_000, args: { frame: "F", data: { documentLoaderURL: "https://a.example/", isOutermostMainFrame: true, navigationId: "N" } } };
  const control = analyzeTrace([navigation, { name: "LayoutShift", ph: "I", pid: 2, tid: 3, ts: 1_100_000, args: { frame: "F", data: { score: 0.2, had_recent_input: false } } }]);
  assert.equal(control.metrics.cls.value, 0.2, "a real shift is measured, so the hostile runs aren't vacuous");
  for (const { id, value } of HOSTILE_VALUES) {
    const events = [
      navigation,
      { name: value, ph: value, ts: value, dur: value, pid: value, tid: value, args: value },
      { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: 1_000_100, args: { data: { requestId: value, url: value, frame: value, renderBlocking: value, priority: value } } },
      { name: "ResourceSendRequest", ph: "I", pid: 2, tid: 3, ts: 1_000_200, args: { data: { requestId: "R", url: typeof value === "string" ? `https://a.example/${value}` : value, frame: "F", renderBlocking: "blocking" } } },
      { name: "ResourceFinish", ph: "I", pid: 2, tid: 3, ts: 1_000_300, args: { data: { requestId: "R", finishTime: value, encodedDataLength: value } } },
      { name: "largestContentfulPaint::Candidate", ph: "R", pid: 2, tid: 3, ts: 1_200_000, args: { frame: "F", data: { candidateIndex: value, nodeId: value, type: value, url: value, navigationId: "N" } } },
      { name: "LayoutShift", ph: "I", pid: 2, tid: 3, ts: 1_300_000, args: { frame: value, data: { score: value, weighted_score_delta: value, impacted_nodes: value } } },
      { name: "EventTiming", ph: "b", pid: 2, tid: 3, ts: 1_400_000, args: { data: { interactionId: value, duration: value, type: value, frame: value, timeStamp: value, processingStart: value, processingEnd: value } } },
      { name: "RunTask", ph: "X", pid: 2, tid: 3, ts: 1_500_000, dur: 90_000, args: {} },
      { name: "EvaluateScript", ph: "X", pid: 2, tid: 3, ts: 1_500_100, dur: 80_000, args: { data: { url: value, functionName: value } } },
      { name: "TracingStartedInBrowser", ph: "I", pid: 1, tid: 1, ts: 999_000, args: { data: { frames: value } } },
      { name: "FrameCommittedInBrowser", ph: "I", pid: 1, tid: 1, ts: 1_000_050, args: { data: { frame: value, parent: value } } },
    ];
    for (const input of [events, { traceEvents: events }, value]) {
      const result = analyzeTrace(input);
      assertBoundedTree(JSON.parse(JSON.stringify(result)), id);
      assert.equal(typeof result.metrics.cls.value, "number", id);
      for (const insight of result.insights) assert.match(insight.id, /^[a-z-]+$/, id);
    }
  }
  assert.equal({}.ardiaPolluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("every hostile value in a page's matched styles gives a bounded cascade answer and pollutes nothing", () => {
  const control = cascadeFor({ matchedCSSRules: [{ rule: { origin: "regular", selectorList: { selectors: [{ text: ".x" }] }, style: { cssProperties: [{ name: "color", value: "red" }] } }, matchingSelectors: [0] }] }, {}, ["color"], new Map());
  assert.equal(control.winner?.value ?? control[0].winner.value, "red", "a real rule wins, so the hostile runs aren't vacuous");
  for (const { id, value } of HOSTILE_VALUES) {
    const prop = { name: value, value, important: value, disabled: value, parsedOk: value, implicit: value, range: value, longhandProperties: value };
    const rule = { rule: { origin: value, styleSheetId: value, selectorList: { selectors: [{ text: value, specificity: value }], text: value }, style: { styleSheetId: value, cssProperties: [prop, { name: "color", value, longhandProperties: [{ name: value, value }] }] }, layers: value, media: value, supports: value }, matchingSelectors: value };
    const matched = { inlineStyle: { cssProperties: [prop] }, attributesStyle: value, matchedCSSRules: [rule, value], inherited: [value, { matchedCSSRules: [rule] }], cssPropertyRules: [{ propertyName: { text: value }, style: { cssProperties: [{ name: "inherits", value }] } }, value] };
    for (const input of [matched, value]) {
      const properties = typeof value === "string" && value ? ["color", value] : ["color"];
      const answer = cascadeFor(input, { computedStyle: [{ name: value, value }] }, properties, new Map([[typeof value === "string" ? value : "sheet", { url: value, origin: value, startLine: value, startColumn: value, isInline: value }]]));
      assertBoundedTree(JSON.parse(JSON.stringify(answer)), id);
      for (const entry of answer) for (const declaration of [entry.winner, ...entry.overridden].filter(Boolean)) assert.equal(typeof declaration.value, "string", id);
      assertBoundedTree(declaredProperties(input), `${id} declared`);
    }
  }
  assert.equal({}.ardiaPolluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

const { parseVerifiedUpdate, readManifest: readWindowsManifest } = await import("../../../packages/expo-windows/src/updater/manifest.ts");

test("windows update manifest and verified update parser refuse every hostile input while passing a valid control", () => {
  const published = "https://github.com/ardia-browser/ardia/releases/download/";
  const sha = "a".repeat(64);
  const goodUrl = `${published}windows-alpha/Ardia-Setup-x64-60.exe`;
  const controlManifest = JSON.stringify({ version: "0.2.48", build: 60, x64: { url: goodUrl, sha256: sha, bytes: 180_000_000 } });
  const controlParsed = readWindowsManifest(controlManifest, published);
  assert.equal(controlParsed?.installers.x64?.url, goodUrl, "positive control manifest passes");
  const controlReply = parseVerifiedUpdate(JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: goodUrl, sha256: sha, bytes: 180_000_000 }), published, 59);
  assert.equal(controlReply.status, "ok", "positive control verified reply passes");

  for (const { id, value } of HOSTILE_VALUES) {
    if (typeof value === "string") {
      assert.equal(readWindowsManifest(value, published), null, `${id} raw manifest`);
      assert.equal(readWindowsManifest(controlManifest, value), null, `${id} publishedUnder`);
      const reply = parseVerifiedUpdate(value, published, 59);
      assert.equal(reply.status, "failed", `${id} raw verified reply`);
    }
    const versionManifest = readWindowsManifest(
      JSON.stringify({ version: value, build: 60, x64: { url: goodUrl, sha256: sha, bytes: 10 } }),
      published,
    );
    if (versionManifest !== null) {
      assert.match(versionManifest.version, /^[0-9][0-9A-Za-z.+-]{0,63}$/, `${id} version manifest`);
    }
    const forgedManifests = [
      JSON.stringify({ version: "0.2.48", build: value, x64: { url: goodUrl, sha256: sha, bytes: 10 } }),
      JSON.stringify({ version: "0.2.48", build: 60, x64: { url: value, sha256: sha, bytes: 10 } }),
      JSON.stringify({ version: "0.2.48", build: 60, x64: { url: goodUrl, sha256: value, bytes: 10 } }),
      JSON.stringify({ version: "0.2.48", build: 60, x64: { url: goodUrl, sha256: sha, bytes: value } }),
    ];
    for (const candidate of forgedManifests) {
      assert.equal(readWindowsManifest(candidate, published), null, `${id} manifest ${candidate.slice(0, 80)}`);
    }
    const suffixManifest = readWindowsManifest(
      JSON.stringify({ version: "0.2.48", build: 60, x64: { url: typeof value === "string" ? `${published}windows-alpha/${value}.exe` : value, sha256: sha, bytes: 10 } }),
      published,
    );
    if (suffixManifest !== null) {
      assert.match(suffixManifest.installers.x64.url, /^https:\/\/github\.com\/ardia-browser\/ardia\/releases\/download\/windows-alpha\/[0-9A-Za-z][0-9A-Za-z._+-]*\.exe$/, `${id} url suffix`);
    }
    const versionReply = parseVerifiedUpdate(
      JSON.stringify({ status: "ok", version: value, build: 60, url: goodUrl, sha256: sha, bytes: 10 }),
      published,
      59,
    );
    if (versionReply.status === "ok") {
      assert.match(versionReply.version, /^[0-9][0-9A-Za-z.+-]{0,63}$/, `${id} reply version`);
    } else {
      assert.equal(versionReply.status, "failed", `${id} reply version`);
    }
    const forgedReplies = [
      JSON.stringify({ status: "ok", version: "0.2.48", build: value, url: goodUrl, sha256: sha, bytes: 10 }),
      JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: value, sha256: sha, bytes: 10 }),
      JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: goodUrl, sha256: value, bytes: 10 }),
      JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: goodUrl, sha256: sha, bytes: value }),
      JSON.stringify({ status: value }),
    ];
    for (const candidate of forgedReplies) {
      const parsed = parseVerifiedUpdate(candidate, published, 59);
      assert.equal(parsed.status, "failed", `${id} reply ${candidate.slice(0, 80)}`);
    }
    const suffixReply = parseVerifiedUpdate(
      JSON.stringify({ status: "ok", version: "0.2.48", build: 60, url: typeof value === "string" ? `${published}windows-alpha/${value}.exe` : value, sha256: sha, bytes: 10 }),
      published,
      59,
    );
    if (suffixReply.status === "ok") {
      assert.match(suffixReply.installer.url, /^https:\/\/github\.com\/ardia-browser\/ardia\/releases\/download\/windows-alpha\/[0-9A-Za-z][0-9A-Za-z._+-]*\.exe$/, `${id} reply url suffix`);
    } else {
      assert.equal(suffixReply.status, "failed", `${id} reply url suffix`);
    }
  }
  assert.equal({}.ardiaPolluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
