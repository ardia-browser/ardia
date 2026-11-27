import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_VALUES, URL_SCHEMES } from "../../../../../scripts/security/hostile-inputs.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId, engineProfile } = await import("../browser/model.ts");
const { customNewTabUrl } = await import("../settings/settings.ts");
const { runCommand } = await import("../commands/commands.ts");
const { useExtensions } = await import("./store.ts");
const { extensionNewTabPage, setExtensionNewTabLists, LIST_WAIT_MS } = await import("./newTabPage.ts");
const { takeNewTabPageCounts } = await import("../telemetry/newTabPageCounts.ts");
const { setOpeningGate } = await import("../tabs/openingGate.ts");
const { cancelLateNewTabOverride } = await import("../tabs/newTabHome.ts");
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "onboarding");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const shownUrl = (w) => S().tabs[activeTabId(S(), w)].url;
const CADRAN = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
const SPEED_DIAL = "imfeikbeimbfpmgfkkmjekabdehiiajc";
const label = (value) => (typeof value === "string" ? value.slice(0, 80) : typeof value);
const extension = (id, newTabPage, more = {}) => ({ id, name: id, enabled: true, newTabPage, ...more });

function reset(settings = {}, list = []) {
  S().hydrate({});
  S().updateSettings(settings);
  const w = S().createWindow({ url: "https://a.com/" });
  useExtensions.setState({ lists: { [engineProfile(S(), S().windows[w].profileId)]: list } });
  takeNewTabPageCounts();
  return w;
}

test("#1126: an extension's page is a custom New Tab address, so Cadran's page opens on ⌘T", () => {
  const url = `chrome-extension://${CADRAN}/app/app.html`;
  assert.equal(customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl: url }), url);
  assert.equal(customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl: url.replace("chrome-extension", "CHROME-EXTENSION") }), url);
  const w = reset({ newTabUrl: url }, [extension(CADRAN, null)]);
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), url);
  assert.deepEqual(takeNewTabPageCounts(), { new_tab_extension_overrides: 0, new_tab_extension_addresses: 1 });
});

test("#1126: an extension address with a malformed id is still refused", () => {
  for (const newTabUrl of ["chrome-extension://short/app.html", `chrome-extension://${"z".repeat(32)}/app.html`, `chrome-extension://${CADRAN}x/app.html`, "chrome-extension://"]) {
    assert.equal(customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl }), undefined, newTabUrl);
  }
});

test("#1126: an installed extension's chrome_url_overrides.newtab opens on ⌘T, the New Tab row and in a new window", () => {
  const w = reset({}, [extension(SPEED_DIAL, "dial.html")]);
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), `chrome-extension://${SPEED_DIAL}/dial.html`, "⌘T");
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), `chrome-extension://${SPEED_DIAL}/dial.html`, "the New Tab row");
  assert.equal(shownUrl(S().createWindow()), `chrome-extension://${SPEED_DIAL}/dial.html`, "a new window");
  assert.deepEqual(takeNewTabPageCounts(), { new_tab_extension_overrides: 3, new_tab_extension_addresses: 0 });
});

test("#1126: a custom New Tab address wins over an extension's, and Command Bar mode keeps the command bar", () => {
  const w = reset({ newTabUrl: "example.com" }, [extension(SPEED_DIAL, "dial.html")]);
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), "https://example.com");
  const bar = reset({ newTabOpens: "commandBar" }, [extension(SPEED_DIAL, "dial.html")]);
  S().newTab(bar, { newTabCommand: true });
  assert.equal(shownUrl(bar), "");
});

test("#1126: a disabled extension, one without an override and a private window keep the New Tab page", () => {
  const w = reset({}, [extension(CADRAN, null), extension(SPEED_DIAL, "dial.html", { enabled: false })]);
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), "");
  reset({}, [extension(SPEED_DIAL, "dial.html")]);
  const dark = S().createWindow({ kind: "private" });
  S().newTab(dark, { newTabCommand: true });
  assert.equal(shownUrl(dark), "");
});

