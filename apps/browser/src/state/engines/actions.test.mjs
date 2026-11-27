import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const stubs = {
  "../tabs/tabPages": "export const wantsPage = (t) => !!t && !!(t.page.nav || t.page.adopt);",
};
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/state/engines/actions.ts") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { patchPage, pageOf } = await import("../tabs/pageState.ts");
const { followSiteChoice, offerWebKit } = await import("./siteMoves.ts");
const { goBackAcrossEngines, notePageCommit, notePageEnded, noteWebKitPage, openPageIn, setEngineMode, useEngineModeSwitch, useEngineOffers } = await import("./actions.ts");
const { takeStreamingSiteCounts } = await import("../telemetry/streamingSiteCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { tabEngine } = await import("./engines.ts");
const { dropSwap, useRetiringPages } = await import("./engineSwap.ts");

const { shellNativeModules } = await import("../../test-native/shell.ts");
const { useToasts } = await import("../app/toasts.ts");
const { engineCalls } = await import("../../test-native/ardiacore.ts");
const confirmNo = shellNativeModules.ArdiaDialogs.confirm;

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function movedTab(url) {
  S().hydrate({});
  const w = S().createWindow({ url });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine: "webkit", url });
  patchPage(tabId, { engineBack: { engine: "chromium", url: "https://search.example/?q=film" } });
  return { w, tabId };
}

test("Back across engines asks first when the page has unsaved input, and staying keeps the page", async () => {
  const { tabId } = movedTab("https://www.netflix.com/browse");
  webviews.set(tabId, { evaluate: () => Promise.resolve(true) });
  assert.equal(await goBackAcrossEngines(tabId), false);
  assert.equal(S().tabs[tabId].engine, "webkit");
  assert.ok(pageOf(tabId).engineBack);
  S().updateSettings({ engineSwitchAsksAboutUnsavedWork: false });
  assert.equal(await goBackAcrossEngines(tabId), true, "with the question turned off, Back goes without asking");
  assert.equal(S().tabs[tabId].engine, "chromium");
  S().updateSettings({ engineSwitchAsksAboutUnsavedWork: true });
  webviews.clear();
});

test("Back across engines without unsaved input reopens the page before in its engine", async () => {
  const { tabId } = movedTab("https://www.netflix.com/browse");
  webviews.set(tabId, { evaluate: () => Promise.resolve(false) });
  assert.equal(await goBackAcrossEngines(tabId), true);
  assert.equal(S().tabs[tabId].engine, "chromium");
  assert.equal(S().tabs[tabId].page.nav.url, "https://search.example/?q=film");
  assert.equal(pageOf(tabId).engineBack, null);
  webviews.clear();
});

test("Back across engines cancelled while the page is held keeps where Back goes", async () => {
  const { tabId } = movedTab("https://www.netflix.com/browse");
  webviews.set(tabId, { evaluate: () => Promise.resolve(false) });
  const back = pageOf(tabId).engineBack;
  let asked = 0;
  assert.equal(await goBackAcrossEngines(tabId, () => ++asked === 1), false);
  assert.equal(asked, 2);
  assert.equal(S().tabs[tabId].engine, "webkit");
  assert.deepEqual(pageOf(tabId).engineBack, back);
  assert.equal(await goBackAcrossEngines(tabId), true, "a later Back still goes");
  assert.equal(S().tabs[tabId].engine, "chromium");
  webviews.clear();
});

test("a streaming site moves to WebKit quietly: the old page is held until the new one paints, and Move Back stays in the tab's engine", async () => {
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true });
  const w = S().createWindow({ url: "https://www.netflix.com/watch/1" });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine: "chromium", url: "https://www.netflix.com/watch/1" });
  webviews.set(tabId, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
  offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
  await settle();
  await settle();
  await settle();
  assert.equal(S().tabs[tabId].engine, "webkit");
  assert.deepEqual(useRetiringPages.getState()[tabId], { engine: "chromium" });
  dropSwap(tabId);
  assert.equal(useRetiringPages.getState()[tabId], undefined);
  assert.deepEqual(S().settings.websiteEngines, {});
  webviews.clear();
});

test("the protected-video offer shows only while its setting is on, and a switch brings cookies along only while that one is", async () => {
  S().hydrate({});
  const tabId = liveTab("https://films.example/watch/1", "chromium");
  S().updateSettings({ offerWebKitForProtectedVideo: false });
  offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
  assert.deepEqual(useEngineOffers.getState(), {});
  S().updateSettings({ offerWebKitForProtectedVideo: true });
  offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
  assert.equal(useEngineOffers.getState()[tabId]?.host, "films.example");
  S().updateSettings({ engineSwitchCarriesSiteData: false });
  engineCalls.length = 0;
  assert.equal(await openPageIn(tabId, "webkit"), true);
  assert.deepEqual(engineCalls.filter(carryCall), []);
  dropSwap(tabId);
  S().updateSettings({ engineSwitchCarriesSiteData: true });
  assert.equal(await openPageIn(tabId, "chromium"), true);
  dropSwap(tabId);
  const back = liveTab("https://films.example/watch/2", "chromium");
  engineCalls.length = 0;
  assert.equal(await openPageIn(back, "webkit"), true);
  assert.ok(engineCalls.some(carryCall));
  dropSwap(back);
  webviews.clear();
});

const carryCall = (c) => c.domain === "webKit" && c.verb !== "setZoom";

function liveTab(url, engine, unsaved = false) {
  const w = S().createWindow({ url });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine, url });
  webviews.set(tabId, { evaluate: (script) => Promise.resolve(script.includes("defaultValue") ? unsaved : false), pageCookies: () => Promise.resolve([]) });
  return tabId;
}

test("WebKit only moves every open page there, holding each old page until the new one paints", async () => {
  S().hydrate({});
  const a = liveTab("https://a.com/", "chromium");
  const b = liveTab("https://b.com/", "chromium");
  patchPage(a, { engineBack: { engine: "webkit", url: "https://z.com/" } });
  const switching = setEngineMode("webkit");
  assert.equal(useEngineModeSwitch.getState().pending, "webkit");
  assert.equal(await switching, true);
  assert.equal(S().settings.engineMode, "webkit");
  for (const id of [a, b]) {
    assert.equal(S().tabs[id].engine, "webkit");
    assert.equal(tabEngine(S(), id), "webkit");
    assert.deepEqual(useRetiringPages.getState()[id], { engine: "chromium" });
    dropSwap(id);
  }
  assert.equal(S().tabs[a].page.nav.url, "https://a.com/");
  assert.equal(pageOf(a).engineBack, null);
  assert.equal(useEngineModeSwitch.getState().pending, null);
  webviews.clear();
});

test("a mode change asks once when a page has unsaved input, and Cancel leaves the mode and every tab alone", async () => {
  S().hydrate({});
  const a = liveTab("https://a.com/", "chromium", true);
  assert.equal(await setEngineMode("webkit"), false);
  assert.equal(S().settings.engineMode, "automatic");
  assert.equal(S().tabs[a].engine, "chromium");
  assert.equal(useRetiringPages.getState()[a], undefined);
  webviews.clear();
});

