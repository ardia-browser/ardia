import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { useExtensions } = await import("./store.ts");
const { refreshActionStates } = await import("./actionStates.ts");
const panels = await import("./sidePanels.ts");
const { extensionMenuItems } = await import("./actions.ts");

const S = () => useBrowser.getState();
const E = () => useExtensions.getState();
const EXT = { id: "ext", name: "Ext", enabled: true, pinned: true, hasAction: true, incognito: false, sidePanel: "panel.html" };

function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "b.com", background: true });
  usePages.setState({ ready: { [a]: 1, [b]: 2 } });
  useExtensions.setState({ lists: { "": [EXT] }, actions: {}, popup: null, sidePanels: {} });
  const asked = [];
  const ask = (what) => (tabId, _arg, profile) => new Promise((resolve) => asked.push({ what, tabId, profile, resolve }));
  native.extensionAnswers.actionStates = ask("states");
  native.extensionAnswers.sidePanelUrl = ask("panel");
  const answer = async (i, value) => {
    asked[i].resolve(value);
    await new Promise((r) => setImmediate(r));
  };
  return { w, a, b, asked, answer };
}

test("a tab switch while a tab's states are on their way gets its own states right after, with no timer", async () => {
  const { a, b, asked, answer } = setup();
  S().activate(a);
  const first = refreshActionStates();
  assert.deepEqual(asked.map((x) => x.tabId), [a]);
  S().activate(b);
  const second = refreshActionStates();
  assert.equal(asked.length, 1, "one pass at a time");
  await answer(0, { ext: { badgeText: "A" } });
  assert.deepEqual(asked.map((x) => x.tabId), [a, b], "the switch ran a pass as soon as the first ended");
  await answer(1, { ext: { badgeText: "B" } });
  await Promise.all([first, second]);
  assert.equal(E().actions[a].ext.badgeText, "A");
  assert.equal(E().actions[b].ext.badgeText, "B");
});

test("a profile switched into another profile's window asks for its tab's states and side panel in its own profile", async () => {
  const { w, answer, asked } = setup();
  const { engineProfile } = await import("../browser/model.ts");
  const aurum = S().createProfile({ name: "Aurum" });
  S().switchProfile(w, aurum);
  const tab = S().newTab(w, { url: "c.com" });
  const profile = engineProfile(S(), aurum);
  assert.notEqual(profile, "");
  usePages.setState({ ready: { ...usePages.getState().ready, [tab]: 3 } });
  useExtensions.setState({ lists: { "": [EXT], [profile]: [EXT] } });
  const states = refreshActionStates();
  const opened = panels.openSidePanel(w, "ext");
  assert.deepEqual(asked.map((x) => [x.what, x.tabId, x.profile]), [["states", tab, profile], ["panel", tab, profile]]);
  await answer(0, {});
  await answer(1, null);
  await Promise.all([states, opened]);
  panels.closeSidePanel(w);
});

test("A→B→A shows A's side panel whatever order Chrome answers in", async () => {
  const { w, a, b, asked, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/a.html");
  await opened;
  assert.equal(E().sidePanels[w].url, "chrome-extension://ext/a.html");
  S().activate(b);
  void panels.syncSidePanel(w);
  S().activate(a);
  void panels.syncSidePanel(w);
  assert.deepEqual(asked.map((x) => x.tabId), [a, b, a]);
  await answer(2, "chrome-extension://ext/a.html");
  await answer(1, "chrome-extension://ext/b.html");
  assert.equal(E().sidePanels[w].url, "chrome-extension://ext/a.html", "B's late answer is dropped");
  panels.closeSidePanel(w);
});

test("two tabs with the same panel URL: the panel follows the tab that is shown", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/shared.html");
  await opened;
  assert.equal(E().sidePanels[w].tabId, a);
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, "chrome-extension://ext/shared.html");
  assert.equal(E().sidePanels[w].tabId, b);
  panels.closeSidePanel(w);
});

test("a tab without a panel of its own hides the panel, and coming back shows the same one", async () => {
  const { w, a, b, asked, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/a.html");
  await opened;
  const panelOfA = E().sidePanels[w];
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, null);
  assert.equal(E().sidePanels[w].hidden, true);
  assert.deepEqual(panels.wantedSidePanels(), [[w, "ext"]]);
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(2, "chrome-extension://ext/a.html");
  assert.equal(E().sidePanels[w].hidden, undefined);
  assert.equal(E().sidePanels[w].url, panelOfA.url);
  assert.equal(asked.length, 3);
  panels.closeSidePanel(w);
});

test("closing one tab's side panel keeps the other tab's panel", async () => {
  const { w, a, b, asked, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(2, "chrome-extension://ext/panel.html?tabId=a");
  panels.closeSidePanelOnTab(w);
  assert.equal(E().sidePanels[w].hidden, true, "A's panel is closed");
  assert.equal(panels.panelClosedOnTab(w, a), true);
  assert.deepEqual(panels.wantedSidePanels(), [[w, "ext"]], "the window keeps its panel for B");
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(3, "chrome-extension://ext/panel.html?tabId=b");
  assert.equal(E().sidePanels[w].hidden, undefined, "B's panel shows again");
  assert.equal(E().sidePanels[w].tabId, b);
  S().activate(a);
  await panels.syncSidePanel(w);
  assert.equal(E().sidePanels[w].hidden, true, "A stays closed");
  assert.equal(asked.length, 4, "A's closed panel isn't asked for again");
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(4, "chrome-extension://ext/panel.html?tabId=b");
  panels.closeSidePanelOnTab(w);
  assert.equal(E().sidePanels[w], undefined, "closing the last tab's panel closes it for the window");
  assert.deepEqual(panels.wantedSidePanels(), []);
  assert.deepEqual(asked.map((x) => x.tabId), [a, b, a, b, b], "each panel URL was asked for the shown tab");
});

test("a tab whose panel was taken away no longer keeps the window's panel open", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  void panels.syncSidePanel(w);
  await answer(2, null);
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(3, "chrome-extension://ext/panel.html?tabId=a");
  panels.closeSidePanelOnTab(w);
  assert.equal(E().sidePanels[w], undefined);
  assert.deepEqual(panels.wantedSidePanels(), []);
});

