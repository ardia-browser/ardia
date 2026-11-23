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

test("a credential plugin's verb request becomes only a checked argv: every hostile value is refused or lands as one inert token", async () => {
  const { readCredentialContribution } = await import("@ardia/plugin-sdk/credential-manifest");
  const { buildVerb, deniedCommand } = await import("@ardia/plugin-sdk/testing");
  const manifest = JSON.parse(readFileSync(new URL("../../../tests/fixtures/plugins/credential-providers/bitwarden.json", import.meta.url), "utf8"));
  const cli = readCredentialContribution(manifest).cli;
  const session = { $secret: "h1" };
  const requests = (value) => [
    ["login.password", { email: value, password: session }],
    ["login.password", { email: "sam@example.com", password: session, code: value }],
    ["login.password", { email: "sam@example.com", password: session, method: value }],
    ["get.item", { session, id: value }],
    ["config.server.url", { url: value }],
    ["status", { session: value }],
    ...(typeof value === "string" ? [["get.item", { session, id: "11111111-2222-3333-4444-555555555555", [value]: "x" }]] : []),
  ];
  let launched = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    for (const [verb, params] of requests(value)) {
      const built = buildVerb(cli, verb, params, () => "session-value", null);
      if (!("launch" in built)) {
        assert.ok(built.code && built.message, `${id} via ${verb}: refused with a code`);
        continue;
      }
      launched += 1;
      for (const token of built.launch.argv) {
        assert.ok(typeof token === "string" && !token.includes("\0") && !LINE_TERMINATORS.test(token), `${id} via ${verb}: ${show(token)}`);
      }
      assert.equal(deniedCommand("bw", built.launch.argv), null, `${id} via ${verb}`);
    }
  }
  assert.ok(launched > 0, "allowed requests still launch, so the refusals aren't the only thing tested");
  const valid = buildVerb(cli, "get.item", { session, id: "11111111-2222-3333-4444-555555555555" }, () => "session-value", null);
  assert.ok("launch" in valid, "a well-formed request launches");
});