test("a second mode change while the first waits on its prompt is refused, and the first still lands", async () => {
  S().hydrate({});
  const a = liveTab("https://a.com/", "chromium", true);
  let answer;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answer = resolve));
  const first = setEngineMode("webkit");
  for (let i = 0; i < 4 && !answer; i++) await settle();
  assert.ok(answer);
  const firstAnswer = answer;
  assert.equal(await Promise.race([setEngineMode("chromium"), settle().then(() => "still running")]), false);
  firstAnswer({ confirmed: true, suppressed: false });
  assert.equal(await first, true);
  assert.equal(S().settings.engineMode, "webkit");
  assert.equal(S().tabs[a].engine, "webkit");
  assert.equal(useEngineModeSwitch.getState().pending, null);
  dropSwap(a);
  shellNativeModules.ArdiaDialogs.confirm = confirmNo;
  webviews.clear();
});

test("Chromium only offers no WebKit move for protected video and refuses a move to WebKit, and Automatic puts the streaming site back", async () => {
  S().hydrate({});
  const a = liveTab("https://www.netflix.com/watch/1", "webkit");
  assert.equal(await setEngineMode("chromium"), true);
  dropSwap(a);
  assert.equal(tabEngine(S(), a), "chromium");
  offerWebKit(a, { keySystem: "com.widevine.alpha", main: true });
  await settle();
  assert.deepEqual(useEngineOffers.getState(), {});
  assert.equal(await openPageIn(a, "webkit"), false);
  assert.equal(tabEngine(S(), a), "chromium");
  assert.equal(await setEngineMode("automatic"), true);
  dropSwap(a);
  assert.equal(tabEngine(S(), a), "webkit");
  webviews.clear();
});

test("leaving WebKit only puts each reloaded tab on its own site's engine, even one opened from another tab", async () => {
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true });
  const opener = liveTab("https://search.example/?q=film", "chromium");
  const film = S().newTab(S().tabs[opener].windowId, { url: "https://www.netflix.com/watch/1", openerId: opener });
  S().updateTab(film, { url: "https://www.netflix.com/watch/1" });
  webviews.set(film, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
  assert.equal(await setEngineMode("webkit"), true);
  assert.equal(await setEngineMode("automatic"), true);
  assert.equal(tabEngine(S(), opener), "chromium");
  assert.equal(tabEngine(S(), film), "webkit");
  for (const id of [opener, film]) dropSwap(id);
  webviews.clear();
});

test("a mode change names how many pages lose unsaved changes, once, on the window it came from", async () => {
  S().hydrate({});
  liveTab("https://a.com/", "chromium", true);
  liveTab("https://b.com/", "chromium", true);
  liveTab("https://c.com/", "chromium", false);
  const asked = [];
  shellNativeModules.ArdiaDialogs.confirm = (options) => (asked.push(options), Promise.resolve({ confirmed: false, suppressed: false }));
  assert.equal(await setEngineMode("webkit", { windowId: "settings" }), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Switch to WebKit?");
  assert.equal(asked[0].confirmTitle, "Switch to WebKit");
  assert.match(asked[0].message, /^2 pages with unsaved changes reload/);
  assert.equal(asked[0].windowId, "settings");
  shellNativeModules.ArdiaDialogs.confirm = confirmNo;
  webviews.clear();
});

test("a second move of the same tab while the first is under way is refused, and the first keeps its held page", async () => {
  S().hydrate({});
  const tabId = liveTab("https://a.com/", "chromium");
  const first = openPageIn(tabId, "webkit");
  assert.equal(await openPageIn(tabId, "webkit"), false);
  assert.equal(await first, true);
  assert.deepEqual(useRetiringPages.getState()[tabId], { engine: "chromium" });
  dropSwap(tabId);
  webviews.clear();
});

test("in Chromium only, a page whose protected video is refused gets one notice per site pointing at the Engine setting", async () => {
  S().hydrate({});
  const a = liveTab("https://cinema.example/watch/1", "chromium");
  assert.equal(await setEngineMode("chromium"), true);
  const w = S().tabs[a].windowId;
  useToasts.setState({ toasts: {} });
  offerWebKit(a, { keySystem: "com.widevine.alpha", main: true });
  const toast = useToasts.getState().toasts[w];
  assert.equal(toast?.title, "Protected video won't play in Chromium");
  assert.equal(toast?.action?.title, "Open Settings");
  assert.deepEqual(useEngineOffers.getState(), {});
  useToasts.setState({ toasts: {} });
  offerWebKit(a, { keySystem: "com.widevine.alpha", main: true });
  assert.equal(useToasts.getState().toasts[w], undefined);
  assert.equal(await setEngineMode("automatic"), true);
  dropSwap(a);
  webviews.clear();
});

test("a move waiting on its unsaved-input prompt gives up when Chromium only lands first, and never touches WebKit", async () => {
  S().hydrate({});
  const tabId = liveTab("https://a.com/", "chromium", true);
  let answer;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answer = resolve));
  const moving = openPageIn(tabId, "webkit");
  for (let i = 0; i < 4 && !answer; i++) await settle();
  assert.ok(answer);
  assert.equal(await setEngineMode("chromium"), true);
  engineCalls.length = 0;
  answer({ confirmed: true, suppressed: false });
  assert.equal(await moving, false);
  assert.deepEqual(engineCalls.filter((c) => c.domain === "webKit"), []);
  assert.equal(S().tabs[tabId].engine, "chromium");
  assert.equal(useRetiringPages.getState()[tabId], undefined);
  shellNativeModules.ArdiaDialogs.confirm = confirmNo;
  webviews.clear();
});

