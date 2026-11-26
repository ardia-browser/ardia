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
const { checkedInput, isKeyName, MAX_TEXT_LENGTH } = await import("./state/automation/tabInput.ts");
const { MAX_MESSAGE_LENGTH } = await import("./state/automation/tabDiagnostics.ts");
const { updateWithin } = await import("./state/plugins/officialUpdate.ts");
const { readManifest } = await import("./lib/pluginManifest.ts");
const { parseIntent, INTENT_SPECS } = await import("./state/plugins/stateIntents.ts");
const { pluginStateUrl, redactedTabs } = await import("./state/plugins/pluginEventRedaction.ts");
const { copyLinkFromPageMenu } = await import("./state/site/pageLinkCopy.ts");
const { extensionSitePattern } = await import("./state/extensions/sitePatterns.ts");
const { cleanUrl } = await import("@ardia/core");
const { drainPassages } = await import("./state/site/translateDrain.ts");
const { translatePack } = await import("./state/site/translate.ts");
const { FakeElement, FakeText, fakePage: fakeTranslatorPage } = await import("./state/site/fixtures/translatorPage.mjs");

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

test("windows webui native update policy keeps every hostile input and call argument away from the installer download, launch and claim gates while passing valid controls", (t) => {
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const { fileURLToPath } = process.getBuiltinModule("node:url");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const compiler = ["c++", "clang++", "g++"].find((name) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0);
  if (!compiler) {
    if (process.env.CI) assert.fail("no C++ compiler to build scripts/windows/engine/tests/webui_update_policy_test.cc");
    return t.skip("no C++ compiler");
  }
  const scratch = mkdtempSync(join(tmpdir(), "ardia-update-policy-"));
  try {
    const binary = join(scratch, "webui_update_policy_test");
    const build = spawnSync(compiler, ["-std=c++20", "-I", join(repo, "scripts/windows/engine/src"), join(repo, "scripts/windows/engine/tests/webui_update_policy_test.cc"), "-o", binary], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const describe = (value) => {
      if (value === null || value === undefined) return "z:";
      if (typeof value === "boolean") return "b:";
      if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) <= 2 ** 31 - 1 ? `i:${value}` : `d:${value}`;
      if (typeof value === "string") return `s:${Buffer.from(value, "utf8").toString("hex")}`;
      return Array.isArray(value) ? "a:" : "o:";
    };
    const wire = (value) => JSON.parse(JSON.stringify({ args: value }) ?? "{}").args;
    const lines = HOSTILE_VALUES.map(({ value }) => {
      const single = JSON.parse(JSON.stringify([value]))[0];
      const args = wire(value);
      const whole = args === undefined ? "O" : Array.isArray(args) ? `L${args.map(describe).join(",")}` : "N";
      return `${describe(single)}|${whole}`;
    });
    const strings = HOSTILE_VALUES.filter(({ value }) => typeof JSON.parse(JSON.stringify([value]))[0] === "string").length;
    assert.ok(strings >= HOSTILE_STRINGS.length);
    const corpus = join(scratch, "hostile.txt");
    writeFileSync(corpus, lines.join("\n") + "\n");
    const run = spawnSync(binary, ["--hostile", corpus], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, new RegExp(`hostile: ${HOSTILE_VALUES.length} values, ${strings} strings, ${strings * 33} answers, \\d+ reached the download gate with a valid offer, ${HOSTILE_VALUES.length * 18} calls, \\d+ reached a call sink with a valid request, controls reached them`));
    const unit = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(unit.status, 0, unit.stderr || unit.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("#650: a clipboard another app filled reaches the address field only as one line of plain text, and a file address only as a file: URL", async (t) => {
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const { fileURLToPath } = process.getBuiltinModule("node:url");
  if (process.platform !== "darwin") return t.skip("AppKit pasteboards are macOS only");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const field = readFileSync(join(repo, "node_modules/react-native-macos/Libraries/Text/TextInput/Singleline/RCTUITextField.mm"), "utf8");
  const from = field.indexOf("static NSString *RCTUISingleLinePastedText(");
  const to = field.indexOf("@interface RCTUIPlainPasteFieldEditor");
  assert.ok(from > 0 && to > from && field.slice(from, to).includes("RCTUIPlainTextOfRichPasteboard"), "the patched field editor's paste helpers");
  const scratch = mkdtempSync(join(tmpdir(), "ardia-paste-"));
  const { createServer } = process.getBuiltinModule("node:net");
  let fetched = 0;
  const server = createServer((socket) => {
    fetched++;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const probe = join(scratch, "probe.mm");
    writeFileSync(
      probe,
      `#import <AppKit/AppKit.h>
${field.slice(from, to)}
int main(int argc, char **argv) {
  @autoreleasepool {
    NSArray<NSString *> *values = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(argv[1])] options:0 error:nil];
    NSMutableArray *answers = [NSMutableArray array];
    for (NSString *value in values) {
      for (NSString *kind in @[ @"html", @"rtf", @"file" ]) {
        NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
        [board clearContents];
        NSPasteboardItem *item = [NSPasteboardItem new];
        if ([kind isEqualToString:@"html"]) {
          NSString *escaped = [[value stringByReplacingOccurrencesOfString:@"&" withString:@"&amp;"] stringByReplacingOccurrencesOfString:@"<" withString:@"&lt;"];
          [item setData:[[NSString stringWithFormat:@"<p>%@</p>", escaped] dataUsingEncoding:NSUTF8StringEncoding] forType:NSPasteboardTypeHTML];
        } else if ([kind isEqualToString:@"rtf"]) {
          NSAttributedString *rich = [[NSAttributedString alloc] initWithString:value];
          [item setData:[rich RTFFromRange:NSMakeRange(0, rich.length) documentAttributes:@{}] forType:NSPasteboardTypeRTF];
        } else {
          [item setString:value forType:NSPasteboardTypeFileURL];
        }
        [board writeObjects:@[ item ]];
        NSString *text = RCTUIPlainTextOfRichPasteboard(board);
        [answers addObject:@{@"kind" : kind, @"out" : text ? RCTUISingleLinePastedText(text) : NSNull.null}];
        [board releaseGlobally];
      }
    }
    NSMutableArray *encoded = [NSMutableArray array];
    NSArray *declared = @[
      @[ @"<meta charset=\\"iso-2022-jp\\"><p>日本語のテキスト</p>", @(NSISO2022JPStringEncoding) ],
      @[ @"<meta http-equiv=\\"Content-Type\\" content=\\"text/html; charset=windows-1252\\"><p>Â£ café</p>", @(NSWindowsCP1252StringEncoding) ],
      @[ @"<p>charset café 日本 🙂</p>", @(NSUTF8StringEncoding) ],
      @[ @"<link rel=\\"stylesheet\\" href=\\"http://127.0.0.1:${port}/c\\"><img src=\\"http://127.0.0.1:${port}/i\\"><p style=\\"background:url(http://127.0.0.1:${port}/b)\\">offline</p><script>never</script>", @(NSUTF8StringEncoding) ],
    ];
    for (NSArray *fixture in declared) {
      NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
      [board clearContents];
      NSPasteboardItem *item = [NSPasteboardItem new];
      [item setData:[fixture[0] dataUsingEncoding:[fixture[1] unsignedIntegerValue]] forType:NSPasteboardTypeHTML];
      [board writeObjects:@[ item ]];
      NSString *text = RCTUIPlainTextOfRichPasteboard(board);
      [encoded addObject:text ? RCTUISingleLinePastedText(text) : NSNull.null];
      [board releaseGlobally];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"answers" : answers, @"encoded" : encoded} options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
`,
    );
    const binary = join(scratch, "probe");
    const build = spawnSync("xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-w", "-framework", "AppKit", probe, "-o", binary], { encoding: "utf8" });
    if (build.error?.code === "ENOENT") return t.skip("no clang here");
    assert.equal(build.status, 0, build.stderr);
    const controls = ["café 日本 🙂", "file:///tmp/report%20final.pdf", "javascript:alert(1)", "https://ardia-fixture.invalid/"];
    const hostile = HOSTILE_STRINGS.map(({ value }) => value).filter((value) => value.isWellFormed());
    assert.ok(hostile.length >= HOSTILE_STRINGS.length - 4, "lone surrogates are the only strings a pasteboard can't hold");
    const values = [...controls, ...hostile];
    const corpus = join(scratch, "values.json");
    writeFileSync(corpus, JSON.stringify(values));
    const run = spawnSync(binary, [corpus], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    const { answers, encoded } = JSON.parse(run.stdout);
    assert.deepEqual(encoded, ["日本語のテキスト", "Â£ café", "charset café 日本 🙂", "offline"], "HTML keeps the charset it declares, UTF-8 is the fallback, and script text is dropped");
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetched, 0, "turning pasted HTML into text loads nothing it names");
    assert.equal(answers.length, values.length * 3);
    const answer = (i, kind) => answers[i * 3 + ["html", "rtf", "file"].indexOf(kind)].out;
    assert.equal(answer(0, "html"), "café 日本 🙂");
    assert.equal(answer(0, "rtf"), "café 日本 🙂");
    assert.equal(answer(1, "file"), "file:///tmp/report%20final.pdf");
    assert.equal(answer(2, "file"), null);
    assert.equal(answer(3, "file"), null);
    for (const [i, value] of values.entries()) {
      for (const kind of ["html", "rtf", "file"]) {
        const out = answer(i, kind);
        if (out === null) continue;
        assert.equal(typeof out, "string", `${kind} ${show(value)}`);
        assert.doesNotMatch(out, /[\r\n\u000b\u000c\u0085\u2028\u2029\ufffc]/, `${kind} ${show(value)} pastes one line with no attachment: ${JSON.stringify(out)}`);
        if (kind === "file") assert.match(out, /^file:/, `${show(value)} as a file address`);
      }
    }
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a synced pinned tile's letters are at most two visible characters, whatever the record holds", async () => {
  const { pinnedLettersAdapter } = await import("./state/sync/pinnedLettersAdapter.ts");
  const { cleanTileLetters, TILE_LETTERS_MAX, TILE_LETTERS_MAX_LENGTH } = await import("./lib/tileLetter.ts");
  const { graphemeClusters } = await import("./lib/graphemes.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://tile.example/" });
  const id = S().windows[w].tabIds[0];
  S().pinTabs([id], true);
  const profileId = S().tabs[id].profileId;
  const adapter = pinnedLettersAdapter(profileId);
  const key = `plet:${S().tabs[id].pinKey ?? id}`;
  const records = { known: () => true, defer: () => {}, landed: () => {}, held: () => false, now: 0, horizon: 0, joined: true };
  const apply = (value) => adapter.apply(new Map([[key, value]]), new Set([key]), () => undefined, records);
  apply("Ab");
  assert.equal(S().tabs[id].tileLetters, "AB", "positive control: plain letters land");
  for (const { value } of HOSTILE_VALUES) {
    apply(value);
    const letters = S().tabs[id].tileLetters;
    if (letters === undefined) continue;
    assert.equal(typeof letters, "string");
    assert.ok(!/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\s]/u.test(letters.replace(/[\u200C\u200D\u{E0020}-\u{E007F}]/gu, "")) && !/(?![\u200C\u200D\u{E0020}-\u{E007F}])\p{Cf}/u.test(letters), JSON.stringify(letters));
    assert.ok(letters.length <= TILE_LETTERS_MAX_LENGTH && graphemeClusters(letters).length <= TILE_LETTERS_MAX, JSON.stringify(letters));
    assert.equal(cleanTileLetters(letters), letters, "what lands is already clean, so it doesn't change on the next sync");
  }
});

test("socket tabs.input: every hostile value reaches the engine only as a checked action, point, key or text", () => {
  for (const value of HOSTILE_VALUES.map((h) => h.value)) {
    for (const params of [{ action: value, x: 1, y: 1 }, { action: "click", x: value, y: 1 }, { action: "key", key: value }, { action: "key", key: "a", code: value }, { action: "text", text: value }, { action: "click", x: 1, y: 1, modifiers: [value] }]) {
      let out;
      try {
        out = checkedInput(params);
      } catch (error) {
        assert.equal(error.code, "bad_request", show(params));
        continue;
      }
      if (out.key !== undefined) assert.ok(isKeyName(out.key), show(params));
      if (out.text !== undefined) assert.ok(typeof out.text === "string" && out.text.length <= MAX_TEXT_LENGTH && !out.text.includes("\0"), show(params));
      if (out.x !== undefined) assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y), show(params));
    }
  }
});

const { startAutomation } = await import("./state/automation/controlSocket.ts");

test("socket tabs.diagnostics: a hostile page's console text and addresses leave the socket sink redacted and bounded", async () => {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = activeTabId(S(), w);
  let nextId = 700;
  const conn = 88;
  const socketCall = async (method, params) => {
    const id = ++nextId;
    const before = stub.controlSocket.replies.length;
    stub.emitControlRequest({ connection: conn, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
    for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === conn); i++) await tick();
    const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === conn);
    assert.equal(replies.length, 1);
    return JSON.parse(replies[0].line);
  };
  let nextReply = null;
  globalThis.acTestTabDiagnostics = () => nextReply;
  try {
    nextReply = {
      ok: true,
      console: [{ seq: 1, time: 10, level: "error", message: 'plain token=supersecret123 {"authToken":"abc"}', source: "https://user:pw@a.example/app.js?k=1#h", line: 4, frame: "main" }],
      network: [{ seq: 2, time: 11, method: "GET", url: "https://user:pw@a.example/api?q=secret#f", status: 404, type: "fetch", frame: "main", failed: true }],
      nextSeq: 3,
      clearedBefore: 1,
      capacity: { console: 200, network: 250 },
    };
    const control = await socketCall("tabs.diagnostics", { tab });
    assert.equal(control.error, undefined, "positive control reaches the socket sink");
    assert.equal(control.result.console[0].message, 'plain token=[redacted] {"authToken":"[redacted]"}');
    assert.equal(control.result.console[0].source, "https://a.example/app.js");
    assert.equal(control.result.network[0].url, "https://a.example/api");

    for (const value of strings) {
      const part = value.isWellFormed() ? encodeURIComponent(value) : value;
      nextReply = {
        ok: true,
        console: [{ seq: 1, time: 10, level: "error", message: `token=${value} ${value}`, source: `https://user:pw@a.example/${part}?q=${part}#${part}`, line: 1, frame: "main" }],
        network: [{ seq: 2, time: 11, method: value, url: `https://user:pw@a.example/${part}?q=${part}#${part}`, status: 200, type: value, error: value, frame: "main", failed: false }],
        nextSeq: 3,
        clearedBefore: 1,
        capacity: { console: 200, network: 250 },
      };
      const reply = await socketCall("tabs.diagnostics", { tab });
      assert.equal(reply.error, undefined, show(value));
      const row = reply.result.console[0];
      const net = reply.result.network[0];
      assert.equal(typeof row.message, "string", show(value));
      assert.ok(row.message.length <= MAX_MESSAGE_LENGTH, show(value));
      if (/^[\w.~+/-]+$/.test(value) && value !== "redacted") assert.ok(row.message.startsWith("token=[redacted]"), show(value));
      for (const addr of [row.source, net.url]) assert.ok(addr.startsWith("https://a.example/") && !addr.includes("?") && !addr.includes("#") && !addr.includes("pw@"), show(value));
      assert.ok(net.method.length <= 16 && net.type.length <= 32 && net.error.length <= 64, show(value));
    }

    for (const { id, value } of HOSTILE_VALUES) {
      nextReply = {
        ok: true,
        console: [{ seq: 1, time: value, level: value, message: value, source: value, line: value, frame: value }],
        network: [{ seq: 2, time: value, method: value, url: value, status: value, type: value, durationMs: value, error: value, frame: value, failed: value }],
        nextSeq: 3,
        clearedBefore: 1,
        capacity: { console: 200, network: 250 },
      };
      const reply = await socketCall("tabs.diagnostics", { tab });
      assert.equal(reply.error, undefined, id);
      const row = reply.result.console[0];
      const net = reply.result.network[0];
      assert.ok(["debug", "info", "warning", "error"].includes(row.level), id);
      assert.ok(typeof row.message === "string" && row.message.length <= MAX_MESSAGE_LENGTH, id);
      assert.ok(typeof row.source === "string" && typeof net.url === "string", id);
      assert.ok(Number.isFinite(row.time) && Number.isFinite(row.line) && Number.isFinite(net.status), id);
      for (const field of ["since", "kind", "onlyErrors", "limit", "clear"]) {
        const bad = await socketCall("tabs.diagnostics", { tab, [field]: value });
        if (bad.error) assert.equal(bad.error.code, "bad_request", `${id} ${field}`);
      }
    }
    assert.equal({}.ardiaPolluted, undefined);
    assert.equal(Object.prototype.ardiaPolluted, undefined);
  } finally {
    delete globalThis.acTestTabDiagnostics;
  }
});

