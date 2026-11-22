import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { pageBarFor, pageBarPaneEligible } = await import("./pageBar.ts");
const { notePageDocument, forgetPageDocument, endPageDocument, usePageDocuments, confirmedDocument } = await import("./pageBarDocuments.ts");
const { setSiteSwitch, siteSwitchValue, siteSwitchRows } = await import("./siteSwitches.ts");
const { navigateTyped, noteTypedOpen, typedAddressCount } = await import("./typedAddresses.ts");
const noteTypedAddress = (tabId, url, now) => navigateTyped(tabId, url, () => useBrowser.getState().navigate(tabId, url), now);
const realTabs = (names) => {
  const windowId = useBrowser.getState().createWindow({ url: "https://example.com/" });
  return Object.fromEntries(names.map((name) => [name, useBrowser.getState().newTab(windowId, { url: "https://example.com/" })]));
};
const { openFromBar } = await import("../omnibox/openFromBar.ts");
const { setOpeningGate } = await import("../tabs/openingGate.ts");
const { hostActionTarget } = await import("./hostActions.ts");
const { parsePluginRecords, pluginRecordsJson } = await import("./savedState.ts");
const { publishPageBars, publishedPageBar, withdrawPageBars } = await import("./pageBarPanes.ts");
const { runHostAction } = await import("./hostActions.ts");
const { pageBarsWanted } = await import("./chrome.ts");
const { reportPageCommits } = await import("../../platform/tabs.ts");
const { takePageBarCounts } = await import("../telemetry/pageBarCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "page-bar-test");

const FIXTURE = readFileSync(new URL("../../../../../tests/fixtures/plugins/developer-mode/plugin.json", import.meta.url), "utf8");
const twin = (name) => JSON.stringify({ ...JSON.parse(FIXTURE), name });
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOCAL = "http://127.0.0.1:18318/management.html";
const R = {};

async function enable(names = ["developer-mode"]) {
  useBrowser.getState().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, null);
  host.folders = names.map((name) => ({ name, status: "ok", text: name === "developer-mode" ? FIXTURE : twin(name) }));
  await lifecycle.rescanPlugins(consentToken());
  for (const name of names) assert.ok(lifecycle.requestPluginConsent(name) && lifecycle.enablePlugin(name, P().consent.hash));
}

const pane = (tabId, over = {}) => ({
  tabId,
  visible: true,
  lingering: false,
  warm: false,
  covered: false,
  mounted: true,
  live: true,
  frozen: false,
  newTabShown: false,
  peek: false,
  otherProfile: false,
  privatePage: false,
  small: false,
  documentFullscreen: false,
  windowFullscreen: false,
  ...over,
});

const settledDoc = (tabId, url, at = Date.now() - 5000) => notePageDocument(tabId, url, url, at, false, R);
const state = () => ({ plugins: P(), documents: usePageDocuments.getState() });

test("only a visible, live pane of its own document can draw a bar: the nightly.8 leak can't happen", async () => {
  await enable();
  assert.ok(setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken()));
  settledDoc("local", LOCAL);
  settledDoc("ordinary", "https://example.com/");
  assert.equal(pageBarFor(state(), pane("local", { visible: false, warm: true })), null, "a hidden kept-alive loopback pane draws nothing over the card");
  assert.equal(pageBarFor(state(), pane("ordinary")), null, "the visible ordinary tab above or below it gets no bar");
  assert.equal(pageBarFor(state(), pane("local")).url, LOCAL);
  for (const hidden of [{ visible: false }, { lingering: true }, { warm: true }, { covered: true }, { mounted: false }, { live: false }, { frozen: true }, { newTabShown: true }, { peek: true }, { otherProfile: true }, { privatePage: true }, { small: true }, { documentFullscreen: true }, { windowFullscreen: true }]) {
    assert.equal(pageBarPaneEligible(pane("local", hidden)), false, JSON.stringify(hidden));
    assert.equal(pageBarFor(state(), pane("local", hidden)), null, JSON.stringify(hidden));
  }
  forgetPageDocument("local", R);
  forgetPageDocument("ordinary", R);
});

test("a bar counts as official only when the listing and its manifest both say so", async () => {
  await enable();
  assert.ok(setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken()));
  settledDoc("claims", LOCAL);
  const listing = P().listings["developer-mode"];
  const claiming = { ...listing, official: false, manifest: { ...listing.manifest, official: true } };
  const plugins = { ...P(), listings: { ...P().listings, "developer-mode": claiming } };
  assert.equal(pageBarFor({ plugins, documents: usePageDocuments.getState() }, pane("claims"))?.official, false);
  forgetPageDocument("claims", R);
});