test("in WebKit only, a link from a Chromium page to a website moves the tab to WebKit with Back to the page before", async () => {
  S().hydrate({});
  S().updateSettings({ engineMode: "webkit" });
  const w = S().createWindow({ url: "chrome://extensions/" });
  const tabId = model.activeTabId(S(), w);
  webviews.set(tabId, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
  assert.equal(tabEngine(S(), tabId), "chromium");
  S().updateTab(tabId, { url: "https://developer.chrome.com/docs" });
  followSiteChoice(tabId, "chromium", "https://developer.chrome.com/docs", "chrome://extensions/");
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(tabEngine(S(), tabId), "webkit");
  assert.equal(S().tabs[tabId].page.nav.url, "https://developer.chrome.com/docs");
  assert.deepEqual(pageOf(tabId).engineBack, { engine: "chromium", url: "chrome://extensions/" });
  dropSwap(tabId);
  webviews.clear();
});

test("in WebKit only, a link from a website into the Web Store moves to Chromium, and the Web Store's own links stay there", async () => {
  S().hydrate({});
  S().updateSettings({ engineMode: "webkit" });
  const w = S().createWindow({ url: "https://blog.example/" });
  const tabId = model.activeTabId(S(), w);
  webviews.set(tabId, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
  assert.equal(tabEngine(S(), tabId), "webkit");
  S().updateTab(tabId, { url: "https://chromewebstore.google.com/detail/abc" });
  followSiteChoice(tabId, "webkit", "https://chromewebstore.google.com/detail/abc", "https://blog.example/");
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(tabEngine(S(), tabId), "chromium");
  dropSwap(tabId);
  S().updateTab(tabId, { url: "https://accounts.google.com/signin" });
  followSiteChoice(tabId, "chromium", "https://accounts.google.com/signin", "https://chromewebstore.google.com/detail/abc");
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(tabEngine(S(), tabId), "chromium");
  assert.equal(useRetiringPages.getState()[tabId], undefined);
  webviews.clear();
});

test("in WebKit only, leaving the Web Store or its Google sign-in for another site moves the tab back to WebKit", async () => {
  S().hydrate({});
  S().updateSettings({ engineMode: "webkit" });
  for (const previous of ["https://chromewebstore.google.com/detail/abc", "https://accounts.google.com/signin"]) {
    const w = S().createWindow({ url: "https://chromewebstore.google.com/detail/abc" });
    const tabId = model.activeTabId(S(), w);
    webviews.set(tabId, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
    assert.equal(tabEngine(S(), tabId), "chromium");
    S().updateTab(tabId, { url: "https://blog.example/next" });
    followSiteChoice(tabId, "chromium", "https://blog.example/next", previous);
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "webkit", previous);
    dropSwap(tabId);
  }
  webviews.clear();
});

const { persistEngine } = await import("./actions.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../session/persist.ts");
const stub = await import("../../test-native/index.ts");

function chromeMadeTab() {
  const w = S().createWindow({ url: "https://first.example/" });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { url: "https://cli.example/", page: { kind: "adopted", adopt: "tab:42", nav: null } });
  persistEngine(tabId, "chromium");
  return tabId;
}

test("in WebKit only, a tab Chrome opened (CDP or an extension) wakes from sleep and comes back after relaunch in Chromium", () => {
  stub.docs.clear();
  S().hydrate({});
  S().updateSettings({ engineMode: "webkit" });
  const stop = startPersistence();
  const tabId = chromeMadeTab();
  assert.equal(S().tabs[tabId].chromeOpened, true);
  assert.equal(tabEngine(S(), tabId), "chromium");
  S().updateTab(tabId, { page: { kind: "asleep" } });
  assert.equal(tabEngine(S(), tabId), "chromium");
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  assert.equal(S().tabs[tabId].chromeOpened, true);
  assert.equal(S().tabs[tabId].page.kind === "adopted", false);
  assert.equal(tabEngine(S(), tabId), "chromium");
});

test("a page opened by a Chrome-opened tab is marked too, and typing an address in either moves it to WebKit", () => {
  S().hydrate({});
  S().updateSettings({ engineMode: "webkit" });
  const opener = chromeMadeTab();
  const w = S().tabs[opener].windowId;
  const popup = S().newTab(w, { url: "https://popup.example/", adoptId: "ardiacore:5", openerId: opener });
  persistEngine(popup, "chromium");
  assert.equal(S().tabs[popup].chromeOpened, true);
  S().updateTab(popup, { page: { kind: "asleep" }, openerId: null });
  assert.equal(tabEngine(S(), popup), "chromium");
  S().navigate(opener, "https://typed.example/", { userInitiated: true });
  assert.equal(S().tabs[opener].chromeOpened, undefined);
  assert.equal(tabEngine(S(), opener), "webkit");
});

test("a tab the app opened is never marked as Chrome's", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mine.example/" });
  const tabId = model.activeTabId(S(), w);
  persistEngine(tabId, "chromium");
  assert.equal(S().tabs[tabId].chromeOpened, undefined);
  S().updateSettings({ engineMode: "webkit" });
  assert.equal(tabEngine(S(), tabId), "webkit");
});

test("a WebKit tab arriving on a streaming site the list sent there is counted once per arrival, never for a website rule", () => {
  setConsentPeriod(true, "streaming-list-test");
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true, websiteEngines: { "https://www.hulu.com": "webkit" } });
  const w = S().createWindow({ url: "https://www.netflix.com/browse" });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine: "webkit" });
  takeStreamingSiteCounts();
  const page = (url, isLoading = false) => noteWebKitPage(tabId, { url, title: "", isLoading, committedUrl: url });
  page("https://www.netflix.com/browse", true);
  page("https://www.netflix.com/browse");
  page("https://www.netflix.com/watch/1");
  assert.deepEqual(takeStreamingSiteCounts(), { streaming_list_webkit_visits: 1 });
  page("https://example.com/");
  page("https://www.hulu.com/hub/home");
  page("http://www.netflix.com/");
  assert.deepEqual(takeStreamingSiteCounts(), {});
  page("https://www.netflix.com/browse");
  page("https://www.netflix.com/browse");
  S().updateTab(tabId, { engine: "chromium" });
  S().updateTab(tabId, { engine: "webkit" });
  page("https://www.netflix.com/browse");
  assert.deepEqual(takeStreamingSiteCounts(), { streaming_list_webkit_visits: 2 });
  S().updateSettings({ protectedVideoInWebKit: false });
  page("https://www.disneyplus.com/");
  assert.deepEqual(takeStreamingSiteCounts(), {});
  setConsentPeriod(false, null);
  S().updateSettings({ protectedVideoInWebKit: true });
  page("https://open.spotify.com/");
  assert.deepEqual(takeStreamingSiteCounts(), {});
});

const { takeEngineSwitchCounts } = await import("../telemetry/engineSwitchCounts.ts");
const { arrivedOnFirstPage } = await import("../tabs/pageEvents.ts");
const { openedByPage } = await import("./openedPages.ts");

async function waitFor(done, ms = 3000) {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function openedTab(w, opener, url, openerAnswers) {
  const id = S().newTab(w, { url, adoptId: "ardiacore:7", openerId: opener });
  const answers = [...openerAnswers];
  webviews.set(id, {
    evaluate: (script) => (script.includes("window.opener") ? (answers.length > 1 ? answers.shift() : answers[0])() : Promise.resolve(false)),
    pageCookies: () => Promise.resolve([]),
  });
  return id;
}

const notReady = () => Promise.reject(new Error("not ready"));
const answer = (value) => () => Promise.resolve(value);

test("a tab a page opened onto a streaming site moves to WebKit once its page answers that nothing holds it as a pop-up, and one its opener can still script stays", async () => {
  setConsentPeriod(true, "opened-tab-moves");
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true });
  webviews.clear();
  const w = S().createWindow({ url: "https://blog.example/" });
  const opener = model.activeTabId(S(), w);
  S().updateTab(opener, { engine: "chromium", url: "https://blog.example/" });
  takeEngineSwitchCounts();

  const film = openedTab(w, opener, "https://www.disneyplus.com/", [notReady, answer(false)]);
  assert.equal(tabEngine(S(), film), "chromium");
  S().updateTab(film, { url: "https://www.disneyplus.com/" });
  arrivedOnFirstPage(film, "https://www.disneyplus.com/", "chromium");
  assert.ok(await waitFor(() => tabEngine(S(), film) === "webkit"), "the opened tab moves to WebKit");
  assert.equal(S().tabs[film].openerId, opener, "it still goes back to the tab that opened it");
  assert.equal(pageOf(film).engineBack ?? null, null, "a first page has no page before it to go back to");
  dropSwap(film);

  const popup = openedTab(w, opener, "https://www.netflix.com/", [answer(true)]);
  S().updateTab(popup, { url: "https://www.netflix.com/" });
  arrivedOnFirstPage(popup, "https://www.netflix.com/", "chromium");
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), popup), "chromium", "a page its opener can still reach keeps the opener's engine");

  const counts = takeEngineSwitchCounts();
  assert.equal(counts.engine_site_moves, 1);
  assert.equal(counts.engine_site_moves_opened_tabs, 1);
  assert.equal(counts.engine_site_moves_kept_for_opener, 1);
  assert.equal(counts.engine_site_moves_dropped, 0);
  webviews.clear();
  setConsentPeriod(false, null);
});