test("#1126: the override path stays inside its extension, and hostile manifest values open nothing", () => {
  assert.equal(extensionNewTabPage(extension(CADRAN, "/app/app.html")), `chrome-extension://${CADRAN}/app/app.html`);
  assert.equal(extensionNewTabPage(extension(CADRAN, "index.html#home")), `chrome-extension://${CADRAN}/index.html#home`);
  const prefix = `chrome-extension://${CADRAN}/`;
  const insideItsExtension = (url) => url.startsWith(prefix) && new URL(url).href.startsWith(prefix) && new URL(url).host === CADRAN && !/[\s\\]/.test(url);
  const hostile = [...HOSTILE_VALUES.map(({ value }) => value), ...Object.values(URL_SCHEMES), "https://evil.example/", `chrome-extension://${SPEED_DIAL}/dial.html`, "//evil.example/x.html"];
  for (const value of hostile) {
    const url = extensionNewTabPage(extension(CADRAN, value));
    assert.ok(url === undefined || insideItsExtension(url), `${label(value)} -> ${url}`);
  }
  const refused = [...Object.values(URL_SCHEMES).filter((url) => typeof url === "string" && /^\s*[a-z][\w+.-]*:/i.test(url)), "../other/page.html", "app/../../page.html", "./page.html", "app//page.html", "", "/", "https://evil.example/", "javascript:alert(1)", `chrome-extension://${SPEED_DIAL}/dial.html`, "a b.html", "a\\b.html", "a\nb.html", "a".repeat(2000)];
  for (const value of refused) assert.equal(extensionNewTabPage(extension(CADRAN, value)), undefined, label(value));
  for (const id of [...HOSTILE_VALUES.map(({ value }) => value), "short", `${CADRAN}/x`, CADRAN.toUpperCase()]) assert.equal(extensionNewTabPage(extension(id, "dial.html")), undefined, label(id));
  const w = reset({}, refused.map((value, i) => extension(CADRAN.slice(0, 31) + "abcdefghijklmnop"[i % 16], value)));
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), "", "the sink: no new tab opens a hostile override");
});

test("#1126: a custom extension address opens only while that extension is installed and enabled in the profile, and never in a private window", () => {
  const url = `chrome-extension://${CADRAN}/app/app.html`;
  const disabled = reset({ newTabUrl: url }, [extension(CADRAN, null, { enabled: false })]);
  S().newTab(disabled, { newTabCommand: true });
  assert.equal(shownUrl(disabled), "", "disabled");
  const uninstalled = reset({ newTabUrl: url }, [extension(SPEED_DIAL, "dial.html")]);
  S().newTab(uninstalled, { newTabCommand: true });
  assert.equal(shownUrl(uninstalled), "", "uninstalled: its address falls back to the New Tab page, not to another extension's page");
  reset({ newTabUrl: url }, [extension(CADRAN, null)]);
  const dark = S().createWindow({ kind: "private" });
  assert.equal(shownUrl(dark), "", "a private window's first tab");
  S().newTab(dark, { newTabCommand: true });
  assert.equal(shownUrl(dark), "", "⌘T in a private window");
  reset({ newTabUrl: "https://home.example/" }, []);
  assert.equal(shownUrl(S().createWindow({ kind: "private" })), "https://home.example/", "a web address still opens in private windows, as before");
});

test("#1126: a profile's first window, opened before its extension list has loaded, shows the extension's page once the list arrives", () => {
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  useExtensions.setState({ lists: {} });
  const first = S().createWindow();
  assert.equal(shownUrl(first), "", "no list yet: the New Tab page");
  const typed = S().createWindow();
  S().navigate(activeTabId(S(), typed), "https://typed.example/");
  useExtensions.setState({ lists: { [profile]: [extension(SPEED_DIAL, "dial.html")] } });
  assert.equal(shownUrl(first), `chrome-extension://${SPEED_DIAL}/dial.html`, "the untouched first tab moves to the extension's page");
  assert.equal(shownUrl(typed), "https://typed.example/", "a first tab the user already navigated is left alone");
  assert.equal(takeNewTabPageCounts().new_tab_extension_overrides, 1);
});

test("#1126: a list that arrives long after the window opened leaves its first tab on the New Tab page", () => {
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  useExtensions.setState({ lists: {} });
  const late = S().createWindow();
  setExtensionNewTabLists({ [profile]: [extension(SPEED_DIAL, "dial.html")] }, Date.now() + LIST_WAIT_MS + 1);
  assert.equal(shownUrl(late), "");
});