test("a tab whose panel the extension takes away drops its page", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  void panels.syncSidePanel(w);
  await answer(1, null);
  assert.equal(E().sidePanels[w].hidden, true);
  assert.equal(panels.panelDroppedOnTab(w, a), true);
  assert.equal(panels.panelClosedOnTab(w, a), false, "the extension removing it isn't the user closing it");
  void panels.syncSidePanel(w);
  await answer(2, "chrome-extension://ext/panel.html?tabId=a");
  assert.equal(E().sidePanels[w].hidden, undefined, "the panel comes back when the extension restores it");
  assert.equal(panels.panelDroppedOnTab(w, a), false);
  void panels.syncSidePanel(w);
  await answer(3, null);
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(4, null);
  assert.equal(panels.panelDroppedOnTab(w, b), false, "a tab that never had a panel isn't marked");
  panels.closeSidePanel(w);
});

test("the toggle while a tab switch's panel is being looked up closes the panel for the tab switched to", async () => {
  const { w, a, b, asked, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  assert.equal(asked.length, 2);
  void panels.toggleSidePanel(w, "ext");
  assert.equal(panels.panelClosedOnTab(w, b), true);
  assert.equal(panels.panelClosedOnTab(w, a), false);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  assert.equal(E().sidePanels[w].hidden, true, "the late answer for B is dropped");
  assert.equal(E().sidePanels[w].tabId, a);
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(2, "chrome-extension://ext/panel.html?tabId=a");
  assert.equal(E().sidePanels[w].hidden, undefined, "A's panel is still there");
  assert.equal(E().sidePanels[w].tabId, a);
  panels.closeSidePanel(w);
});

test("opening the side panel again on a tab where it was closed brings it back", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  panels.closeSidePanelOnTab(w);
  assert.equal(panels.panelClosedOnTab(w, b), true);
  const reopened = panels.toggleSidePanel(w, "ext");
  await answer(2, "chrome-extension://ext/panel.html?tabId=b");
  await reopened;
  assert.equal(panels.panelClosedOnTab(w, b), false);
  assert.equal(E().sidePanels[w].hidden, undefined);
  assert.equal(E().sidePanels[w].tabId, b);
  panels.closeSidePanel(w);
  assert.equal(panels.panelClosedOnTab(w, a), false, "a full close forgets the closed tabs");
});

test("the X while the tab switched to is still loading closes the panel for that tab, not the one left", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  usePages.setState({ ready: { [a]: 1 } });
  S().activate(b);
  panels.closeSidePanelOnTab(w);
  assert.equal(panels.panelClosedOnTab(w, b), true);
  assert.equal(panels.panelClosedOnTab(w, a), false);
  assert.equal(E().sidePanels[w].hidden, true);
  panels.closeSidePanel(w);
});

test("a panel whose tab moved to another window no longer keeps this window's panel open", async () => {
  const { w, a, b, asked, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  assert.equal(panels.panelTabOpen(w, b), true);
  const other = S().createWindow({ url: "c.com" });
  S().moveTabsToWindow([b], other);
  assert.equal(panels.panelTabOpen(w, b), false);
  S().activate(a);
  panels.closeSidePanelOnTab(w);
  assert.equal(E().sidePanels[w], undefined);
  assert.equal(asked.length, 2);
  panels.closeSidePanel(w);
});

test("opening the side panel again on a tab that is still loading takes back its close", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  usePages.setState({ ready: { [a]: 1 } });
  S().activate(b);
  panels.closeSidePanelOnTab(w);
  assert.equal(panels.panelClosedOnTab(w, b), true);
  void panels.toggleSidePanel(w, "ext");
  assert.equal(panels.panelClosedOnTab(w, b), false);
  usePages.setState({ ready: { [a]: 1, [b]: 2 } });
  void panels.syncSidePanel(w);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  assert.equal(E().sidePanels[w].hidden, undefined);
  assert.equal(E().sidePanels[w].tabId, b);
  panels.closeSidePanel(w);
});