test("a tab a page opened moves engines only when its page answers the opener check with false, whatever else it returns", async () => {
  const { followSiteChoice } = await import("./state/engines/siteMoves.ts");
  const { notePageMadeTab, openerAnswer } = await import("./state/engines/openedPages.ts");
  const { tabEngine } = await import("./state/engines/engines.ts");
  const { dropSwap } = await import("./state/engines/engineSwap.ts");
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true, engineMode: "automatic", websiteEngines: {} });
  const w = S().createWindow({ url: "https://blog.example/" });
  const opener = activeTabId(S(), w);
  S().updateTab(opener, { engine: "chromium", url: "https://blog.example/" });
  const asked = new Map();
  const probes = new Set();
  const plant = (value) => {
    const tab = S().newTab(w, { url: "https://www.netflix.com/", adoptId: "ardiacore:9", openerId: opener, background: true });
    webviews.set(tab, {
      evaluate: async (script) => {
        if (script.includes("window.opener")) probes.add(script);
        asked.set(tab, { count: (asked.get(tab)?.count ?? 0) + 1, at: Date.now() });
        return value;
      },
      pageCookies: async () => [],
    });
    S().updateTab(tab, { url: "https://www.netflix.com/" });
    notePageMadeTab(tab);
    followSiteChoice(tab, "chromium", "https://www.netflix.com/", "");
    return tab;
  };
  const planted = HOSTILE_VALUES.filter(({ value }) => value !== false).map(({ id, value }) => ({ id, tab: plant(value) }));
  const control = plant(false);
  const settled = (tab) => (asked.get(tab)?.count ?? 0) > 0 && Date.now() - asked.get(tab).at > 800;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(tabEngine(S(), control) === "webkit" && planted.every(({ tab }) => settled(tab)))) await wait(50);
  for (const { id, tab } of planted) assert.ok(settled(tab), `${id} stopped asking`);
  for (const { id, tab } of planted) assert.equal(S().tabs[tab].engine === "webkit", false, id);
  assert.equal(tabEngine(S(), control), "webkit", "positive control: a page that answers false moves");
  for (const { id, value } of HOSTILE_VALUES) assert.equal(openerAnswer(value), value === true ? "live" : value === false ? "none" : "unknown", id);
  assert.equal(probes.size, 1);
  const [probe] = probes;
  assert.doesNotMatch(probe, /JSON|String|toString|valueOf|Object|Reflect|\.call|\.apply|Symbol/, "the probe calls nothing a page can replace");
  dropSwap(control);
  webviews.clear();
});

