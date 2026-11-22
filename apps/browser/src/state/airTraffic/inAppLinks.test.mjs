import assert from "node:assert/strict";
import { test } from "node:test";

const stub = await import("../../test-native/index.ts");
const native = await import("../../test-native/ardiacore.ts");
const { useBrowser } = await import("../browser/store.ts");
const store = await import("./store.ts");
const { reloadHooks } = await import("../automation/hookRules.ts");
const { resetApprovalsForTests } = await import("../automation/approvals.ts");
const { takeAirTrafficCounts } = await import("../telemetry/airTrafficCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { openFromPage } = await import("../tabs/openFromPage.ts");
const { setOpeningGate } = await import("../tabs/openingGate.ts");
const { startClosingWindow, stopClosingWindow } = await import("../windows/closingWindows.ts");
const { commitTypedUrl, openFromBar } = await import("../omnibox/openFromBar.ts");
const { openFromNewTabBar } = await import("../omnibox/newTabBar.ts");
const { navigationOf } = await import("../tabs/pageSession.ts");
const { inAppLinkRoute, routePageClick } = await import("./inAppLinks.ts");
const { inAppLinkRoutes, MAX_PAGE_LINK_ROUTES, pageLinkPatterns, signInLink } = await import("./pageLinkRoutes.ts");
const { inAppLinkRoutesByEngineProfile, startInAppLinkSync } = await import("./inAppLinkSync.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const slackApp = { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };

let next = 0;
const rule = (over = {}) => ({ id: `t${++next}`, enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "tab", ...over });
const counted = (over) => ({ air_traffic_rule_links: 0, air_traffic_fallback_links: 0, air_traffic_group_links: 0, air_traffic_in_app_links: 0, air_traffic_in_app_clicks: 0, air_traffic_in_app_typed: 0, air_traffic_in_app_click_misses: 0, ...over });

function fresh({ rules: list = [], inAppLinks = true } = {}) {
  setOpeningGate(null);
  setConsentPeriod(true, "in-app-links");
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const work = S().createProfile({ name: "Work" });
  resetApprovalsForTests();
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks: [] }));
  reloadHooks();
  store.resetAirTrafficForTests({ rules: list.map((r) => (typeof r === "function" ? r(work) : r)), fallback: null, inAppLinks });
  const windowId = S().createWindow({ url: "https://a.example/" });
  const page = { windowId, profileId: "default", tabId: S().windows[windowId].tabIds[0] };
  takeAirTrafficCounts();
  return { work, page };
}

const inProfile = (url, profileId) => Object.values(S().tabs).find((t) => t.url === url && t.profileId === profileId);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const toWork = (when, over = {}) => (w) => rule({ when, profileId: w, ...over });

test("a link a page opens in a new tab routes only with the switch on, and only when it came from a click without an opener", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "site", host: "github.com" })], inAppLinks: false });
  openFromPage({ url: "https://github.com/off", disposition: "foreground", fromClick: true, userGesture: true }, page);
  assert.ok(inProfile("https://github.com/off", "default"));
  store.setAirTrafficInAppLinks(true);
  openFromPage({ url: "https://github.com/blank", disposition: "foreground", fromClick: true, userGesture: true, adoptId: "tab:9" }, page);
  openFromPage({ url: "https://github.com/cmd", disposition: "background", userGesture: true }, page);
  assert.ok(inProfile("https://github.com/blank", work), "a target=_blank click lands in Work");
  assert.ok(inProfile("https://github.com/cmd", work), "a ⌘-click lands in Work");
  openFromPage({ url: "https://github.com/opener", disposition: "foreground", userGesture: true }, page);
  openFromPage({ url: "https://github.com/popup", disposition: "foreground", fromClick: true, userGesture: true, popup: true }, page);
  openFromPage({ url: "https://github.com/rel-opener", disposition: "foreground", fromClick: true, opener: true, userGesture: true }, page);
  assert.ok(inProfile("https://github.com/rel-opener", "default"), "a clicked link or window.open that keeps its opener stays with it");
  assert.ok(inProfile("https://github.com/opener", "default"), "a window.open the page keeps a handle on stays with its opener");
  assert.ok(inProfile("https://github.com/popup", "default"), "a pop-up opened as a tab stays with its opener");
  assert.deepEqual(takeAirTrafficCounts(), counted({ air_traffic_in_app_links: 2 }));
});