test("a tab a page opened onto a site with a Chromium rule stays in Chromium, and only a page Chrome made for a link is probed as opened by a page", async () => {
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true, websiteEngines: { "https://www.hulu.com": "chromium" } });
  webviews.clear();
  const w = S().createWindow({ url: "https://blog.example/" });
  const opener = model.activeTabId(S(), w);
  S().updateTab(opener, { engine: "chromium", url: "https://blog.example/" });
  const ruled = openedTab(w, opener, "https://www.hulu.com/", [answer(false)]);
  S().updateTab(ruled, { url: "https://www.hulu.com/" });
  arrivedOnFirstPage(ruled, "https://www.hulu.com/", "chromium");
  const loaded = S().newTab(w, { url: "https://www.max.com/", openerId: opener });
  S().updateTab(loaded, { engine: "chromium" });
  arrivedOnFirstPage(loaded, "https://www.max.com/", "chromium");
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), ruled), "chromium", "a website rule wins over the streaming list");
  assert.equal(tabEngine(S(), loaded), "chromium", "a tab the app loaded keeps the engine it was given");
  assert.equal(openedByPage(ruled), true);
  assert.equal(openedByPage(loaded), false, "only a page Chrome made for a link counts as opened by a page");
  webviews.clear();
  S().updateSettings({ websiteEngines: {} });
});

test("a move after a link to a streaming site still lands when the page moves on within that site meanwhile, and loads where it got to", async () => {
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true });
  const w = S().createWindow({ url: "https://search.example/?q=film" });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine: "chromium", url: "https://search.example/?q=film" });
  webviews.set(tabId, { evaluate: () => new Promise((resolve) => setTimeout(() => resolve(false), 20)), pageCookies: () => Promise.resolve([]) });
  S().updateTab(tabId, { url: "https://www.netflix.com/" });
  followSiteChoice(tabId, "chromium", "https://www.netflix.com/", "https://search.example/?q=film");
  S().updateTab(tabId, { url: "https://www.netflix.com/browse" });
  assert.ok(await waitFor(() => tabEngine(S(), tabId) === "webkit"), "the move lands");
  assert.equal(S().tabs[tabId].page.nav.url, "https://www.netflix.com/browse");
  assert.deepEqual(pageOf(tabId).engineBack, { engine: "chromium", url: "https://search.example/?q=film" });
  dropSwap(tabId);
  webviews.clear();
});

function streamingWindow(source = "https://blog.example/", settings = {}) {
  S().hydrate({});
  S().updateSettings({ protectedVideoInWebKit: true, websiteEngines: {}, engineMode: "automatic", ...settings });
  webviews.clear();
  const w = S().createWindow({ url: source });
  const opener = model.activeTabId(S(), w);
  S().updateTab(opener, { engine: "chromium", url: source });
  return { w, opener };
}

function heldAnswer() {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  return { answer: () => gate, release };
}

test("S1: a Peek or tab opened without a page of Chrome's goes where its site is sent, and otherwise keeps its opener's engine", () => {
  const { w, opener } = streamingWindow("https://blog.example/", { websiteEngines: { "https://www.hulu.com": "chromium" } });
  const film = S().openPeek(opener, "https://www.netflix.com/title/1");
  assert.equal(tabEngine(S(), film), "webkit", "a modifier-click Peek to a streaming site opens in WebKit");
  S().closePeek(opener);
  S().updateTab(opener, { engine: "webkit" });
  const ruled = S().newTab(w, { url: "https://www.hulu.com/", openerId: opener, background: true });
  assert.equal(tabEngine(S(), ruled), "chromium", "a website rule wins over the opener's engine");
  const plain = S().newTab(w, { url: "https://news.example/", openerId: opener, background: true });
  assert.equal(tabEngine(S(), plain), "webkit", "a site with no rule still follows its opener");
  const adopted = S().newTab(w, { url: "https://www.netflix.com/", adoptId: "ardiacore:3", openerId: opener, background: true });
  assert.equal(tabEngine(S(), adopted), "chromium", "a page Chrome already made stays in Chrome until it is probed");
});

test("S2: a page-made tab keeps being probed after the sidebar forgets its opener, so a later redirect can't take it from a live opener", async () => {
  const { w, opener } = streamingWindow();
  const popup = openedTab(w, opener, "https://pay.example/", [answer(true)]);
  S().updateTab(popup, { url: "https://pay.example/" });
  arrivedOnFirstPage(popup, "https://pay.example/", "chromium");
  S().updateTab(popup, { openerId: null });
  S().updateTab(popup, { url: "https://www.netflix.com/" });
  followSiteChoice(popup, "chromium", "https://www.netflix.com/", "https://pay.example/");
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), popup), "chromium");
  assert.equal(openedByPage(popup), true);
  webviews.clear();
});

test("S3: a refused protected video in a page-made tab whose opener can still reach it offers WebKit instead of moving on its own", async () => {
  const { w, opener } = streamingWindow();
  S().updateSettings({ offerWebKitForProtectedVideo: true });
  const popup = openedTab(w, opener, "https://www.netflix.com/", [answer(true)]);
  S().updateTab(popup, { url: "https://www.netflix.com/watch/1" });
  arrivedOnFirstPage(popup, "https://www.netflix.com/watch/1", "chromium");
  for (let i = 0; i < 10; i++) await settle();
  offerWebKit(popup, { keySystem: "com.widevine.alpha", main: true });
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), popup), "chromium");
  assert.equal(useEngineOffers.getState()[popup]?.host, "netflix.com", "the user can still choose WebKit");
  const freed = openedTab(w, opener, "https://www.netflix.com/", [answer(false)]);
  S().updateTab(freed, { url: "https://www.netflix.com/watch/2" });
  offerWebKit(freed, { keySystem: "com.widevine.alpha", main: true });
  assert.ok(await waitFor(() => tabEngine(S(), freed) === "webkit"), "a page-made tab with no opener still moves for protected video");
  dropSwap(freed);
  useEngineOffers.setState({}, true);
  webviews.clear();
});

test("S4: a Chromium rule added while the opener check waits keeps the tab in Chromium", async () => {
  const { w, opener } = streamingWindow();
  const held = heldAnswer();
  const film = openedTab(w, opener, "https://www.disneyplus.com/", [held.answer]);
  S().updateTab(film, { url: "https://www.disneyplus.com/" });
  arrivedOnFirstPage(film, "https://www.disneyplus.com/", "chromium");
  await settle();
  S().updateSettings({ websiteEngines: { "https://www.disneyplus.com": "chromium" } });
  held.release(false);
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), film), "chromium");
  webviews.clear();
});

test("S4: a move whose page goes on, on the same host, to an address WebKit can't open gives up before it swaps", async () => {
  const { w } = streamingWindow("https://search.example/?q=ext", { websiteEngines: { "https://chrome.google.com": "webkit" } });
  const tabId = model.activeTabId(S(), w);
  const held = heldAnswer();
  webviews.set(tabId, { evaluate: held.answer, pageCookies: () => Promise.resolve([]) });
  S().updateTab(tabId, { url: "https://chrome.google.com/" });
  followSiteChoice(tabId, "chromium", "https://chrome.google.com/", "https://search.example/?q=ext");
  await settle();
  S().updateTab(tabId, { url: "https://chrome.google.com/webstore/detail/abc" });
  held.release(false);
  for (let i = 0; i < 20; i++) await settle();
  assert.notEqual(S().tabs[tabId].engine, "webkit", "the stale WebKit move never lands");
  assert.equal(S().tabs[tabId].page.nav?.url, "https://search.example/?q=ext", "the page isn't reloaded in another engine");
  dropSwap(tabId);
  webviews.clear();
});