test("a panel page closing while another tab's panel is being looked up closes only its own tab", async () => {
  const { w, a, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  assert.equal(panels.closeSidePanelOnTab(w, a), false);
  assert.equal(panels.panelClosedOnTab(w, a), true);
  assert.equal(panels.panelClosedOnTab(w, b), false);
  await answer(1, "chrome-extension://ext/panel.html?tabId=b");
  assert.equal(E().sidePanels[w].hidden, undefined);
  assert.equal(E().sidePanels[w].tabId, b);
  assert.equal(panels.closeSidePanelOnTab(w, b), true);
  panels.closeSidePanel(w);
});

test("the X on the only open panel closes it for the window", async () => {
  const { w, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  panels.closeSidePanelOnTab(w);
  assert.equal(E().sidePanels[w], undefined);
  assert.deepEqual(panels.wantedSidePanels(), []);
});

test("opening the side panel from a tab without one while it is hidden opens instead of closing", async () => {
  const { w, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/a.html");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, null);
  assert.equal(E().sidePanels[w].hidden, true);
  const toggled = panels.toggleSidePanel(w, "ext");
  await answer(2, "chrome-extension://ext/b.html");
  await toggled;
  assert.equal(E().sidePanels[w].url, "chrome-extension://ext/b.html");
  assert.equal(E().sidePanels[w].hidden, undefined);
  panels.closeSidePanel(w);
});

test("closing a hidden side panel removes it", async () => {
  const { w, b, answer } = setup();
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/a.html");
  await opened;
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(1, null);
  panels.closeSidePanel(w);
  assert.equal(E().sidePanels[w], undefined);
  assert.deepEqual(panels.wantedSidePanels(), []);
});

test("a second click on the side panel button while it opens closes it", async () => {
  const { w, asked, answer } = setup();
  const opening = panels.toggleSidePanel(w, "ext");
  panels.toggleSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/a.html");
  await opening;
  assert.equal(E().sidePanels[w], undefined);
  assert.deepEqual(panels.wantedSidePanels(), []);
  assert.equal(asked.length, 1);
});

test("closing the side panel while it opens keeps it closed", async () => {
  const { w, answer } = setup();
  const opening = panels.openSidePanel(w, "ext");
  panels.closeSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/a.html");
  await opening;
  assert.equal(E().sidePanels[w], undefined);
});

const G = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
const keys = (i) => (i.key ? ["control", "option", "shift", "command"].filter((m) => i.modifiers?.includes(m)).map((m) => G[m]).join("") + i.key.toUpperCase() : "");
const render = (items, depth = 0) =>
  items.flatMap((i) => [
    "  ".repeat(depth) + (i.separator ? "---" : [i.checked ? "✓" : "", i.title, keys(i), i.symbol ? `[${i.symbol}]` : "", i.swatch ? "(swatch)" : "", i.enabled === false ? "(off)" : "", i.children ? "›" : ""].filter(Boolean).join(" ")),
    ...(i.children ? render(i.children, depth + 1) : []),
  ]);

const ext = { name: "Dark Reader", enabled: true, pinned: false, optionsUrl: "chrome-extension://x/options.html", sidePanel: false, mayModify: true };

test("an extension's menu: Options and Pin, then Manage Extension, Remove Extension… last; no name header or Turn Off", () => {
  assert.deepEqual(render(extensionMenuItems(ext, false)), [
    "Options [gearshape]",
    "Pin to Toolbar [pin]",
    "---",
    "Manage Extension [puzzlepiece.extension]",
    "---",
    "Remove Extension… [trash]",
  ]);
  assert.deepEqual(render(extensionMenuItems({ ...ext, pinned: true, sidePanel: true, mayModify: false }, true)).slice(0, 3), [
    "Options [gearshape]",
    "Close Side Panel [sidebar.right]",
    "Unpin from Toolbar [pin.slash]",
  ]);
  const off = render(extensionMenuItems({ ...ext, enabled: false, sidePanel: true }, false));
  assert.deepEqual(off, ["Pin to Toolbar [pin]", "---", "Manage Extension [puzzlepiece.extension]", "---", "Remove Extension… [trash]"]);
  assert.ok(!render(extensionMenuItems({ ...ext, optionsUrl: "" }, false)).some((l) => l.startsWith("Options")), "no options page, no Options row");
});

const { windowExtensions, pageProfile } = await import("./store.ts");
const { openOptions } = await import("./actions.ts");

function privateSetup() {
  S().hydrate({});
  const regular = S().createWindow({ url: "a.com" });
  const priv = S().createWindow({ kind: "private", url: "b.com" });
  const spanning = { ...EXT, id: "spanning", incognito: true, incognitoSplit: false, optionsUrl: "chrome-extension://spanning/options.html" };
  const split = { ...EXT, id: "split", incognito: true, incognitoSplit: true, optionsUrl: "chrome-extension://split/options.html" };
  const list = [spanning, split, { ...EXT, id: "kept-out" }, { ...EXT, id: "turned-off", incognito: true, enabled: false }];
  useExtensions.setState({ lists: { "": list }, actions: {}, popup: null, sidePanels: {} });
  const urls = (w) => S().windows[w].tabIds.map((id) => S().tabs[id].url);
  return { regular, priv, spanning, split, urls };
}

test("a private window shows the extensions allowed in incognito, spanning ones too (#909)", () => {
  const { regular, priv } = privateSetup();
  assert.deepEqual(windowExtensions(S(), priv).map((x) => x.id), ["spanning", "split"]);
  assert.deepEqual(windowExtensions(S(), regular).map((x) => x.id), ["spanning", "split", "kept-out"]);
  assert.equal(pageProfile(S(), priv), `incognito:${priv}@`, "Chrome picks the popup's profile from the private window's Browser");
});

test("Options from a private window: a spanning extension's page opens in its profile's regular window, as in Chrome", () => {
  const { regular, priv, spanning, split, urls } = privateSetup();
  openOptions(priv, split);
  assert.deepEqual(urls(priv).slice(1), [split.optionsUrl], "a split extension's page loads privately");
  openOptions(priv, spanning);
  assert.ok(!urls(priv).includes(spanning.optionsUrl), "a spanning extension's page can't load in incognito");
  assert.deepEqual(urls(regular).slice(1), [spanning.optionsUrl]);

  S().closeWindow(regular);
  const before = new Set(S().windowOrder);
  openOptions(priv, spanning);
  const made = S().windowOrder.filter((id) => !before.has(id));
  assert.equal(made.length, 1, "with no regular window of the profile open, one opens");
  assert.equal(S().windows[made[0]].kind, "main");
  assert.deepEqual(urls(made[0]), [spanning.optionsUrl]);
});

test("with several profiles, a private window lists and opens only its own profile's extensions", () => {
  S().hydrate({});
  const personal = S().createWindow({ url: "a.com" });
  const workId = S().createProfile({ name: "Work" });
  const work = S().createWindow({ profileId: workId, url: "b.com" });
  const privPersonal = S().createWindow({ kind: "private", profileId: "default", url: "c.com" });
  const privWork = S().createWindow({ kind: "private", profileId: workId, url: "d.com" });
  const shared = { ...EXT, id: "shared", incognito: true, optionsUrl: "chrome-extension://shared/options.html" };
  useExtensions.setState({
    lists: { "": [{ ...shared, incognito: false }, { ...EXT, id: "only-personal", incognito: true }], [workId]: [shared, { ...EXT, id: "only-work", incognito: true }] },
    actions: {}, popup: null, sidePanels: {},
  });
  assert.deepEqual(windowExtensions(S(), privPersonal).map((x) => x.id), ["only-personal"], "the same extension, allowed in Work alone");
  assert.deepEqual(windowExtensions(S(), privWork).map((x) => x.id), ["shared", "only-work"]);
  assert.equal(pageProfile(S(), privWork), `incognito:${privWork}@${workId}`);

  S().setFocusedWindow(personal);
  S().setFocusedWindow(privWork);
  openOptions(privWork, shared);
  const urls = (w) => S().windows[w].tabIds.map((id) => S().tabs[id].url);
  assert.deepEqual(urls(work).slice(1), [shared.optionsUrl], "Work's regular window, though Personal's was used last");
  assert.ok(!urls(personal).includes(shared.optionsUrl) && !urls(privWork).includes(shared.optionsUrl));
});

const { addFromWebStore, openInExtensionProfile, openWebStore, openWebStoreFor } = await import("./actions.ts");
const { SETTINGS_WINDOW_ID } = await import("../settings/settingsWindows.ts");

test("Settings › Extensions opens the store and an extension's pages in the profile it shows, whichever window is in front (FB-M5K5)", () => {
  S().hydrate({});
  const personal = S().createWindow({ url: "a.com" });
  const aurumId = S().createProfile({ name: "Aurum" });
  const aurum = S().createWindow({ profileId: aurumId, url: "b.com" });
  const urls = (w) => S().windows[w].tabIds.map((id) => S().tabs[id].url);
  const store = "https://chromewebstore.google.com/category/extensions";
  S().setFocusedWindow(aurum);
  S().setFocusedWindow(personal);

  openWebStoreFor(aurumId, aurumId);
  assert.deepEqual(urls(aurum).slice(1), [store], "Aurum's window, though Personal's was used last");
  assert.ok(!urls(personal).includes(store));
  assert.equal(S().ui.focusOrder[0], aurum, "and it comes to the front");

  openInExtensionProfile("chrome-extension://ext/options.html", aurumId);
  assert.deepEqual(urls(aurum).slice(2), ["chrome-extension://ext/options.html"]);

  addFromWebStore(SETTINGS_WINDOW_ID, "aeblfdkhhhdcdjpifhhbdiojplfjncoa", aurumId);
  assert.deepEqual(urls(aurum).slice(3), ["https://chromewebstore.google.com/detail/aeblfdkhhhdcdjpifhhbdiojplfjncoa"]);
  assert.equal(urls(personal).length, 1, "nothing opened in Personal");

  openWebStore(personal);
  assert.deepEqual(urls(personal).slice(1), [store], "the Extensions menu still opens the store in its own window");
});

test("with no window showing the profile, the store opens in a new window of that profile, not the one in front", () => {
  S().hydrate({});
  const personal = S().createWindow({ url: "a.com" });
  const aurumId = S().createProfile({ name: "Aurum" });
  S().setFocusedWindow(personal);
  const before = new Set(S().windowOrder);
  openWebStoreFor(aurumId, aurumId);
  const made = S().windowOrder.filter((id) => !before.has(id));
  assert.equal(made.length, 1);
  assert.equal(S().windows[made[0]].profileId, aurumId);
  assert.deepEqual(S().windows[made[0]].tabIds.map((id) => S().tabs[id].url), ["https://chromewebstore.google.com/category/extensions"]);
  assert.equal(S().windows[personal].tabIds.length, 1);
});

test("a private window's Extensions menu opens the store in that private window, as before", () => {
  S().hydrate({});
  S().createWindow({ url: "a.com" });
  const priv = S().createWindow({ kind: "private", profileId: "default", url: "c.com" });
  openWebStore(priv);
  assert.deepEqual(S().windows[priv].tabIds.map((id) => S().tabs[id].url).slice(1), ["https://chromewebstore.google.com/category/extensions"]);
});

const cardTabs = (w) => panels.sidePanelCards(w).map((c) => `${c.extensionId}@${c.tabId === undefined ? "-" : c.tabId}`);

async function twoTabsWithPanels() {
  const t = setup();
  useExtensions.setState({ sidePanelCards: {} });
  const opened = panels.openSidePanel(t.w, "ext");
  await t.answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(t.b);
  void panels.syncSidePanel(t.w);
  await t.answer(1, "chrome-extension://ext/panel.html?tabId=b");
  return t;
}

test("kept panels: every tab that showed its own panel keeps its page mounted until something drops it", async () => {
  const { w, a, b } = await twoTabsWithPanels();
  assert.deepEqual(cardTabs(w), [`ext@${a}`, `ext@${b}`]);
});

test("kept panels: the X drops that tab's page at once, even when a tab switch cuts its closing short", async () => {
  const { w, a, b, answer } = await twoTabsWithPanels();
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(2, "chrome-extension://ext/panel.html?tabId=a");
  panels.closeSidePanelOnTab(w);
  assert.deepEqual(cardTabs(w), [`ext@${b}`], "A's page goes with the X, before any animation");
  S().activate(b);
  void panels.syncSidePanel(w);
  await answer(3, "chrome-extension://ext/panel.html?tabId=b");
  assert.deepEqual(cardTabs(w), [`ext@${b}`]);
  S().activate(a);
  const reopened = panels.openSidePanel(w, "ext");
  await answer(4, "chrome-extension://ext/panel.html?tabId=a");
  await reopened;
  assert.deepEqual(cardTabs(w).sort(), [`ext@${a}`, `ext@${b}`].sort(), "opening it again on A brings A back");
});

test("kept panels: a hidden page that closes itself is dropped and stays closed when you go back to its tab", async () => {
  const { w, a, b, asked } = await twoTabsWithPanels();
  const cardA = panels.sidePanelCards(w).find((c) => c.tabId === a);
  panels.closePanelCard(w, cardA);
  assert.deepEqual(cardTabs(w), [`ext@${b}`]);
  assert.equal(E().sidePanels[w].hidden, undefined, "B's panel still shows");
  S().activate(a);
  await panels.syncSidePanel(w);
  assert.equal(E().sidePanels[w].hidden, true);
  assert.equal(asked.length, 2, "A's panel isn't asked for again");
  assert.deepEqual(cardTabs(w), [`ext@${b}`]);
});

test("kept panels: a hidden page that crashes is dropped, and going back to its tab loads it again", async () => {
  const { w, a, b, answer } = await twoTabsWithPanels();
  panels.dropSidePanelCard(w, panels.sidePanelCards(w).find((c) => c.tabId === a));
  assert.deepEqual(cardTabs(w), [`ext@${b}`]);
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(2, "chrome-extension://ext/panel.html?tabId=a");
  assert.deepEqual(cardTabs(w), [`ext@${b}`, `ext@${a}`]);
});

test("kept panels: opening another extension's panel drops the first extension's pages", async () => {
  const { w, a, b, answer } = await twoTabsWithPanels();
  useExtensions.setState({ lists: { "": [EXT, { ...EXT, id: "ext2", name: "Ext 2" }] } });
  S().activate(a);
  const other = panels.openSidePanel(w, "ext2");
  await answer(2, "chrome-extension://ext2/panel.html?tabId=a");
  await other;
  assert.deepEqual(cardTabs(w), [`ext2@${a}`]);
  void b;
});

test("kept panels: a panel the extension takes away while it's hidden is dropped when its tab comes back, with no other change needed", async () => {
  const { w, a, answer } = setup();
  useExtensions.setState({ sidePanelCards: {} });
  const opened = panels.openSidePanel(w, "ext");
  await answer(0, "chrome-extension://ext/panel.html?tabId=a");
  await opened;
  S().activate(S().windows[w].tabIds[1]);
  void panels.syncSidePanel(w);
  await answer(1, null);
  assert.equal(E().sidePanels[w].hidden, true, "B has no panel: the window's panel hides");
  assert.deepEqual(cardTabs(w), [`ext@${a}`], "A's page is kept while you're on B");
  S().activate(a);
  void panels.syncSidePanel(w);
  await answer(2, null);
  assert.equal(E().sidePanels[w].hidden, true, "still hidden: nothing changes shown or hidden");
  assert.deepEqual(cardTabs(w), [], "A's page is dropped as soon as the extension takes its panel away");
});

test("kept panels: closing a tab drops its page, and closing the window's panel drops them all", async () => {
  const { w, a, b } = await twoTabsWithPanels();
  const stop = panels.watchSidePanelCards();
  S().closeTab(a);
  assert.deepEqual(cardTabs(w), [`ext@${b}`]);
  panels.closeSidePanel(w);
  assert.deepEqual(cardTabs(w), []);
  stop();
});

const { moveTabToWindow } = await import("../browser/actions.ts");
const EXT2 = { ...EXT, id: "ext2", name: "Ext 2" };
const settle = () => new Promise((r) => setImmediate(r));

async function panelWorld(state) {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "b.com", background: true });
  const c = S().newTab(w, { url: "c.com", background: true });
  usePages.setState({ ready: { [a]: 1, [b]: 2 } });
  useExtensions.setState({ lists: { "": [EXT, EXT2] }, actions: {}, popup: null, sidePanels: {}, sidePanelCards: {} });
  const off = new Set();
  const held = [];
  let holding = null;
  const shared = state.startsWith("shared");
  const changed = new Map();
  const urlFor = (tabId, ext) => {
    if (off.has(`${ext}@${tabId}`)) return null;
    const v = changed.has(`${ext}@${tabId}`) ? `v=${changed.get(`${ext}@${tabId}`)}` : "";
    if (shared) return `chrome-extension://${ext}/panel.html${v ? `?${v}` : ""}`;
    return `chrome-extension://${ext}/panel.html?tabId=${tabId}${v ? `&${v}` : ""}`;
  };
  native.extensionAnswers.actionStates = async () => ({});
  native.extensionAnswers.sidePanelUrl = (tabId, ext) => {
    const value = urlFor(tabId, ext);
    if (!holding?.(tabId, ext)) return Promise.resolve(value);
    return new Promise((r) => held.push({ tabId, ext, go: () => r(value) }));
  };
  const show = async (tab) => {
    S().activate(tab);
    await panels.syncSidePanel(w);
  };
  await panels.openSidePanel(w, "ext");
  await show(b);
  await show(a);
  const cardA = panels.sidePanelCards(w).find((card) => card.tabId === a);
  if (state === "hidden" || state === "sharedOnB") await show(b);
  if (state === "notReady" || state === "sharedNotReady") {
    S().activate(c);
    await panels.syncSidePanel(w);
  }
  if (state === "closing") panels.closeSidePanelOnTab(w);
  if (shared) assert.equal(panels.sidePanelCards(w).length, 1, "tabs with the same panel address share one page");
  const name = { [a]: "a", [b]: "b", [c]: "c" };
  const label = (p) => `${p.extensionId}@${p.tabId === undefined ? "-" : (name[p.tabId] ?? "?")}`;
  return {
    w, a, b, c, cardA, off, changed, state,
    show,
    hold: (which = () => true) => (holding = which),
    release: async () => {
      holding = null;
      for (const h of held.splice(0)) h.go();
      await settle();
    },
    heldCount: () => held.length,
    releaseAt: async (positions) => {
      const snapshot = [...held];
      for (const i of positions) {
        held.splice(held.indexOf(snapshot[i]), 1);
        snapshot[i].go();
        await settle();
      }
    },
    cards: () => panels.sidePanelCards(w).map((p) => `${p.extensionId}@${p.owners.length ? p.owners.map((t) => name[t] ?? "?").sort().join("+") : "-"}`).sort(),
    entry: () => {
      const e = E().sidePanels[w];
      return !e ? "closed" : e.hidden ? "hidden" : `shown ${label(e)}`;
    },
    wanted: () => new Map(panels.wantedSidePanels()).get(w) ?? null,
  };
}

const ACTIONS = {
  pageClose: async (x) => panels.closePanelCard(x.w, x.cardA),
  replace: async (x) => panels.openSidePanel(x.w, "ext2"),
  replacePendingThenPageClose: async (x) => {
    x.hold();
    const opening = panels.openSidePanel(x.w, "ext2");
    panels.closePanelCard(x.w, x.cardA);
    x.check("while the replacement is pending");
    assert.equal(x.wanted(), "ext2", "the pending replacement isn't cancelled");
    await x.release();
    await opening;
  },
  disable: async (x) => {
    x.off.add(`ext@${x.a}`);
    await x.show(x.a);
  },
  x: async (x) => panels.closeSidePanelOnTab(x.w),
  newPageAfterLookup: async (x) => {
    const onScreen = E().sidePanels[x.w].tabId;
    x.hold();
    const syncing = panels.syncSidePanel(x.w);
    await settle();
    const lookupAsks = x.heldCount();
    x.changed.set(`ext@${onScreen}`, 2);
    const rechecking = panels.recheckKeptSidePanels(x.w);
    await settle();
    for (let i = 0; i < lookupAsks; i++) await x.releaseAt([0]);
    await syncing;
    x.check("after the tab's own lookup, with the re-check still out");
    await x.release();
    await rechecking;
  },
  newerPageDuringLookup: async (x) => {
    const onScreen = E().sidePanels[x.w].tabId;
    x.changed.set(`ext@${onScreen}`, 2);
    x.hold();
    const syncing = panels.syncSidePanel(x.w);
    await settle();
    const lookupAsks = x.heldCount();
    x.changed.set(`ext@${onScreen}`, 3);
    const rechecking = panels.recheckKeptSidePanels(x.w);
    await settle();
    for (let i = 0; i < lookupAsks; i++) await x.releaseAt([0]);
    await syncing;
    await x.release();
    await rechecking;
  },
  disableWhileLookupPending: async (x) => {
    const onScreen = E().sidePanels[x.w].tabId;
    x.hold();
    const syncing = panels.syncSidePanel(x.w);
    await settle();
    const lookupAsks = x.heldCount();
    x.off.add(`ext@${onScreen}`);
    const rechecking = panels.recheckKeptSidePanels(x.w);
    await settle();
    const recheckAsks = x.heldCount() - lookupAsks;
    for (let i = 0; i < recheckAsks; i++) await x.releaseAt([lookupAsks]);
    x.check("after the re-check, with the older lookup still out");
    await x.release();
    await Promise.all([syncing, rechecking]);
  },
  disableOther: async (x) => {
    const other = x.state === "hidden" || x.state === "sharedOnB" ? x.a : x.b;
    x.off.add(`ext@${other}`);
    await Promise.all([panels.syncSidePanel(x.w), panels.recheckKeptSidePanels(x.w)]);
  },
  crash: async (x) => panels.dropSidePanelCard(x.w, x.cardA),
  tabClose: async (x) => S().closeTab(x.a),
  move: async (x) => moveTabToWindow(x.a, null),
};

const NOT_ON_A = /^(hidden|closed|shown ext@[bc-])$/;
const EXPECT = {
  sharedOnA: {
    newPageAfterLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=2/ },
    newerPageDuringLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=3/ },
    disableWhileLookupPending: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    x: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    pageClose: { cards: [], entry: "closed", wanted: null },
    replace: { cards: ["ext2@a"], entry: "shown ext2@a", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@a"], entry: "shown ext2@a", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    disableOther: { cards: ["ext@a"], entry: "shown ext@a", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
    move: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
  },
  sharedOnB: {
    newPageAfterLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@b", wanted: "ext", url: /v=2/ },
    newerPageDuringLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@b", wanted: "ext", url: /v=3/ },
    disableWhileLookupPending: { cards: ["ext@a"], entry: "hidden", wanted: "ext" },
    x: { cards: ["ext@a"], entry: "hidden", wanted: "ext" },
    pageClose: { cards: [], entry: "closed", wanted: null },
    replace: { cards: ["ext2@b"], entry: "shown ext2@b", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@b"], entry: "shown ext2@b", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    disableOther: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
    move: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
  },
  sharedNotReady: {
    newPageAfterLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=2/ },
    newerPageDuringLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=3/ },
    disableWhileLookupPending: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    x: { cards: ["ext@a+b"], entry: "hidden", wanted: "ext" },
    pageClose: { cards: [], entry: "hidden", wanted: "ext" },
    replace: { cards: ["ext2@-"], entry: "shown ext2@-", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@-"], entry: "shown ext2@-", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
    move: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
  },
  shown: {
    newPageAfterLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=2/ },
    newerPageDuringLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=3/ },
    disableWhileLookupPending: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    pageClose: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    replace: { cards: ["ext2@a"], entry: "shown ext2@a", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@a"], entry: "shown ext2@a", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    disableOther: { cards: ["ext@a"], entry: "shown ext@a", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
    move: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
  },
  hidden: {
    newPageAfterLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@b", wanted: "ext", url: /v=2/ },
    newerPageDuringLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@b", wanted: "ext", url: /v=3/ },
    disableWhileLookupPending: { cards: ["ext@a"], entry: "hidden", wanted: "ext" },
    pageClose: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
    replace: { cards: ["ext2@b"], entry: "shown ext2@b", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@b"], entry: "shown ext2@b", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    disableOther: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
    crash: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
    move: { cards: ["ext@b"], entry: "shown ext@b", wanted: "ext" },
  },
  notReady: {
    newPageAfterLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=2/ },
    newerPageDuringLookup: { cards: ["ext@a", "ext@b"], entry: "shown ext@a", wanted: "ext", url: /v=3/ },
    disableWhileLookupPending: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    pageClose: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    replace: { cards: ["ext2@-"], entry: "shown ext2@-", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@-"], entry: "shown ext2@-", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    disableOther: { cards: ["ext@a"], entry: "shown ext@a", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
    move: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
  },
  closing: {
    pageClose: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    replace: { cards: ["ext2@a"], entry: "shown ext2@a", wanted: "ext2" },
    replacePendingThenPageClose: { cards: ["ext2@a"], entry: "shown ext2@a", wanted: "ext2" },
    disable: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    disableOther: { cards: [], entry: "hidden", wanted: "ext" },
    crash: { cards: ["ext@b"], entry: "hidden", wanted: "ext" },
    tabClose: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
    move: { cards: ["ext@b"], entry: NOT_ON_A, wanted: "ext" },
  },
};