test("a sign-in link never routes, whether clicked, opened in a new tab or typed", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  const signIns = [
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fa.example%2Fcb",
    "https://github.com/login/oauth/authorize?client_id=abc",
    "https://login.microsoftonline.com/common/oauth2/authorize",
    "https://sso.example/saml?SAMLRequest=abc",
  ];
  for (const url of signIns) assert.ok(signInLink(url), url);
  assert.ok(!signInLink("https://github.com/ardia?tab=readme"));
  for (const url of signIns) {
    openFromPage({ url, disposition: "foreground", fromClick: true, userGesture: true }, page);
    assert.equal(inAppLinkRoute(url, page), null);
  }
  assert.ok(signIns.every((url) => !inProfile(url, work)));
  assert.deepEqual(takeAirTrafficCounts(), counted());
});

test("a ⇧-click Peek runs first and is never routed; with Peek on another key the ⇧-click window routes", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  S().updateSettings({ peekModifier: "shift" });
  openFromPage({ url: "https://b.example/peek", disposition: "window", shiftClick: true, userGesture: true }, page);
  assert.ok(!inProfile("https://b.example/peek", work));
  S().updateSettings({ peekModifier: "alt" });
  openFromPage({ url: "https://b.example/window", disposition: "window", shiftClick: true, userGesture: true }, page);
  assert.ok(inProfile("https://b.example/window", work));
});

test("an app-specific rule, a private window and a rule to the page's own profile never route", () => {
  const { work, page } = fresh({ rules: [rule({ when: { kind: "site", host: "keep.example" }, profileId: "default" }), (w) => rule({ from: slackApp, profileId: w }), toWork({ kind: "site", host: "keep.example" })] });
  openFromPage({ url: "https://keep.example/x", disposition: "foreground", fromClick: true, userGesture: true }, page);
  openFromPage({ url: "https://slack.example/x", disposition: "foreground", fromClick: true, userGesture: true }, page);
  assert.ok(inProfile("https://keep.example/x", "default"));
  assert.ok(inProfile("https://slack.example/x", "default"));
  store.resetAirTrafficForTests({ rules: [rule({ profileId: work })], fallback: null, inAppLinks: true });
  const privateId = S().createWindow({ kind: "private", url: "https://secret.example/" });
  const privatePage = { windowId: privateId, profileId: S().windows[privateId].profileId, tabId: S().windows[privateId].tabIds[0] };
  openFromPage({ url: "https://b.example/private", disposition: "foreground", fromClick: true, userGesture: true }, privatePage);
  const opened = Object.values(S().tabs).find((t) => t.url === "https://b.example/private");
  assert.notEqual(opened?.profileId, work);
  assert.equal(inAppLinkRoute("https://b.example/x", privatePage), null);
});

test("a source window that closes while the tab.opening hook decides routes nothing", async () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  let answer;
  setOpeningGate(() => new Promise((resolve) => (answer = resolve)));
  openFromPage({ url: "https://b.example/late", disposition: "foreground", fromClick: true, userGesture: true }, page);
  S().closeWindow(page.windowId);
  answer(null);
  await settle();
  assert.ok(!Object.values(S().tabs).some((t) => t.url === "https://b.example/late"));
  setOpeningGate(null);
  assert.ok(work);
});

test("a source window that is closing when the hook answers routes nothing", async () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  let answer;
  setOpeningGate(() => new Promise((resolve) => (answer = resolve)));
  openFromPage({ url: "https://b.example/closing", disposition: "foreground", fromClick: true, userGesture: true }, page);
  startClosingWindow(page.windowId);
  answer(null);
  await settle();
  stopClosingWindow(page.windowId);
  assert.ok(!inProfile("https://b.example/closing", work));
  setOpeningGate(null);
});