test("an Add Site entry reaches the engine only as an http(s) host pattern, whatever text it started as", () => {
  const SITE = /^(\*|https?):\/\/(\*\.)?([a-z0-9_-]+(\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(:[1-9]\d{0,4})?\/\*$/;
  assert.equal(extensionSitePattern("https://example.com/path"), "https://example.com/*", "the positive control runs");
  for (const value of [...strings, ...strings.map((h) => `https://example.com/${h}`), ...strings.map((h) => `${h}example.com`), ...Object.values(URL_SCHEMES).flat().filter((x) => typeof x === "string")]) {
    const site = extensionSitePattern(value);
    assert.ok(site === null || (SITE.test(site) && !LINE_TERMINATORS.test(site) && site.length <= 2048), show(value));
  }
});

const translatorFixture = () => {
  const texts = [new FakeText("Hauptseite"), new FakeText("Lies die "), new FakeText("Hinweise"), new FakeText("Ein Absatz mit genug Text.")];
  const untouched = new FakeText("Nicht angeboten");
  const link = new FakeElement("a", [texts[2]]);
  const body = new FakeElement("body", [new FakeElement("li", [texts[0]]), new FakeElement("p", [texts[1], link]), new FakeElement("p", [texts[3]])]);
  const page = fakeTranslatorPage(body);
  const shape = (node) => (node.nodeType === 3 ? "#text" : [node.tagName, ...node.childNodes.map(shape)]);
  return { page, texts, untouched, before: JSON.stringify(shape(body)), shape: () => JSON.stringify(shape(body)) };
};

const drainTranslatorPage = (page, model, next) =>
  drainPassages({
    inFlight: 2,
    holds: () => true,
    released: new Promise(() => {}),
    next: next ?? (async (maxChars) => page.call("next", "t", 24, maxChars)),
    translate: (pack) => translatePack(model, "de", "en", pack, "t", { unlinked: 0, failed: 0 }, () => true),
    apply: async (results) => page.call("apply", "t", results),
  }).catch(() => false);

test("T1: whatever the translation model answers, the page only gets text in the nodes it offered", async () => {
  for (const { id, value } of HOSTILE_VALUES) {
    const { page, texts, before, shape } = translatorFixture();
    page.call("start", "t");
    const model = { translateBlocks: async (_s, _t, blocks) => blocks.map((pieces) => pieces.map(() => value)) };
    await drainTranslatorPage(page, model);
    assert.equal(shape(), before, id);
    for (const node of texts) {
      assert.equal(typeof node.nodeValue, "string", id);
      if (typeof value !== "string") assert.ok(["Hauptseite", "Lies die ", "Hinweise", "Ein Absatz mit genug Text."].includes(node.nodeValue), `${id}: ${show(node.nodeValue)}`);
    }
  }
});

test("T2: a pack answer that doesn't map back, in length or shape, leaves those nodes as they were", async () => {
  const answers = [() => null, () => [], (pieces) => [...pieces, "extra"], (pieces) => pieces.slice(1), () => "Main page", () => ({ 0: "Main page" }), () => [42]];
  for (const answer of answers) {
    const { page, texts } = translatorFixture();
    page.call("start", "t");
    const model = { translateBlocks: async (_s, _t, blocks) => blocks.map((pieces) => answer(pieces)) };
    await drainTranslatorPage(page, model);
    for (const node of texts) assert.equal(typeof node.nodeValue, "string", show(answer([])));
    assert.notEqual(texts[0].nodeValue, "extra", show(answer(["x"])));
  }
});

test("T3: whatever the page hands over as passages, the model only gets numbered strings and the page's own nodes only text", async () => {
  for (const { id, value } of HOSTILE_VALUES) {
    const { page, texts, untouched, before, shape } = translatorFixture();
    page.call("start", "t");
    const seen = [];
    const model = {
      translateBlocks: async (_s, _t, blocks) => {
        seen.push(blocks);
        return blocks.map((pieces) => pieces.map((p) => `EN ${p}`));
      },
    };
    let handed = 0;
    const next = async (maxChars) => (handed++ ? page.call("next", "t", 24, maxChars) : { passages: [value, [1, value], [2, [[3, value], value]], [value, [[4, "x"]]]], more: true, gone: false, done: 1, total: 2 });
    await drainTranslatorPage(page, model, next);
    for (const blocks of seen) for (const pieces of blocks) for (const piece of pieces) assert.equal(typeof piece, "string", id);
    assert.equal(shape(), before, id);
    assert.equal(untouched.nodeValue, "Nicht angeboten", id);
    for (const node of texts) assert.equal(typeof node.nodeValue, "string", id);
  }
});