function checkInvariants(x, where) {
  const s = S();
  const e = E().sidePanels[x.w];
  const visible = e && !e.hidden ? e : null;
  const want = x.wanted();
  const seen = new Set();
  for (const card of panels.sidePanelCards(x.w)) {
    const key = `${panels.panelKey(card)}|${card.tabId}`;
    assert.ok(!seen.has(key), `${where}: a card is listed twice`);
    seen.add(key);
    const isVisible = visible && panels.panelKey(visible) === panels.panelKey(card);
    if (isVisible && visible.tabId) assert.ok(card.owners.includes(visible.tabId), `${where}: the panel shown's tab owns its page`);
    if (isVisible) continue;
    assert.equal(card.extensionId, want, `${where}: a kept card belongs to the window's extension`);
    assert.ok(card.owners.length > 0, `${where}: a kept card has a tab to keep it for`);
    for (const owner of card.owners) {
      assert.equal(s.tabs[owner]?.windowId, x.w, `${where}: a kept card's tab is in the window`);
      assert.ok(!panels.panelDroppedOnTab(x.w, owner), `${where}: a kept card's tab hasn't dropped its panel`);
    }
  }
  if (visible) assert.ok(panels.sidePanelCards(x.w).some((card) => panels.panelKey(card) === panels.panelKey(visible)), `${where}: the panel shown has its page listed`);
  if (visible?.tabId) {
    assert.equal(s.tabs[visible.tabId]?.windowId, x.w, `${where}: the panel shown belongs to a tab in the window`);
    assert.ok(!panels.panelDroppedOnTab(x.w, visible.tabId), `${where}: the panel shown wasn't closed or taken away`);
  }
}