test("S5: a redirect to a second WebKit site while the first move is under way still lands, on the page it reached", async () => {
  const { w } = streamingWindow("https://search.example/?q=film");
  const tabId = model.activeTabId(S(), w);
  const held = heldAnswer();
  webviews.set(tabId, { evaluate: held.answer, pageCookies: () => Promise.resolve([]) });
  S().updateTab(tabId, { url: "https://netflix.com/" });
  followSiteChoice(tabId, "chromium", "https://netflix.com/", "https://search.example/?q=film");
  await settle();
  S().updateTab(tabId, { url: "https://www.netflix.com/browse" });
  followSiteChoice(tabId, "chromium", "https://www.netflix.com/browse", "https://netflix.com/");
  held.release(false);
  webviews.set(tabId, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
  assert.ok(await waitFor(() => tabEngine(S(), tabId) === "webkit"), "the pending destination moves once the first move settles");
  assert.equal(S().tabs[tabId].page.nav.url, "https://www.netflix.com/browse");
  dropSwap(tabId);
  webviews.clear();
});

test("S7: an opener check the page never answers is counted as dropped, not as kept for its opener", async () => {
  setConsentPeriod(true, "opener-unknown");
  const { w, opener } = streamingWindow();
  takeEngineSwitchCounts();
  const silent = openedTab(w, opener, "https://www.max.com/", [notReady]);
  S().updateTab(silent, { url: "https://www.max.com/" });
  arrivedOnFirstPage(silent, "https://www.max.com/", "chromium");
  const seen = { dropped: 0, kept: 0 };
  const tally = () => {
    const counts = takeEngineSwitchCounts();
    seen.dropped += counts.engine_site_moves_dropped;
    seen.kept += counts.engine_site_moves_kept_for_opener;
    return seen.dropped > 0;
  };
  assert.ok(await waitFor(tally, 6000));
  assert.equal(tabEngine(S(), silent), "chromium");
  assert.deepEqual(seen, { dropped: 1, kept: 0 });
  webviews.clear();
  setConsentPeriod(false, null);
});

test("S2: a typed address that moves a page-made tab to the other engine ends its page-made mark", async () => {
  const { w, opener } = streamingWindow();
  const popup = openedTab(w, opener, "https://pay.example/", [answer(true)]);
  S().updateTab(popup, { url: "https://pay.example/" });
  arrivedOnFirstPage(popup, "https://pay.example/", "chromium");
  assert.equal(openedByPage(popup), true);
  S().navigate(popup, "https://www.netflix.com/");
  assert.equal(tabEngine(S(), popup), "webkit");
  assert.equal(openedByPage(popup), false, "the new page has no opener to protect");
  S().navigate(popup, "https://blog.example/next");
  S().updateTab(popup, { engine: "chromium" });
  assert.equal(openedByPage(popup), false, "coming back to the first engine doesn't bring the mark back");
  webviews.clear();
});

test("S3: a refused protected video in an adopted tab whose first page hasn't reported yet still asks about its opener", async () => {
  const { w, opener } = streamingWindow();
  S().updateSettings({ offerWebKitForProtectedVideo: true });
  const popup = openedTab(w, opener, "https://www.netflix.com/", [answer(true)]);
  S().updateTab(popup, { url: "https://www.netflix.com/watch/1" });
  assert.equal(openedByPage(popup), true, "an adopted page Chrome made counts before any callback");
  offerWebKit(popup, { keySystem: "com.widevine.alpha", main: true });
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), popup), "chromium");
  assert.equal(useEngineOffers.getState()[popup]?.host, "netflix.com");
  useEngineOffers.setState({}, true);
  webviews.clear();
});

test("S4: a Chromium rule added while a protected-video opener check waits shows no offer when the opener is live", async () => {
  const { w, opener } = streamingWindow();
  S().updateSettings({ offerWebKitForProtectedVideo: true });
  const held = heldAnswer();
  const popup = openedTab(w, opener, "https://www.netflix.com/", [held.answer]);
  S().updateTab(popup, { url: "https://www.netflix.com/watch/1" });
  offerWebKit(popup, { keySystem: "com.widevine.alpha", main: true });
  await settle();
  S().updateSettings({ websiteEngines: { "https://www.netflix.com": "chromium" } });
  held.release(true);
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(useEngineOffers.getState()[popup], undefined);
  assert.equal(tabEngine(S(), popup), "chromium");
  webviews.clear();
});

test("S4: a Chromium rule added while a protected-video opener check waits carries no cookies and moves nothing when the opener is gone", async () => {
  const { w, opener } = streamingWindow();
  const held = heldAnswer();
  const popup = openedTab(w, opener, "https://www.netflix.com/", [held.answer]);
  S().updateTab(popup, { url: "https://www.netflix.com/watch/1" });
  offerWebKit(popup, { keySystem: "com.widevine.alpha", main: true });
  await settle();
  S().updateSettings({ websiteEngines: { "https://www.netflix.com": "chromium" } });
  engineCalls.length = 0;
  held.release(false);
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(engineCalls.filter(carryCall), []);
  assert.notEqual(S().tabs[popup].engine, "webkit");
  webviews.clear();
});

test("S5: a redirect to another WebKit site while a protected-video move runs waits its turn and then lands", async () => {
  const { w } = streamingWindow("https://www.netflix.com/watch/1");
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine: "chromium", url: "https://www.netflix.com/watch/1" });
  const held = heldAnswer();
  webviews.set(tabId, { evaluate: held.answer, pageCookies: () => Promise.resolve([]) });
  offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
  await settle();
  S().updateTab(tabId, { url: "https://www.disneyplus.com/" });
  followSiteChoice(tabId, "chromium", "https://www.disneyplus.com/", "https://www.netflix.com/watch/1");
  webviews.set(tabId, { evaluate: () => Promise.resolve(false), pageCookies: () => Promise.resolve([]) });
  held.release(false);
  assert.ok(await waitFor(() => tabEngine(S(), tabId) === "webkit"), "the queued move runs once the first settles");
  assert.equal(S().tabs[tabId].page.nav.url, "https://www.disneyplus.com/");
  dropSwap(tabId);
  webviews.clear();
});

test("S8: an automatic protected-video move a rule change stops declines nothing, while Stay on Page still does", async () => {
  const { w } = streamingWindow("https://www.netflix.com/watch/1");
  const first = model.activeTabId(S(), w);
  S().updateTab(first, { engine: "chromium", url: "https://www.netflix.com/watch/1" });
  const held = heldAnswer();
  webviews.set(first, { evaluate: held.answer, pageCookies: () => Promise.resolve([]) });
  offerWebKit(first, { keySystem: "com.widevine.alpha", main: true });
  await settle();
  S().updateSettings({ websiteEngines: { "https://www.netflix.com": "chromium" } });
  held.release(false);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(tabEngine(S(), first), "chromium");
  S().updateSettings({ websiteEngines: {} });
  const second = liveTab("https://www.netflix.com/watch/2", "chromium");
  offerWebKit(second, { keySystem: "com.widevine.alpha", main: true });
  assert.ok(await waitFor(() => tabEngine(S(), second) === "webkit"), "the site isn't declined by the stopped move");
  dropSwap(second);
  const third = liveTab("https://www.hulu.com/watch/3", "chromium", true);
  offerWebKit(third, { keySystem: "com.widevine.alpha", main: true });
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(tabEngine(S(), third), "chromium", "Stay on Page keeps it");
  const fourth = liveTab("https://www.hulu.com/watch/4", "chromium");
  offerWebKit(fourth, { keySystem: "com.widevine.alpha", main: true });
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(tabEngine(S(), fourth), "chromium", "and the site isn't moved again this session");
  webviews.clear();
});