test("#1126: with several New Tab extensions, Chromium's order wins: the newest not yet in its preferences, then its first active entry, not the name", () => {
  const w = reset({}, [extension(CADRAN, "cadran.html", { newTabRank: 1 }), extension(SPEED_DIAL, "dial.html", { newTabRank: 0 })]);
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), `chrome-extension://${SPEED_DIAL}/dial.html`, "rank 0 beats the alphabetically first");
  const fresh = reset({}, [extension(CADRAN, "cadran.html", { newTabRank: 0 }), extension(SPEED_DIAL, "dial.html")]);
  S().newTab(fresh, { newTabCommand: true });
  assert.equal(shownUrl(fresh), `chrome-extension://${SPEED_DIAL}/dial.html`, "an override Chromium hasn't written to Preferences yet is the newest install");
});

test("#1126: a ⌘T tab waiting for its profile's list gets its own profile's page, even after the window switched to another profile", () => {
  const w = reset({}, []);
  const home = S().windows[w].profileId;
  const work = S().createProfile({ name: "Work" });
  useExtensions.setState({ lists: {} });
  const id = S().newTab(w, { newTabCommand: true });
  assert.equal(S().tabs[id].profileId, home);
  S().switchProfile(w, work);
  useExtensions.setState({ lists: { [engineProfile(S(), home)]: [extension(SPEED_DIAL, "dial.html")], [engineProfile(S(), work)]: [extension(CADRAN, "cadran.html")] } });
  assert.equal(S().tabs[id].url, `chrome-extension://${SPEED_DIAL}/dial.html`, "the Default tab opens Default's page, not Work's");
});

test("#1126: the late extension page leaves a tab alone while the command bar is open over it", () => {
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  useExtensions.setState({ lists: {} });
  const id = S().newTab(w, { newTabCommand: true });
  S().openPanel(w, "typing");
  useExtensions.setState({ lists: { [profile]: [extension(SPEED_DIAL, "dial.html")] } });
  assert.equal(S().tabs[id].url, "", "the command bar keeps what the user is typing");
  S().closePanel(w);
});

test("#1126: the late extension page leaves a tab alone while its typed address waits on a tab.opening rule", () => {
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  useExtensions.setState({ lists: {} });
  const id = S().newTab(w, { newTabCommand: true });
  let answer;
  setOpeningGate(() => new Promise((resolve) => (answer = resolve)));
  try {
    S().navigate(id, "https://typed.example/");
    assert.equal(S().tabs[id].url, "", "the typed address is still waiting on the rule");
    useExtensions.setState({ lists: { [profile]: [extension(SPEED_DIAL, "dial.html")] } });
    assert.equal(S().tabs[id].url, "", "the extension page doesn't take the tab, or cancel the typed address");
  } finally {
    answer?.(null);
    setOpeningGate(null);
  }
});

test("#1126: an older New Tab extension turned back on keeps its place in Chromium's order instead of counting as the newest install", () => {
  const reenabledOlder = extension(CADRAN, "cadran.html", { newTabRank: 1 });
  const w = reset({}, [reenabledOlder, extension(SPEED_DIAL, "dial.html", { newTabRank: 0 })]);
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), `chrome-extension://${SPEED_DIAL}/dial.html`, "Chromium's first entry still wins");
  const unranked = reset({}, [extension(CADRAN, "cadran.html"), extension(SPEED_DIAL, "dial.html", { newTabRank: 0 })]);
  S().newTab(unranked, { newTabCommand: true });
  assert.equal(shownUrl(unranked), `chrome-extension://${CADRAN}/cadran.html`, "only an entry missing from Preferences counts as newest, so the Mac ranks every entry it lists, active or not");
});

test("#1126: typing in the New Tab page's search field cancels the late extension page, so the draft stays", () => {
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  useExtensions.setState({ lists: {} });
  const drafting = S().newTab(w, { newTabCommand: true });
  const untouched = S().newTab(w, { newTabCommand: true, background: true });
  cancelLateNewTabOverride(drafting);
  useExtensions.setState({ lists: { [profile]: [extension(SPEED_DIAL, "dial.html")] } });
  assert.equal(S().tabs[drafting].url, "", "the tab with a draft keeps the New Tab page");
  assert.equal(S().tabs[untouched].url, `chrome-extension://${SPEED_DIAL}/dial.html`, "another waiting tab still gets the page");
});