test("kept panels, every action in every state: the right pages stay, the rest go, and the window's extension is never cancelled by another one", async () => {
  const stop = panels.watchSidePanelCards();
  const failed = [];
  let cells = 0;
  try {
    for (const [state, row] of Object.entries(EXPECT)) {
      for (const [action, want] of Object.entries(row)) {
        const where = `${state} × ${action}`;
        cells++;
        try {
          const x = await panelWorld(state);
          x.check = (when) => checkInvariants(x, `${where} ${when}`);
          await ACTIONS[action](x);
          await settle();
          x.check("right after the action");
          assert.deepEqual(x.cards(), want.cards, `${where}: cards`);
          if (want.entry instanceof RegExp) assert.match(x.entry(), want.entry, `${where}: entry`);
          else assert.equal(x.entry(), want.entry, `${where}: entry`);
          assert.equal(x.wanted(), want.wanted, `${where}: the window's extension`);
          if (want.url) assert.match(E().sidePanels[x.w].url, want.url, `${where}: the panel shows its newest page`);
          checkInvariants(x, where);
        } catch (error) {
          failed.push(error.message.split("\n")[0]);
        }
      }
    }
  } finally {
    stop();
  }
  assert.equal(cells, 71);
  assert.deepEqual(failed, []);
});

test("re-checking kept panels: a panel turned off while a tab switch is still being looked up is dropped, without cancelling the switch", async () => {
  const x = await panelWorld("shown");
  x.hold((tabId) => tabId === x.b);
  S().activate(x.b);
  const switching = panels.syncSidePanel(x.w);
  await settle();
  x.off.add(`ext@${x.a}`);
  const rechecking = panels.recheckKeptSidePanels(x.w);
  await settle();
  checkInvariants(x, "after A's answer");
  assert.deepEqual(x.cards(), ["ext@b"], "A's page goes though it was still on screen");
  await x.release();
  await Promise.all([switching, rechecking]);
  assert.equal(x.entry(), "shown ext@b", "the switch to B still lands");
  assert.deepEqual(x.cards(), ["ext@b"]);
  assert.equal(panels.panelDroppedOnTab(x.w, x.a), true);
  checkInvariants(x, "after B's answer");
});