function streamingTab(url, evaluate) {
  const { w } = streamingWindow(url);
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { engine: "chromium", url });
  webviews.set(tabId, { evaluate, pageCookies: () => Promise.resolve([]) });
  return tabId;
}

const unsavedWork = (unsaved) => (script) => Promise.resolve(script.includes("defaultValue") ? unsaved : false);

test("S4: a Chromium rule added while the unsaved-work check runs never shows the WebKit confirmation", async () => {
  const held = heldAnswer();
  const tabId = streamingTab("https://www.netflix.com/watch/1", held.answer);
  const asked = [];
  shellNativeModules.ArdiaDialogs.confirm = (options) => (asked.push(options), Promise.resolve({ confirmed: true, suppressed: false }));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    await settle();
    S().updateSettings({ websiteEngines: { "https://www.netflix.com": "chromium" } });
    held.release(true);
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(asked.length, 0);
    assert.notEqual(S().tabs[tabId].engine, "webkit");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S4: an address typed while a protected-video move waits on its confirmation wins, and the old page isn't reloaded in WebKit", async () => {
  const tabId = streamingTab("https://www.netflix.com/watch/1", unsavedWork(true));
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answerDialog = resolve));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    S().navigate(tabId, "https://news.example/today");
    answerDialog({ confirmed: true, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.notEqual(S().tabs[tabId].engine, "webkit");
    assert.equal(S().tabs[tabId].page.nav.url, "https://news.example/today");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S5: a redirect inside the 10 s gap after a move waits for the gap instead of being dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const flush = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
  };
  const tabId = streamingTab("https://search.example/?q=film", () => Promise.resolve(false));
  S().updateSettings({ engineSwitchCarriesSiteData: false, websiteEngines: { "https://www.hulu.com": "chromium" } });
  S().updateTab(tabId, { url: "https://www.netflix.com/" });
  followSiteChoice(tabId, "chromium", "https://www.netflix.com/", "https://search.example/?q=film");
  await flush();
  assert.equal(tabEngine(S(), tabId), "webkit");
  dropSwap(tabId);
  S().updateTab(tabId, { url: "https://www.hulu.com/" });
  followSiteChoice(tabId, "webkit", "https://www.hulu.com/", "https://www.netflix.com/");
  await flush();
  assert.equal(tabEngine(S(), tabId), "webkit", "still inside the gap");
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(tabEngine(S(), tabId), "chromium", "the redirect lands once the gap ends");
  assert.deepEqual(pageOf(tabId).engineBack, { engine: "webkit", url: "https://www.netflix.com/" });
  dropSwap(tabId);
  S().updateSettings({ engineSwitchCarriesSiteData: true });
  webviews.clear();
});

test("S5: a protected-video refusal on a redirect still waiting its turn keeps that redirect's Back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
  const flush = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
  };
  const tabId = streamingTab("https://www.netflix.com/watch/1", () => Promise.resolve(false));
  S().updateSettings({ engineSwitchCarriesSiteData: false, websiteEngines: { "https://www.hulu.com": "chromium" } });
  S().updateTab(tabId, { engine: "webkit" });
  S().updateTab(tabId, { url: "https://www.hulu.com/" });
  followSiteChoice(tabId, "webkit", "https://www.hulu.com/", "https://www.netflix.com/watch/1");
  await flush();
  assert.equal(tabEngine(S(), tabId), "chromium");
  dropSwap(tabId);
  S().updateTab(tabId, { url: "https://www.disneyplus.com/" });
  followSiteChoice(tabId, "chromium", "https://www.disneyplus.com/", "https://www.hulu.com/");
  offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
  await flush();
  assert.equal(tabEngine(S(), tabId), "chromium", "both wait for the gap");
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(tabEngine(S(), tabId), "webkit");
  assert.deepEqual(pageOf(tabId).engineBack, { engine: "chromium", url: "https://www.hulu.com/" });
  dropSwap(tabId);
  S().updateSettings({ engineSwitchCarriesSiteData: true });
  webviews.clear();
});

test("S8: a second protected-video refusal while Stay on Page is open doesn't move the tab after the user stays", async () => {
  const tabId = streamingTab("https://www.netflix.com/watch/1", unsavedWork(true));
  let calls = 0;
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => (++calls === 1 ? new Promise((resolve) => (answerDialog = resolve)) : Promise.resolve({ confirmed: true, suppressed: false }));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    await settle();
    answerDialog({ confirmed: false, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "chromium");
    assert.equal(calls, 1, "the queued refusal never asks again");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S9: a move that throws frees the tab's queue, so a later redirect still moves", async () => {
  const tabId = streamingTab("https://www.peacocktv.com/watch/1", unsavedWork(true));
  shellNativeModules.ArdiaDialogs.confirm = () => Promise.reject(new Error("dialog host gone"));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "chromium");
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.set(tabId, { evaluate: unsavedWork(false), pageCookies: () => Promise.resolve([]) });
    S().updateTab(tabId, { url: "https://www.disneyplus.com/" });
    followSiteChoice(tabId, "chromium", "https://www.disneyplus.com/", "https://www.peacocktv.com/watch/1");
    assert.ok(await waitFor(() => tabEngine(S(), tabId) === "webkit"), "the queue isn't stuck");
    dropSwap(tabId);
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S9: an unsaved-work check the page rejects counts as no unsaved work instead of throwing", async () => {
  const tabId = streamingTab("https://www.paramountplus.com/watch/1", () => Promise.reject(new Error("page gone")));
  offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
  assert.ok(await waitFor(() => tabEngine(S(), tabId) === "webkit"));
  dropSwap(tabId);
  webviews.clear();
});

test("S4: a page that moves on within its site while the unsaved-work prompt is open isn't moved under the old page's answer", async () => {
  const tabId = streamingTab("https://www.crunchyroll.com/account", unsavedWork(true));
  let answerDialog;
  let asked = 0;
  shellNativeModules.ArdiaDialogs.confirm = () => (++asked, new Promise((resolve) => (answerDialog = resolve)));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    S().updateTab(tabId, { url: "https://www.crunchyroll.com/profile" });
    followSiteChoice(tabId, "chromium", "https://www.crunchyroll.com/profile", "https://www.crunchyroll.com/account");
    answerDialog({ confirmed: true, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.notEqual(S().tabs[tabId].engine, "webkit", "/profile was never checked for unsaved work");
    assert.equal(asked, 1);
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S8: Stay on Page on a prompt an address typed since made stale declines nothing", async () => {
  const tabId = streamingTab("https://www.peacocktv.com/watch/9", unsavedWork(true));
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answerDialog = resolve));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    S().navigate(tabId, "https://news.example/today");
    answerDialog({ confirmed: false, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
  }
  const later = liveTab("https://www.peacocktv.com/watch/10", "chromium");
  offerWebKit(later, { keySystem: "com.widevine.alpha", main: true });
  assert.ok(await waitFor(() => tabEngine(S(), later) === "webkit"), "peacocktv.com isn't declined");
  dropSwap(later);
  webviews.clear();
});

async function queuedDisneyFromHulu(t, now) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const flush = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
  };
  const tabId = streamingTab("https://www.netflix.com/watch/1", () => Promise.resolve(false));
  S().updateSettings({ engineSwitchCarriesSiteData: false, websiteEngines: { "https://www.hulu.com": "chromium" } });
  S().updateTab(tabId, { engine: "webkit" });
  S().updateTab(tabId, { url: "https://www.hulu.com/" });
  followSiteChoice(tabId, "webkit", "https://www.hulu.com/", "https://www.netflix.com/watch/1");
  await flush();
  assert.equal(tabEngine(S(), tabId), "chromium");
  dropSwap(tabId);
  patchPage(tabId, { engineBack: null });
  S().updateTab(tabId, { url: "https://www.disneyplus.com/" });
  followSiteChoice(tabId, "chromium", "https://www.disneyplus.com/", "https://www.hulu.com/");
  await flush();
  return { tabId, flush };
}