test("a typed address opened in a new tab asks tab.opening first: a cancel stops it, a rewrite routes the new address", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "site", host: "routed.example" })] });
  const asked = [];
  setOpeningGate((url) => (asked.push(url), url.includes("cancel") ? { cancel: true } : url.includes("rewrite") ? { url: "https://routed.example/rewritten" } : null));
  openFromBar("https://routed.example/cancel", page.tabId, "newTab", true);
  assert.ok(!Object.values(S().tabs).some((t) => t.url === "https://routed.example/cancel"));
  openFromBar("https://other.example/rewrite", page.tabId, "newTab", true);
  assert.ok(inProfile("https://routed.example/rewritten", work));
  assert.deepEqual(asked, ["https://routed.example/cancel", "https://other.example/rewrite"]);
  setOpeningGate(null);
});

test("a typed address whose tab closes while the hook decides routes nothing", async () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  const other = S().newTab(page.windowId, { url: "https://c.example/" });
  let answer;
  setOpeningGate(() => new Promise((resolve) => (answer = resolve)));
  commitTypedUrl("https://b.example/typed", { ...page, tabId: other });
  S().closeTab(other);
  answer(null);
  await settle();
  assert.ok(!inProfile("https://b.example/typed", work));
  setOpeningGate(null);
});

test("a plain click the app routes leaves its tab; one it declines loads in place and is counted as a miss", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "site", host: "github.com" })] });
  routePageClick(page.tabId, "https://github.com/ardia");
  assert.ok(inProfile("https://github.com/ardia", work));
  assert.equal(S().tabs[page.tabId].url, "https://a.example/");
  routePageClick(page.tabId, "https://plain.example/x");
  assert.equal(navigationOf(S().tabs[page.tabId])?.url, "https://plain.example/x");
  assert.deepEqual(takeAirTrafficCounts(), counted({ air_traffic_in_app_clicks: 1, air_traffic_in_app_click_misses: 1 }));
});

test("a typed address routes from the address bar; a typed search never does", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  openFromBar("https://search.example/?q=github.com", page.tabId, "current", false);
  assert.equal(navigationOf(S().tabs[page.tabId])?.url, "https://search.example/?q=github.com");
  openFromBar("https://github.com/typed", page.tabId, "current", true);
  assert.ok(inProfile("https://github.com/typed", work));
  assert.deepEqual(takeAirTrafficCounts(), counted({ air_traffic_in_app_typed: 1 }));
});

test("the New Tab bar keeps a typed search over an empty card in its profile and routes a typed address", () => {
  const { work, page } = fresh({ rules: [toWork({ kind: "any" })] });
  const card = S().newTab(page.windowId, {});
  S().openPanel(page.windowId, "", { kind: "into", tabId: card });
  openFromNewTabBar(page.windowId, { kind: "into", tabId: card }, "https://search.example/?q=ardia", false);
  assert.equal(navigationOf(S().tabs[card])?.url, "https://search.example/?q=ardia");
  assert.equal(S().tabs[card].profileId, "default");
  const second = S().newTab(page.windowId, {});
  S().openPanel(page.windowId, "", { kind: "into", tabId: second });
  openFromNewTabBar(page.windowId, { kind: "into", tabId: second }, "https://b.example/bar", true);
  assert.ok(inProfile("https://b.example/bar", work), "an address typed over an empty card routes");
  assert.deepEqual(takeAirTrafficCounts(), counted({ air_traffic_in_app_typed: 1 }));
});

const formOf = (flags, url) => {
  if (flags !== "ih" && flags !== "ip") return url;
  const parsed = new URL(url);
  return (flags === "ih" ? parsed.hostname : `${parsed.hostname}${parsed.pathname}${parsed.search}`).toLowerCase();
};
const pageDecides = (routes, url) => {
  if (!/^https?:/i.test(url)) return false;
  for (const [source, flags, action] of routes) {
    if ((flags === "ih" || flags === "ip") && /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)) continue;
    if (new RegExp(source, flags ? "i" : "").test(formOf(flags, url))) return action === "route";
  }
  return false;
};