test("re-checking kept panels: an older re-check answering after a newer one changes nothing", async () => {
  const x = await panelWorld("shown");
  x.hold();
  x.off.add(`ext@${x.b}`);
  const older = panels.recheckKeptSidePanels(x.w);
  const olderAsks = x.heldCount();
  x.off.delete(`ext@${x.b}`);
  const newer = panels.recheckKeptSidePanels(x.w);
  const newerAsks = x.heldCount() - olderAsks;
  for (let i = 0; i < newerAsks; i++) {
    await x.releaseAt([olderAsks]);
    checkInvariants(x, `after the newer re-check's answer ${i + 1}`);
  }
  for (let i = 0; i < olderAsks; i++) {
    await x.releaseAt([0]);
    checkInvariants(x, `after the older re-check's answer ${i + 1}`);
  }
  await Promise.all([older, newer]);
  assert.deepEqual(x.cards(), ["ext@a", "ext@b"], "B's page stays: its newer answer said it still has a panel");
  assert.equal(panels.panelDroppedOnTab(x.w, x.b), false);
  checkInvariants(x, "after the older re-check");
});

test("re-checking kept panels: an answer about a page that has since been shown again, or closed and reopened, is ignored", async () => {
  for (const how of ["shown again", "closed and reopened"]) {
    const x = await panelWorld("hidden");
    const firstAsk = new Set([x.a, x.b]);
    x.hold((tabId) => firstAsk.delete(tabId));
    x.off.add(`ext@${x.a}`);
    const rechecking = panels.recheckKeptSidePanels(x.w);
    await settle();
    x.off.delete(`ext@${x.a}`);
    if (how === "closed and reopened") {
      panels.closePanelCard(x.w, x.cardA);
      S().activate(x.a);
      await panels.openSidePanel(x.w, "ext");
    } else await x.show(x.a);
    assert.equal(x.entry(), "shown ext@a", how);
    checkInvariants(x, `${how}, before the old answer`);
    await x.releaseAt([0]);
    assert.equal(x.heldCount(), 1, `${how}: B's answer is still out`);
    checkInvariants(x, `${how}, with B's answer still out`);
    assert.equal(x.entry(), "shown ext@a", `${how}: A stays on screen while B's answer is out`);
    await x.releaseAt([0]);
    await rechecking;
    assert.equal(x.entry(), "shown ext@a", `${how}: A stays on screen`);
    assert.deepEqual(x.cards(), ["ext@a", "ext@b"], `${how}: A's page stays`);
    assert.equal(panels.panelDroppedOnTab(x.w, x.a), false, how);
    checkInvariants(x, `${how}, after the old answer`);
  }
});