test("S10: a queued move for Disney+ is dropped when the tab goes on to a news site, even once that site gets a WebKit rule", async (t) => {
  const { tabId, flush } = await queuedDisneyFromHulu(t, 3_000_000);
  S().updateTab(tabId, { url: "https://news.example/today" });
  followSiteChoice(tabId, "chromium", "https://news.example/today", "https://www.disneyplus.com/");
  S().updateSettings({ websiteEngines: { "https://www.hulu.com": "chromium", "https://news.example": "webkit" } });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(tabEngine(S(), tabId), "chromium");
  assert.equal(pageOf(tabId).engineBack ?? null, null, "no Back to Hulu on the news page");
  S().updateSettings({ engineSwitchCarriesSiteData: true, websiteEngines: {} });
  webviews.clear();
});

test("S10: a queued move whose page has moved to another site is dropped when the gap ends, even before the new page reports", async (t) => {
  const { tabId, flush } = await queuedDisneyFromHulu(t, 4_000_000);
  S().updateTab(tabId, { url: "https://news.example/today" });
  S().updateSettings({ websiteEngines: { "https://www.hulu.com": "chromium", "https://news.example": "webkit" } });
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(tabEngine(S(), tabId), "chromium");
  assert.equal(pageOf(tabId).engineBack ?? null, null);
  S().updateSettings({ engineSwitchCarriesSiteData: true, websiteEngines: {} });
  webviews.clear();
});

test("S11: a native reload at the same URL invalidates Open in WebKit, while same-document updates do not", async () => {
  const tabId = streamingTab("https://www.primevideo.com/detail/1", unsavedWork(true));
  notePageCommit(tabId, 1000);
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answerDialog = resolve));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    notePageCommit(tabId, 1000);
    notePageCommit(tabId, 2000);
    engineCalls.length = 0;
    answerDialog({ confirmed: true, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "chromium");
    assert.deepEqual(engineCalls.filter(carryCall), []);
    assert.equal(useRetiringPages.getState()[tabId], undefined);

    answerDialog = undefined;
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    notePageCommit(tabId, 2000);
    answerDialog({ confirmed: true, suppressed: false });
    assert.ok(await waitFor(() => tabEngine(S(), tabId) === "webkit"));
    dropSwap(tabId);
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S11: a native reload at the same URL invalidates Stay on Page so the site is not declined", async () => {
  const tabId = streamingTab("https://tv.apple.com/show/1", unsavedWork(true));
  notePageCommit(tabId, 1000);
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answerDialog = resolve));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    notePageCommit(tabId, 2000);
    answerDialog({ confirmed: false, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "chromium");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
  }
  const later = liveTab("https://tv.apple.com/show/2", "chromium");
  offerWebKit(later, { keySystem: "com.widevine.alpha", main: true });
  assert.ok(await waitFor(() => tabEngine(S(), later) === "webkit"), "tv.apple.com is not declined by a stale Stay on Page");
  dropSwap(later);
  webviews.clear();
});

test("S11: an ended document invalidates an open unsaved-work prompt at the same URL", async () => {
  const tabId = streamingTab("https://music.apple.com/album/1", unsavedWork(true));
  notePageCommit(tabId, 1000);
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answerDialog = resolve));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    notePageEnded(tabId);
    answerDialog({ confirmed: true, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "chromium");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S11: TabWebView reports every live document commit to notePageCommit", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../components/window/TabWebView.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("onNavigationChange={("));
  assert.match(handler, /if \(!retired\) notePageCommit\(tabId, committedAt\);/);
});

test("S11: a page view that goes while its tab stays open leaves no document behind once the tab closes", async () => {
  const { forgetCommittedDocumentIfGone, pageDocumentOf } = await import("./actions.ts");
  const w = S().createWindow({ url: "https://news.example/a" });
  const tabId = S().newTab(w, { url: "https://news.example/b" });
  notePageCommit(tabId, 1000);
  notePageEnded(tabId);
  forgetCommittedDocumentIfGone(tabId);
  assert.ok(pageDocumentOf(tabId) > 0, "an open tab keeps its document");
  S().closeTab(tabId);
  assert.equal(pageDocumentOf(tabId), 0);

  const back = S().newTab(w, { url: "https://news.example/c" });
  notePageCommit(back, 3000);
  forgetCommittedDocumentIfGone(back);
  notePageCommit(back, 4000);
  const document = pageDocumentOf(back);
  S().closeTab(back);
  assert.equal(pageDocumentOf(back), document, "a page view that came back owns its tab's document again");
  forgetCommittedDocumentIfGone(back);
  assert.equal(pageDocumentOf(back), 0);
});

test("S11: a closed tab's committed document is forgotten when its page view goes, and a gone tab records none", async () => {
  const { forgetCommittedDocumentIfGone, pageDocumentOf } = await import("./actions.ts");
  const w = S().createWindow({ url: "https://news.example/a" });
  const tabId = S().newTab(w, { url: "https://news.example/b" });
  notePageCommit(tabId, 1000);
  const document = pageDocumentOf(tabId);
  assert.ok(document > 0);
  forgetCommittedDocumentIfGone(tabId);
  assert.equal(pageDocumentOf(tabId), document, "an open tab keeps its document");
  S().closeTab(tabId);
  forgetCommittedDocumentIfGone(tabId);
  assert.equal(pageDocumentOf(tabId), 0);
  notePageCommit(tabId, 2000);
  notePageEnded(tabId);
  assert.equal(pageDocumentOf(tabId), 0);
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../components/window/TabWebView.tsx", import.meta.url), "utf8");
  assert.match(source, /forgetPageDocument\(tabId, documentReporter\);\s*forgetCommittedDocumentIfGone\(tabId\);/);
});

test("S12: text typed during the 10 s cooldown triggers the unsaved-work prompt instead of switching unconditionally", async (t) => {
  const { tabId, flush } = await queuedDisneyFromHulu(t, 5_000_000);
  webviews.set(tabId, { evaluate: unsavedWork(true), pageCookies: () => Promise.resolve([]) });
  const asked = [];
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = (options) => {
    asked.push(options);
    return new Promise((resolve) => (answerDialog = resolve));
  };
  try {
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, "Open this page in WebKit?");
    assert.equal(tabEngine(S(), tabId), "chromium");
    answerDialog({ confirmed: false, suppressed: false });
    await flush();
    assert.equal(tabEngine(S(), tabId), "chromium", "Stay on Page keeps the text entered during cooldown");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    S().updateSettings({ engineSwitchCarriesSiteData: true, websiteEngines: {} });
    webviews.clear();
  }
});