test("#1126: a right-click Paste, Cut or Delete in the New Tab search field, and every other draft edit, cancels the late extension page; moving the selection doesn't", async () => {
  globalThis.require ??= (id) => ({ asset: id });
  const { cancelsLateOverride } = await import("../../components/omnibox/useBarText.ts");
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  const edits = [
    { kind: "edited", text: "pasted draft", caret: 12 },
    { kind: "typed", text: "a", suppress: false, selected: 0 },
    { kind: "caretAccepted", text: "ab" },
    { kind: "tabAccepted", text: "ab" },
    { kind: "calculated", text: "4" },
    { kind: "completionDropped" },
    { kind: "enteredScope", scope: { kind: "history" }, from: "" },
    { kind: "leftScope", restore: null },
    { kind: "reset" },
  ];
  const moves = [{ kind: "selected", index: 1 }, { kind: "select", selection: { start: 0, end: 1 } }, { kind: "selectionApplied" }];
  for (const event of [...edits, ...moves]) {
    useExtensions.setState({ lists: {} });
    const id = S().newTab(w, { newTabCommand: true });
    const reduced = [];
    cancelsLateOverride(true, id, (e) => reduced.push(e))(event);
    cancelsLateOverride(false, "elsewhere", () => {})(event);
    useExtensions.setState({ lists: { [profile]: [extension(SPEED_DIAL, "dial.html")] } });
    assert.deepEqual(reduced, [event], `${event.kind} still reaches the bar`);
    const keepsDraft = edits.includes(event);
    assert.equal(S().tabs[id].url, keepsDraft ? "" : `chrome-extension://${SPEED_DIAL}/dial.html`, event.kind);
  }
  const { readFileSync } = await import("node:fs");
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../../components/omnibox/useBarText.ts"), /useState\(\(\) => cancelsLateOverride\(hero, tabId, reduce\)\)/, "the bar's only dispatch is the one that cancels");
  assert.match(read("../../components/omnibox/Omnibox.tsx"), /if \(pick\?\.kind === "edit"\) \{\s*previewSelection\.edited\(\);\s*dispatch\(\{ kind: "edited"/, "the field menu's Paste, Cut and Delete go through that dispatch as an edited event");
});

test("#1126: picking Paste in the New Tab search field's menu cancels the late extension page before the clipboard read finishes", async () => {
  const { shellNativeModules } = await import("../../test-native/index.ts");
  const { showFieldMenu } = await import("../omnibox/paste.ts");
  const shell = shellNativeModules.ArdiaShell;
  const menus = shellNativeModules.ArdiaMenus;
  const realRead = shell.readText;
  const realMenu = menus.showMenu;
  const w = reset({}, []);
  const profile = engineProfile(S(), S().windows[w].profileId);
  useExtensions.setState({ lists: {} });
  const pasting = S().newTab(w, { newTabCommand: true });
  const unguarded = S().newTab(w, { newTabCommand: true, background: true });
  let reads = 0;
  let finishRead;
  let readStarted;
  const started = new Promise((resolve) => (readStarted = resolve));
  shell.readText = () => (++reads === 1 ? Promise.resolve("pasted words") : (readStarted(), new Promise((resolve) => (finishRead = resolve))));
  menus.showMenu = () => Promise.resolve("paste");
  try {
    const picked = showFieldMenu("", { current: { start: 0, end: 0 } }, null, () => cancelLateNewTabOverride(pasting));
    await started;
    useExtensions.setState({ lists: { [profile]: [extension(SPEED_DIAL, "dial.html")] } });
    finishRead("pasted words");
    assert.deepEqual(await picked, { kind: "edit", text: "pasted words", caret: 12 });
    assert.equal(S().tabs[pasting].url, "", "the list arrived during the clipboard read and left the pasting tab alone");
    assert.equal(S().tabs[unguarded].url, `chrome-extension://${SPEED_DIAL}/dial.html`, "without the pick callback the late page would have taken the tab");
  } finally {
    shell.readText = realRead;
    menus.showMenu = realMenu;
  }
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../../components/omnibox/Omnibox.tsx", import.meta.url), "utf8"), /showFieldMenu\(value, selection, shownUrl, \(\) => hero && cancelLateNewTabOverride\(tabId\)\)/);
});