test("re-checking kept panels: a re-check's \"no panel\" for a tab is ignored once a later lookup of that tab said it has one", async () => {
  const x = await panelWorld("shown");
  let first = true;
  x.hold((tabId) => tabId === x.a && first && !(first = false));
  x.off.add(`ext@${x.a}`);
  const rechecking = panels.recheckKeptSidePanels(x.w);
  await settle();
  x.off.delete(`ext@${x.a}`);
  await panels.syncSidePanel(x.w);
  assert.equal(x.entry(), "shown ext@a");
  await x.releaseAt([0]);
  await rechecking;
  assert.equal(x.entry(), "shown ext@a", "A stays on screen");
  assert.deepEqual(x.cards(), ["ext@a", "ext@b"]);
  assert.equal(panels.panelDroppedOnTab(x.w, x.a), false, "A isn't marked as having no panel");
  checkInvariants(x, "after the older answer");
});

test("Add on an install prompt the engine no longer holds says so in the dialog, and Cancel on one rejects nothing", async () => {
  const { showInstallPrompt, confirmInstall, cancelInstall } = await import("./actions.ts");
  const { ArdiaError } = await import("@ardia/core");
  const { w } = setup();
  const unhandled = [];
  const noteUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", noteUnhandled);
  const answers = [];
  native.extensionAnswers.resolveInstallPrompt = async (requestId, accepted) => {
    answers.push([requestId, accepted]);
    throw new ArdiaError("ERR_EXTENSION_PROMPT_STALE", "The prompt belongs to another window");
  };
  const prompt = { requestId: "install1", profile: "", id: "abc", name: "Ext", version: "1", type: "install", icon: null, permissions: [], tabId: null };
  try {
    showInstallPrompt(w, prompt);
    await confirmInstall();
    const install = E().install;
    assert.equal(install?.status, "error");
    assert.match(install.error, /install request has closed/);
    showInstallPrompt(w, { ...prompt, requestId: "install2" });
    showInstallPrompt(w, { ...prompt, requestId: "install3" });
    cancelInstall();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers, [["install1", true], ["install2", false], ["install3", false]]);
    assert.equal(E().install, null);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", noteUnhandled);
    native.extensionAnswers.resolveInstallPrompt = async () => null;
  }
});