const URLS = [
  "https://github.com/",
  "https://github.com/ardia",
  "https://gist.github.com:8443/x",
  "http://user@github.com/ardia",
  "https://evilgithub.com/",
  "https://github.com.evil.example/",
  "https://example.com/docs",
  "https://example.com/docs/",
  "https://example.com:8443/docs/a",
  "https://www.example.com/docs/a?x=1#y",
  "https://example.com/doc",
  "https://shop.example.org/a",
  "https://example.org/A/",
  "https://www.example.org/a?q=1",
  "https://example.org:443/a#top",
  "https://example.org:8080/a",
  "https://example.org/a/b",
  "https://keep.example/docs",
  "https://wiki.example.net/Help/DOCS/page",
  "https://www.docs.example/",
  "https://wwwdocs.example/",
  "https://shop.xn--bcher-kva.de/x",
  "https://shop.bucher.de/x",
  "https://accounts.google.com/signin",
  "https://a.example/cb?redirect_uri=https%3A%2F%2Fgithub.com",
  "ftp://github.com/x",
  "https://example.org/a//",
  "https://user@example.org/a",
  "https://x.example/?q=docs",
  "https://x.example/#docs",
  "https://example.org/%7Ea",
  "https://www.example.org/",
  "https://[::1]:8080/docs/a",
  "https://127.0.0.1/docs",
  "http://example.org/",
  "http://example.org:80/a",
  "https://example.org:80/a",
  "https://h.example/xaxbxcx",
  "https://h.example/abca",
  "https://h.example/acb",
  "https://example.org/archive/docs",
  "https://h.example:8443/x",
];

const CONDITIONS = [
  { kind: "any" },
  { kind: "site", host: "github.com" },
  { kind: "pattern", pattern: "github" },
  { kind: "pattern", pattern: "*git*" },
  { kind: "pattern", pattern: "https://*.example.com/docs/*" },
  { kind: "pattern", pattern: "*://example.org/*" },
  { kind: "pattern", pattern: "*.example.org/a*" },
  { kind: "pattern", pattern: "*.bücher.de" },
  { kind: "pattern", pattern: "<all_urls>" },
  { kind: "contains", text: "docs" },
  { kind: "contains", text: "www.docs" },
  { kind: "equals", text: "example.org/a" },
  { kind: "equals", text: "https://example.org:8080/a/" },
  { kind: "pattern", pattern: "https://example.org:80/*" },
  { kind: "pattern", pattern: "http://example.org:80/*" },
  { kind: "pattern", pattern: "*://*/a*b*c*" },
  { kind: "pattern", pattern: "*e*a*/*a*" },
  { kind: "pattern", pattern: "*/docs*" },
  { kind: "pattern", pattern: "*:8443*" },
];

test("the routes pushed to a page decide every click exactly as the app does: each condition alone, after a rule that keeps links, and with an earlier rule to the same profile", () => {
  const { work, page } = fresh();
  const keep = rule({ when: { kind: "site", host: "keep.example" }, profileId: "default" });
  const sameProfileFirst = rule({ when: { kind: "contains", text: "doc" }, profileId: "default" });
  const lastUsed = rule({ when: { kind: "site", host: "example.org" }, profileId: null });
  const localDocs = rule({ when: { kind: "pattern", pattern: "*/docs*" }, profileId: "default" });
  for (const when of CONDITIONS)
    for (const before of [[], [keep], [sameProfileFirst], [lastUsed], [localDocs]]) {
      store.resetAirTrafficForTests({ rules: [...before, rule({ when, profileId: work })], fallback: null, inAppLinks: true });
      const routes = inAppLinkRoutes(store.currentAirTraffic(), new Set(["default"]), store.targetUsableNow, "default");
      for (const url of URLS) assert.equal(pageDecides(routes, url), inAppLinkRoute(url, page) !== null, `${JSON.stringify(when)} after ${before.length ? before[0].when.kind : "nothing"}: ${url}`);
    }
});