test("a new document shows its bar after 300 ms committed; a same-document change keeps the decision; a disagreeing address shows none", async () => {
  await enable();
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  notePageDocument("t", LOCAL, LOCAL, Date.now(), false, R);
  assert.equal(pageBarFor(state(), pane("t")), null, "not yet settled");
  await wait(330);
  assert.equal(pageBarFor(state(), pane("t")).url, LOCAL);
  const at = usePageDocuments.getState().t.at;
  notePageDocument("t", `${LOCAL}#section`, `${LOCAL}#section`, at, false, R);
  assert.equal(pageBarFor(state(), pane("t")).url, `${LOCAL}#section`, "same document: the decision stays, the address follows");
  notePageDocument("t", "http://127.0.0.1:18318/next", `${LOCAL}#section`, at, false, R);
  assert.equal(pageBarFor(state(), pane("t")), null, "while the shown and committed addresses disagree");
  notePageDocument("t", "https://example.com/", "https://example.com/", Date.now(), false, R);
  assert.equal(confirmedDocument(usePageDocuments.getState(), "t"), null, "a client redirect that leaves within 300 ms never settles");
  notePageDocument("t", LOCAL, LOCAL, Date.now() - 1000, false, R);
  assert.equal(pageBarFor(state(), pane("t")).url, LOCAL, "a document committed long ago shows at once");
  forgetPageDocument("t", R);
  assert.equal(usePageDocuments.getState().t, undefined);
});