test("Add and Cancel answer an install prompt in the profile that asked, not the window's own", async () => {
  const { showInstallPrompt, confirmInstall, cancelInstall } = await import("./actions.ts");
  const { w } = setup();
  const answers = [];
  native.extensionAnswers.resolveInstallPrompt = async (requestId, accepted, profile) => {
    answers.push([requestId, accepted, profile]);
    return null;
  };
  const prompt = { requestId: "install1", profile: "aurum", id: "abc", name: "Ext", version: "1", type: "install", icon: null, permissions: [], tabId: null };
  try {
    showInstallPrompt(w, prompt);
    await confirmInstall();
    showInstallPrompt(w, { ...prompt, requestId: "install2", profile: "" });
    cancelInstall();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers, [["install1", true, "aurum"], ["install2", false, ""]]);
    assert.equal(E().install, null);
  } finally {
    native.extensionAnswers.resolveInstallPrompt = async () => null;
  }
});

test("a failed Add doesn't replace an install prompt that arrived while it was waiting", async () => {
  const { showInstallPrompt, confirmInstall } = await import("./actions.ts");
  const { ArdiaError } = await import("@ardia/core");
  const { w } = setup();
  let fail;
  native.extensionAnswers.resolveInstallPrompt = (requestId, accepted) =>
    accepted ? new Promise((_, reject) => { fail = () => reject(new ArdiaError("ERR_EXTENSION_PROMPT_STALE", "The prompt belongs to another window")); }) : Promise.resolve(null);
  const prompt = { requestId: "first", profile: "", id: "abc", name: "Ext", version: "1", type: "install", icon: null, permissions: [], tabId: null };
  try {
    showInstallPrompt(w, prompt);
    const confirming = confirmInstall();
    showInstallPrompt(w, { ...prompt, requestId: "second" });
    fail();
    await confirming;
    const install = E().install;
    assert.equal(install?.status, "prompt");
    assert.equal(install.prompt.requestId, "second");
  } finally {
    native.extensionAnswers.resolveInstallPrompt = async () => null;
  }
});

test("kept panels: two tabs sharing one panel page keep it when one of them closes its panel, so going back to the other shows the same page", async () => {
  const x = await panelWorld("sharedOnB");
  const key = panels.panelKey(panels.sidePanelCards(x.w)[0]);
  const listed = () => panels.sidePanelCards(x.w).some((card) => panels.panelKey(card) === key);
  panels.closeSidePanelOnTab(x.w);
  assert.ok(listed(), "B's X leaves the page A still owns");
  assert.equal(x.entry(), "hidden");
  checkInvariants(x, "after the X on B");
  await x.show(x.a);
  assert.ok(listed(), "and the same page is there when you go back to A");
  assert.equal(x.entry(), "shown ext@a");
  assert.deepEqual(x.cards(), ["ext@a"]);
  checkInvariants(x, "back on A");
});

test("the panel's own lookup answering after a newer answer for the same tab uses the newer one, both ways", async () => {
  for (const newerSays of ["no panel", "the same panel"]) {
    const x = await panelWorld("shown");
    if (newerSays === "the same panel") x.off.add(`ext@${x.a}`);
    x.hold();
    const syncing = panels.syncSidePanel(x.w);
    await settle();
    if (newerSays === "no panel") x.off.add(`ext@${x.a}`);
    else x.off.delete(`ext@${x.a}`);
    const rechecking = panels.recheckKeptSidePanels(x.w);
    await settle();
    await x.releaseAt([1, 2]);
    await x.release();
    await Promise.all([syncing, rechecking]);
    if (newerSays === "no panel") {
      assert.equal(x.entry(), "hidden", "the older lookup doesn't bring back a panel turned off since");
      assert.deepEqual(x.cards(), ["ext@b"]);
    } else {
      assert.equal(x.entry(), "shown ext@a", "the older \"no panel\" doesn't hide a panel the extension turned back on");
      assert.deepEqual(x.cards(), ["ext@a", "ext@b"]);
    }
    checkInvariants(x, newerSays);
  }
});

test("Manage Extension opens its details after a Settings search", async () => {
  const { w } = setup();
  const { showExtensionMenu } = await import("./actions.ts");
  const { currentSettingsSearch, previewSetting, setSettingsQuery } = await import("../settings/searchState.ts");
  const { useSettingsNav } = await import("../settings/settingsWindows.ts");
  const { shellNativeModules } = await import("../../test-native/shell.ts");
  const menus = shellNativeModules.ArdiaMenus;
  const showMenu = menus.showMenu;
  const target = { id: "appearance.theme", pane: "appearance", section: "theme" };
  menus.showMenu = async () => "manage";
  try {
    setSettingsQuery("theme");
    previewSetting(target);
    assert.equal(useSettingsNav.getState().pane, "appearance");

    await showExtensionMenu(w, EXT);
    previewSetting(target);

    assert.equal(currentSettingsSearch().query, "");
    assert.equal(useSettingsNav.getState().pane, "profiles");
    assert.equal(useSettingsNav.getState().detail, "extension:ext");
  } finally {
    menus.showMenu = showMenu;
    setSettingsQuery("");
  }
});

test("Settings opened at a place from outside drops a search left from before, so its preview can't replace that place", async () => {
  const { currentSettingsSearch, previewSetting, setSettingsQuery } = await import("../settings/searchState.ts");
  const { openSiteSettings, useSettingsNav } = await import("../settings/settingsWindows.ts");
  const target = { id: "appearance.theme", pane: "appearance", section: "theme" };
  try {
    setSettingsQuery("theme");
    previewSetting(target);
    assert.equal(useSettingsNav.getState().pane, "appearance");
    openSiteSettings("https://example.com", "default");
    previewSetting(target);
    assert.equal(currentSettingsSearch().query, "");
    assert.equal(useSettingsNav.getState().pane, "profiles");
    assert.equal(useSettingsNav.getState().detail, "site:https://example.com");
  } finally {
    setSettingsQuery("");
  }
});