test("no routes are pushed when nothing would leave the profile, and a full rule list fits the page's limit", () => {
  const { work } = fresh({ rules: [rule({ profileId: "default" })] });
  assert.deepEqual(inAppLinkRoutes(store.currentAirTraffic(), new Set(["default"]), store.targetUsableNow, "default"), []);
  const many = Array.from({ length: 100 }, (_, i) => rule({ when: { kind: "site", host: `xn--bcher-kva${i}.de` }, profileId: work }));
  store.resetAirTrafficForTests({ rules: many, fallback: null, inAppLinks: true });
  const routes = inAppLinkRoutes(store.currentAirTraffic(), new Set(["default"]), store.targetUsableNow, "default");
  assert.ok(routes.length <= MAX_PAGE_LINK_ROUTES);
  assert.ok(pageDecides(routes, "https://xn--bcher-kva99.de/"), "the hundredth rule still reaches the page");
});

test("profiles that share data get one list, and a click between them is left to the page instead of cancelled", () => {
  const { work } = fresh();
  const twin = S().createProfile({ name: "Twin", shareWith: "default" });
  store.resetAirTrafficForTests({
    rules: [rule({ when: { kind: "site", host: "twin.example" }, profileId: twin }), rule({ when: { kind: "site", host: "home.example" }, profileId: "default" }), rule({ when: { kind: "site", host: "work.example" }, profileId: work })],
    fallback: null,
    inAppLinks: true,
  });
  const byKey = inAppLinkRoutesByEngineProfile();
  const shared = JSON.parse(byKey.get(""));
  assert.ok(!pageDecides(shared, "https://twin.example/") && !pageDecides(shared, "https://home.example/"), "neither Personal nor Twin cancels a click bound for the other");
  assert.ok(pageDecides(shared, "https://work.example/"));
  const workRoutes = JSON.parse(byKey.get(S().profiles[work].dataId ?? work));
  assert.ok(pageDecides(workRoutes, "https://twin.example/") && pageDecides(workRoutes, "https://home.example/") && !pageDecides(workRoutes, "https://work.example/"));
});

test("generated routes stay fast on long addresses, take default ports per scheme, and a pattern that can't compile ends the list", () => {
  const { work } = fresh();
  const slow = { kind: "pattern", pattern: "*/a*a*a*a*a*a*a*z" };
  const routes = pageLinkPatterns(slow);
  const started = performance.now();
  for (const [source, flags] of routes) new RegExp(source, flags ? "i" : "").test(formOf(flags, `https://h.example/${"a".repeat(8000)}`));
  assert.ok(performance.now() - started < 100, `took ${performance.now() - started} ms`);
  const port80 = pageLinkPatterns({ kind: "pattern", pattern: "https://example.org:80/*" });
  assert.ok(!port80.some(([source, flags]) => new RegExp(source, flags).test("https://example.org/")));
  assert.ok(port80.some(([source, flags]) => new RegExp(source, flags).test("https://example.org:80/")));
  assert.ok(signInLink("https://accounts.google.com./"));
  assert.doesNotThrow(() => pageLinkPatterns({ kind: "pattern", pattern: "https://x.example/\ud800*" }));
  store.resetAirTrafficForTests({ rules: [rule({ when: { kind: "site", host: "a.example" }, profileId: work })], fallback: null, inAppLinks: true });
  assert.ok(inAppLinkRoutes(store.currentAirTraffic(), new Set(["default"]), store.targetUsableNow, "default").length > 0);
});

test("the sync pushes each engine profile's routes once and clears them when the switch goes off", () => {
  fresh({ rules: [toWork({ kind: "site", host: "github.com" })] });
  native.inAppLinkRoutesByProfile.clear();
  startInAppLinkSync();
  assert.ok(pageDecides(native.inAppLinkRoutesByProfile.get(""), "https://github.com/x"));
  store.setAirTrafficInAppLinks(false);
  assert.deepEqual(native.inAppLinkRoutesByProfile.get(""), []);
});