test("S12: confirming a delayed site move's unsaved-work prompt lands the move, and disabling the setting skips the prompt", async (t) => {
  const { tabId, flush } = await queuedDisneyFromHulu(t, 6_000_000);
  webviews.set(tabId, { evaluate: unsavedWork(true), pageCookies: () => Promise.resolve([]) });
  const asked = [];
  shellNativeModules.ArdiaDialogs.confirm = (options) => (asked.push(options), Promise.resolve({ confirmed: true, suppressed: false }));
  try {
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(asked.length, 1);
    assert.equal(tabEngine(S(), tabId), "webkit");
    assert.deepEqual(pageOf(tabId).engineBack, { engine: "chromium", url: "https://www.hulu.com/" });
    dropSwap(tabId);

    S().updateSettings({ engineSwitchAsksAboutUnsavedWork: false });
    S().updateTab(tabId, { url: "https://www.hulu.com/" });
    followSiteChoice(tabId, "webkit", "https://www.hulu.com/", "https://www.disneyplus.com/");
    await flush();
    assert.equal(tabEngine(S(), tabId), "webkit");
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(asked.length, 1, "with the setting off, the delayed move does not ask");
    assert.equal(tabEngine(S(), tabId), "chromium");
    dropSwap(tabId);
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    S().updateSettings({ engineSwitchAsksAboutUnsavedWork: true, engineSwitchCarriesSiteData: true, websiteEngines: {} });
    webviews.clear();
  }
});

test("openPageIn refuses to commit WebKit after a same-host redirect to the Web Store even with a permissive routedHere", async () => {
  const { w } = streamingWindow("https://chrome.google.com/", { websiteEngines: { "https://chrome.google.com": "webkit" } });
  const tabId = model.activeTabId(S(), w);
  const held = heldAnswer();
  webviews.set(tabId, { evaluate: held.answer, pageCookies: () => Promise.resolve([]) });
  const moving = openPageIn(tabId, "webkit", { checkWork: false, routedHere: () => true });
  await settle();
  S().updateTab(tabId, { url: "https://chrome.google.com/webstore/detail/abc" });
  held.release(null);
  assert.equal(await moving, false);
  assert.notEqual(S().tabs[tabId].engine, "webkit");
  dropSwap(tabId);
  webviews.clear();
});

test("S13: a page-made tab edited while its opener check waits asks about unsaved work before it moves", async () => {
  const { w, opener } = streamingWindow();
  const held = heldAnswer();
  const film = S().newTab(w, { url: "https://www.disneyplus.com/", adoptId: "ardiacore:7", openerId: opener });
  let edited = false;
  webviews.set(film, {
    evaluate: (script) => (script.includes("window.opener") ? held.answer() : Promise.resolve(script.includes("defaultValue") ? edited : false)),
    pageCookies: () => Promise.resolve([]),
  });
  const asked = [];
  shellNativeModules.ArdiaDialogs.confirm = (options) => (asked.push(options), Promise.resolve({ confirmed: false, suppressed: false }));
  try {
    S().updateTab(film, { url: "https://www.disneyplus.com/" });
    arrivedOnFirstPage(film, "https://www.disneyplus.com/", "chromium");
    await settle();
    edited = true;
    held.release(false);
    assert.ok(await waitFor(() => asked.length === 1), "the move asks before it reloads the edited page");
    for (let i = 0; i < 10; i++) await settle();
    assert.equal(tabEngine(S(), film), "chromium", "staying keeps the page and its edits");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});

test("S13: an opener answer that arrives after the page-made tab left its site and came back can't move it or set where Back goes", async () => {
  const { w, opener } = streamingWindow();
  const held = heldAnswer();
  const popup = openedTab(w, opener, "https://search.example/?q=film", [held.answer, answer(true)]);
  S().updateTab(popup, { url: "https://search.example/?q=film" });
  arrivedOnFirstPage(popup, "https://search.example/?q=film", "chromium");
  S().updateTab(popup, { url: "https://www.netflix.com/" });
  followSiteChoice(popup, "chromium", "https://www.netflix.com/", "https://search.example/?q=film");
  await settle();
  S().updateTab(popup, { url: "https://blog.example/post" });
  followSiteChoice(popup, "chromium", "https://blog.example/post", "https://www.netflix.com/");
  S().updateTab(popup, { url: "https://www.netflix.com/browse" });
  followSiteChoice(popup, "chromium", "https://www.netflix.com/browse", "https://blog.example/post");
  for (let i = 0; i < 10; i++) await settle();
  held.release(false);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(tabEngine(S(), popup), "chromium", "the newer visit's live opener keeps the tab where it is");
  assert.equal(pageOf(popup).engineBack ?? null, null, "the stale answer publishes no Back target");
  webviews.clear();
});

test("S13: a protected video on a platform without WebKit stores no WebKit offer", async () => {
  const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
  const had = PLATFORM_FEATURES.webKit;
  const tabId = streamingTab("https://video.example/watch/1", unsavedWork(false));
  S().updateSettings({ offerWebKitForProtectedVideo: true });
  try {
    PLATFORM_FEATURES.webKit = false;
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.equal(useEngineOffers.getState()[tabId], undefined, "nothing offers an engine the page can't open in");
    PLATFORM_FEATURES.webKit = had;
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.equal(useEngineOffers.getState()[tabId]?.host, "video.example", "with WebKit there, the offer still shows");
  } finally {
    PLATFORM_FEATURES.webKit = had;
    useEngineOffers.setState({}, true);
    webviews.clear();
  }
});

test("S13: a Peek whose first committed page redirected to a WebKit site moves there, and one that stays on its asked site keeps its engine", async () => {
  const { opener } = streamingWindow();
  const peek = S().openPeek(opener, "https://short.example/film");
  assert.equal(tabEngine(S(), peek), "chromium");
  webviews.set(peek, { evaluate: unsavedWork(false), pageCookies: () => Promise.resolve([]) });
  S().updateTab(peek, { url: "https://www.netflix.com/title/1" });
  arrivedOnFirstPage(peek, "https://www.netflix.com/title/1", "chromium");
  assert.ok(await waitFor(() => tabEngine(S(), peek) === "webkit"), "the redirected Peek goes where its site is sent");
  assert.equal(pageOf(peek).engineBack ?? null, null, "a first page has no page before it to go back to");
  dropSwap(peek);
  S().closePeek(opener);
  const plain = S().openPeek(opener, "https://short.example/film");
  webviews.set(plain, { evaluate: unsavedWork(false), pageCookies: () => Promise.resolve([]) });
  S().updateTab(plain, { url: "https://short.example/film/1" });
  arrivedOnFirstPage(plain, "https://short.example/film/1", "chromium");
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(tabEngine(S(), plain), "chromium");
  S().closePeek(opener);
  webviews.clear();
});

test("S13: a commit reported with an earlier clock than the last one still counts as a new document", async () => {
  const tabId = streamingTab("https://www.primevideo.com/detail/2", unsavedWork(true));
  notePageCommit(tabId, 2000);
  let answerDialog;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => (answerDialog = resolve));
  try {
    offerWebKit(tabId, { keySystem: "com.widevine.alpha", main: true });
    assert.ok(await waitFor(() => !!answerDialog));
    notePageCommit(tabId, 1500);
    answerDialog({ confirmed: true, suppressed: false });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(tabEngine(S(), tabId), "chromium", "the answer was for the document before the clock stepped back");
  } finally {
    shellNativeModules.ArdiaDialogs.confirm = confirmNo;
    webviews.clear();
  }
});