test("typing a local address turns the switch on only with the toggle row on, only for that origin, and never over an explicit off", async () => {
  await enable();
  const T = realTabs(["a", "b", "c", "d", "e", "h"]);
  takePageBarCounts();
  const origin = "http://localhost:18318";
  noteTypedAddress(T.a, `${origin}/management.html`);
  notePageDocument(T.a, `${origin}/management.html`, `${origin}/management.html`, Date.now(), false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", origin), undefined, "the row is off by default");
  lifecycle.setPluginValue("developer-mode", "localAddresses", true);
  noteTypedAddress(T.a, `${origin}/management.html`);
  notePageDocument(T.a, `${origin}/management.html`, `${origin}/management.html`, Date.now() + 1, false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", origin), true);
  assert.equal(takePageBarCounts().plugin_site_switch_auto_on_typed, 1);
  setSiteSwitch("developer-mode", "on", `${origin}/`, false, consentToken());
  noteTypedAddress(T.a, `${origin}/`);
  notePageDocument(T.a, `${origin}/`, `${origin}/`, Date.now() + 2, false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", origin), false, "an explicit off wins");
  const callback = "http://127.0.0.1:18455/callback?code=1";
  notePageDocument(T.b, callback, callback, Date.now(), false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://127.0.0.1:18455"), undefined, "a redirect or link to a local address turns nothing on");
  noteTypedAddress(T.c, "http://192.168.1.20:18318/");
  notePageDocument(T.c, callback, callback, Date.now(), false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://127.0.0.1:18455"), undefined, "a typed LAN address that redirects to a local callback turns nothing on");
  noteTypedAddress(T.d, "http://localhost:5173/");
  notePageDocument(T.d, "http://localhost:5173/", "http://localhost:5173/", Date.now(), true, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:5173"), undefined, "never in a private window");
  noteTypedAddress(T.e, "http://localhost:5174/");
  notePageDocument(T.e, "http://localhost:9999/", "http://localhost:9999/", Date.now(), false, R);
  notePageDocument(T.e, "http://localhost:5174/", "http://localhost:5174/", Date.now() + 5, false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:5174"), undefined, "the intent is spent on the next document, whatever it is");
  noteTypedAddress(T.h, "http://LOCALHOST:5180");
  notePageDocument(T.h, "http://localhost:5180/", "http://localhost:5180/", Date.now(), false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:5180"), true, "a bare typed origin matches the committed document with its trailing slash");
  for (const id of [T.a, T.b, T.c, T.d, T.e, T.h]) forgetPageDocument(id, R);
});

test("site switch values live beside the record, keyed by origin, and stay out of the helper's values", async () => {
  await enable();
  setSiteSwitch("developer-mode", "on", "https://Example.com:443/a", true, consentToken());
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "https://example.com"), true);
  assert.deepEqual(Object.keys(P().records["developer-mode"].values), ["localAddresses"]);
  assert.deepEqual(siteSwitchRows(P(), "https://example.com/b"), [{ plugin: "developer-mode", key: "on", title: "Developer Mode", icon: "hammer", on: true }]);
  assert.deepEqual(siteSwitchRows(P(), "ardia://settings"), []);
  const parsed = parsePluginRecords(pluginRecordsJson({ x: { enabled: false, approved: null, values: {}, applied: {}, sites: { on: { "https://example.com": true, "not an origin": true, "http://a.test/path": true, "http://b.test": "yes", __proto__: true }, "bad key!": { "https://c.test": true } } } }));
  assert.deepEqual(parsed.x.sites, { on: { "https://example.com": true } });
  assert.equal(siteSwitchValue({ records: parsed }, "x", "constructor", "https://example.com"), undefined);
  lifecycle.disablePlugin("developer-mode", null);
  assert.deepEqual(siteSwitchRows(P(), "https://example.com/b"), [], "withdrawn while the plugin is off");
  assert.equal(P().records["developer-mode"].sites.on["https://example.com"], true, "and kept for when it's back");
  assert.ok(lifecycle.requestPluginConsent("developer-mode") && lifecycle.enablePlugin("developer-mode", P().consent.hash));
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "https://example.com"), true);
});

test("several plugins matching one page: the first by name draws, the rest count as superseded", async () => {
  await enable(["zeta-bar", "developer-mode"]);
  for (const name of ["zeta-bar", "developer-mode"]) setSiteSwitch(name, "on", LOCAL, true, consentToken());
  settledDoc("s", LOCAL);
  const match = pageBarFor(state(), pane("s"));
  assert.equal(match.plugin, "developer-mode");
  assert.equal(match.superseded, 1);
  takePageBarCounts();
  publishPageBars("w", { s: match });
  publishPageBars("w", { s: match });
  const counts = takePageBarCounts();
  assert.equal(counts.plugin_page_bar_shown_other, 1, "once per tab per document");
  assert.equal(counts.plugin_page_bar_superseded, 1);
  withdrawPageBars("w");
  forgetPageDocument("s", R);
});

test("page bars ask native for commit reports as their own reader, apart from automation", async () => {
  await enable();
  assert.equal(stub.commitReports.at(-1), true);
  lifecycle.disablePlugin("developer-mode", null);
  assert.equal(stub.commitReports.at(-1), false);
  await reportPageCommits("automation", true);
  await enable();
  stub.commitReports.length = 0;
  lifecycle.disablePlugin("developer-mode", null);
  assert.deepEqual(stub.commitReports, [], "page bars stopping leaves reports on for automation");
  await reportPageCommits("automation", false);
  assert.deepEqual(stub.commitReports, [false]);
});

test("a host action runs only for the tab whose bar shows it", async () => {
  await enable();
  const windowId = useBrowser.getState().createWindow({ url: LOCAL });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  takePageBarCounts();
  runHostAction("copyLink", windowId, tabId);
  assert.equal(takePageBarCounts().plugin_page_bar_press_copy_link, 0, "no bar, no action");
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  settledDoc(tabId, LOCAL);
  publishPageBars(windowId, { [tabId]: pageBarFor(state(), pane(tabId)) });
  assert.ok(publishedPageBar(windowId, tabId));
  runHostAction("copyLink", windowId, "someone-else");
  runHostAction("copyLink", windowId, tabId);
  assert.equal(takePageBarCounts().plugin_page_bar_press_copy_link, 1);
  withdrawPageBars(windowId);
  forgetPageDocument(tabId, R);
});

test("review fixes: stale commits, same-document moves, missing reports and another view's cleanup", async () => {
  await enable();
  const T = realTabs(["f", "g", "h"]);
  lifecycle.setPluginValue("developer-mode", "localAddresses", true);
  const url = "http://localhost:7001/";
  const origin = "http://localhost:7001";
  noteTypedAddress(T.f, url);
  notePageDocument(T.f, "http://localhost:7001/old", "http://localhost:7001/old", Date.now() - 10_000, false, R);
  notePageDocument(T.f, url, url, Date.now(), false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", origin), true, "an older commit reported late leaves the newer intent alone");
  const fragment = "http://localhost:7002/a";
  notePageDocument(T.g, fragment, fragment, Date.now() - 5000, false, R);
  noteTypedAddress(T.g, `${fragment}#x`);
  notePageDocument(T.g, `${fragment}#x`, `${fragment}#x`, usePageDocuments.getState()[T.g].at, false, R);
  notePageDocument(T.g, fragment, fragment, Date.now(), false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:7002"), undefined, "a typed fragment change spends nothing later");
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  settledDoc(T.h, LOCAL);
  notePageDocument(T.h, LOCAL, LOCAL, usePageDocuments.getState()[T.h].at, false, R);
  const other = {};
  forgetPageDocument(T.h, other);
  assert.ok(confirmedDocument(usePageDocuments.getState(), T.h), "a departing view can't erase what its replacement reported");
  notePageDocument(T.h, LOCAL, undefined, undefined, false, R);
  assert.equal(usePageDocuments.getState()[T.h], undefined, "a report without commit data clears the document");
  for (const id of [T.f, T.g, T.h]) forgetPageDocument(id, R);
});

test("a same-document change on a shown bar counts no second show", () => {
  takePageBarCounts();
  const match = { plugin: "developer-mode", official: true, spec: {}, url: "http://localhost:7001/", at: 4242, superseded: 0 };
  publishPageBars("w-count", { "t-count": match });
  publishPageBars("w-count", { "t-count": { ...match, url: "http://localhost:7001/#section" } });
  assert.equal(takePageBarCounts().plugin_page_bar_shown_official, 1);
  withdrawPageBars("w-count");
});

test("with no page-bar plugin on, a page commit writes no document and starts no timer; turning the plugin off forgets what it had", async () => {
  await enable();
  notePageDocument("gate", LOCAL, LOCAL, Date.now(), false, R);
  assert.ok(usePageDocuments.getState().gate, "on: the commit is kept");
  lifecycle.disablePlugin("developer-mode", null);
  assert.equal(pageBarsWanted(), false);
  assert.deepEqual(usePageDocuments.getState(), {}, "off: every document and settle timer is dropped");
  const timers = mock.method(globalThis, "setTimeout");
  const writes = mock.fn();
  const unsubscribe = usePageDocuments.subscribe(writes);
  try {
    notePageDocument("gate", LOCAL, LOCAL, Date.now(), false, R);
    notePageDocument("gate", LOCAL, undefined, undefined, false, R);
    forgetPageDocument("gate", R);
    assert.equal(writes.mock.callCount(), 0, "no store write");
    assert.equal(timers.mock.callCount(), 0, "no timer");
  } finally {
    unsubscribe();
    timers.mock.restore();
  }
  assert.deepEqual(usePageDocuments.getState(), {});
});

test("a commit native refused is sent again on the next change instead of being taken as done", async () => {
  await reportPageCommits("automation", false);
  lifecycle.disablePlugin("developer-mode", null);
  stub.commitReports.length = 0;
  stub.commitReportFailures.next = 1;
  await assert.rejects(reportPageCommits("automation", true));
  await reportPageCommits("pageBars", true);
  assert.deepEqual(stub.commitReports, [true, true], "the second reader resends what the first couldn't");
  await reportPageCommits("pageBars", false);
  await reportPageCommits("automation", false);
  assert.equal(stub.commitReports.at(-1), false);
});

test("pages reported before page bars were wanted show their bar as soon as a page-bar plugin turns on", async () => {
  await enable();
  lifecycle.disablePlugin("developer-mode", null);
  assert.equal(pageBarsWanted(), false);
  notePageDocument("early", LOCAL, LOCAL, Date.now() - 5000, false, R);
  assert.equal(usePageDocuments.getState().early, undefined, "nothing tracked while no plugin wants it");
  await enable();
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  assert.equal(pageBarFor(state(), pane("early"))?.url, LOCAL);
  forgetPageDocument("early", R);
});

test("a crashed or discarded page forgets its document, and only a new commit brings the bar back", async () => {
  await enable();
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  const at = Date.now() - 5000;
  settledDoc("gone", LOCAL, at);
  assert.ok(pageBarFor(state(), pane("gone")));
  endPageDocument("gone", R);
  assert.equal(pageBarFor(state(), pane("gone")), null);
  lifecycle.disablePlugin("developer-mode", null);
  await enable();
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  assert.equal(pageBarFor(state(), pane("gone")), null, "turning page bars on again doesn't replay an ended page");
  settledDoc("gone", LOCAL, at + 1);
  assert.ok(pageBarFor(state(), pane("gone")));
  forgetPageDocument("gone", R);
});

test("typed intents: none without a page-bar plugin, none for a navigation a gate held back, and none kept past 20 s or a closed tab", async () => {
  await enable();
  lifecycle.disablePlugin("developer-mode", null);
  noteTypedAddress("x", "http://localhost:4000/");
  assert.equal(typedAddressCount(), 0, "no page-bar plugin, nothing kept");
  await enable();
  lifecycle.setPluginValue("developer-mode", "localAddresses", true);
  const windowId = useBrowser.getState().createWindow({ url: "https://example.com/" });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  setOpeningGate(() => ({ cancel: true }));
  openFromBar("http://localhost:4100/", tabId, "current");
  setOpeningGate(null);
  notePageDocument(tabId, "http://localhost:4100/", "http://localhost:4100/", Date.now() + 10, false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:4100"), undefined);
  const t0 = Date.now();
  const T = realTabs(["old", "new", "closing"]);
  noteTypedAddress(T.old, "http://localhost:4200/", t0);
  noteTypedAddress(T.new, "http://localhost:4300/", t0 + 21_000);
  assert.equal(typedAddressCount(), 1, "an expired intent goes when the next one is noted");
  useBrowser.getState().closeTab(T.new);
  noteTypedAddress(T.closing, "http://localhost:4301/", t0 + 21_000);
  assert.equal(typedAddressCount(), 1, "a closed tab's intent goes when the next one is noted");
  forgetPageDocument(tabId, R);
});

test("the Extensions menu runs only on the document it opened on", async () => {
  await enable();
  const windowId = useBrowser.getState().createWindow({ url: LOCAL });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  const first = Date.now() - 5000;
  settledDoc(tabId, LOCAL, first);
  publishPageBars(windowId, { [tabId]: pageBarFor(state(), pane(tabId)) });
  const opened = { url: LOCAL, at: first };
  assert.equal(hostActionTarget("extensions", windowId, tabId, opened), true);
  settledDoc(tabId, LOCAL, first + 1);
  publishPageBars(windowId, { [tabId]: pageBarFor(state(), pane(tabId)) });
  assert.equal(hostActionTarget("extensions", windowId, tabId, opened), false, "another document committed while the menu was open");
  assert.equal(hostActionTarget("extensions", windowId, tabId), true);
  withdrawPageBars(windowId);
  forgetPageDocument(tabId, R);
});

test("round 2: an allowed async gate keeps the typed intent, a cancelled one never turns the switch on, and a replaced view keeps it", async () => {
  await enable();
  lifecycle.setPluginValue("developer-mode", "localAddresses", true);
  const windowId = useBrowser.getState().createWindow({ url: "https://example.com/" });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  const commit = (url, at) => notePageDocument(tabId, url, url, at, false, R);
  setOpeningGate(() => Promise.resolve(null));
  openFromBar("http://localhost:4400/", tabId, "current");
  setOpeningGate(null);
  await wait(5);
  const other = {};
  forgetPageDocument(tabId, other);
  commit("http://localhost:4400/", Date.now() + 10);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:4400"), true, "allowed after the gate answered");
  setOpeningGate(() => ({ cancel: true }));
  openFromBar("http://localhost:4500/", tabId, "current");
  setOpeningGate(null);
  useBrowser.getState().navigate(tabId, "http://localhost:4500/", { userInitiated: false });
  commit("http://localhost:4500/", Date.now() + 20);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:4500"), undefined, "a later navigation nobody typed turns nothing on");
  const opened = useBrowser.getState().newTab(windowId, { url: "http://localhost:4600/" });
  noteTypedOpen(opened, "http://localhost:4600/");
  notePageDocument(opened, "http://localhost:4600/", "http://localhost:4600/", Date.now() + 30, false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:4600"), true, "a typed address opened in a new tab");
  forgetPageDocument(tabId, R);
  forgetPageDocument(opened, R);
});

test("round 2: an ended page's old report can't bring its document back", async () => {
  await enable();
  setSiteSwitch("developer-mode", "on", LOCAL, true, consentToken());
  const at = Date.now() - 5000;
  settledDoc("ended", LOCAL, at);
  endPageDocument("ended", R);
  settledDoc("ended", LOCAL, at);
  assert.equal(pageBarFor(state(), pane("ended")), null, "the same commit reported again stays ended");
  settledDoc("ended", LOCAL, at + 1);
  assert.ok(pageBarFor(state(), pane("ended")), "a new commit shows it again");
  forgetPageDocument("ended", R);
});

test("round 3: an intent a hook cancels later can't be spent by another user-started navigation to the same address", async () => {
  await enable();
  lifecycle.setPluginValue("developer-mode", "localAddresses", true);
  const windowId = useBrowser.getState().createWindow({ url: "https://example.com/" });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  setOpeningGate(() => Promise.resolve({ cancel: true }));
  openFromBar("http://localhost:4700/", tabId, "current");
  setOpeningGate(null);
  await wait(5);
  useBrowser.getState().navigate(tabId, "http://localhost:4700/", { userInitiated: true });
  notePageDocument(tabId, "http://localhost:4700/", "http://localhost:4700/", Date.now() + 10, false, R);
  assert.equal(siteSwitchValue(P(), "developer-mode", "on", "http://localhost:4700"), undefined);
  forgetPageDocument(tabId, R);
});
