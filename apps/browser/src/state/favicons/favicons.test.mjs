import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;

const native = import.meta.resolve("../../platform/favicons.ts");
const stub = `export * from ${JSON.stringify(native)};
export const faviconsFor = (profile, pages) => globalThis.faviconsForTest(profile, pages);
export const storeFavicon = (...args) => (globalThis.storedFavicons.push(args), Promise.resolve({ stored: true }));
export const iconAccent = (uri) => (globalThis.iconAccentForTest ? globalThis.iconAccentForTest(uri) : Promise.resolve(null));
export const iconTheme = (request) => (globalThis.iconThemeForTest ? globalThis.iconThemeForTest(request) : Promise.resolve(null));
export const fetchFavicon = (src, profile) => (globalThis.fetchFaviconForTest ? globalThis.fetchFaviconForTest(src, profile) : Promise.resolve(null));`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../platform/favicons" && /\/state\/favicons\/(favicons|faviconAccent)\.ts$/.test(context.parentURL ?? ""))
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { adoptFavicons, askFaviconTheme, faviconFailed, faviconOutlived, noteFavicon, pruneEngineFavicons, resolveFavicon, startFavicons, useFavicons } = await import("./favicons.ts");
const { useFavicon } = await import("./faviconHooks.ts");
const { seedFavicons } = await import("./launchFavicons.ts");
const { adoptIconPage, dropOutlivedFavicon, noteIconPage } = await import("./iconPage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { askFaviconAccent, useFaviconAccent, useFaviconAccents } = await import("./faviconAccent.ts");
const { markAsked } = await import("./askedFavicons.ts");
const { unheldIn } = await import("./privateLookups.ts");

const waitFor = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "reached before the deadline");
};

test("an empty lookup that started before an import doesn't wipe the imported icon", async () => {
  useBrowser.getState().hydrate({});
  const page = "https://imported.test/";
  const lookups = [];
  globalThis.storedFavicons = [];
  globalThis.faviconsForTest = (profile, pages) => new Promise((resolve) => lookups.push({ pages, answer: () => resolve({ pages: new Map(), icons: new Map() }) }));
  const row = mount(() => useFavicon(page, null, "default"));
  try {
    await waitFor(() => lookups.some((l) => l.pages.includes(page)));
    adoptFavicons("default", [{ page, icon: `${page}favicon.png`, png: "AAAA" }]);
    assert.equal(resolveFavicon(page, null, "default")?.uri, "data:image/png;base64,AAAA");
    for (const l of lookups) l.answer();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(resolveFavicon(page, null, "default")?.uri, "data:image/png;base64,AAAA");
    await waitFor(() => globalThis.storedFavicons.length === 1);
    assert.deepEqual(globalThis.storedFavicons[0], [engineProfile(useBrowser.getState(), "default"), page, `${page}favicon.png`, "AAAA"]);
  } finally {
    row.unmount();
    delete globalThis.faviconsForTest;
  }
});

test("a tab's icon outlives its page only once the tab has left the icon's site", () => {
  const netflix = "https://www.netflix.com/browse";
  assert.equal(faviconOutlived(netflix, "http://localhost:4321/"), true);
  assert.equal(faviconOutlived(netflix, "file:///Users/me/page.html"), true);
  assert.equal(faviconOutlived(netflix, "about:blank"), true);
  assert.equal(faviconOutlived(netflix, "https://www.netflix.com/title/80057281"), false);
  assert.equal(faviconOutlived(netflix, "https://WWW.netflix.com/browse#row"), false);
  assert.equal(faviconOutlived("http://localhost:4321/", "http://localhost:5173/"), true);
  assert.equal(faviconOutlived(null, "http://localhost:4321/"), false);
  assert.equal(faviconOutlived(netflix, ""), false);
});

test("an icon remembers its page across an engine switch, so the new engine's view still drops it on another site", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const netflix = "https://www.netflix.com/browse";
  const local = "http://localhost:4321/";
  const windowId = S().createWindow({ url: netflix });
  const tabId = S().windows[windowId].tabIds[0];
  S().updateTab(tabId, { url: netflix });
  adoptIconPage(tabId);
  S().updateTab(tabId, { favicon: "https://assets.nflxext.com/favicon.ico" });
  noteIconPage(tabId);
  S().updateTab(tabId, { url: local, title: "" }, { isLoading: true });
  dropOutlivedFavicon(tabId, local, true);
  assert.equal(S().tabs[tabId].favicon, "https://assets.nflxext.com/favicon.ico");
  adoptIconPage(tabId);
  S().updateTab(tabId, { url: local, title: "Local" }, { isLoading: false });
  dropOutlivedFavicon(tabId, local, false);
  assert.equal(S().tabs[tabId].favicon, null);
});

test("an icon stays when the tab finishes loading another page on the icon's site", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const page = "https://www.netflix.com/browse";
  const windowId = S().createWindow({ url: page });
  const tabId = S().windows[windowId].tabIds[0];
  S().updateTab(tabId, { url: page, favicon: "https://assets.nflxext.com/favicon.ico" });
  noteIconPage(tabId);
  S().updateTab(tabId, { url: "https://www.netflix.com/title/1", title: "" }, { isLoading: false });
  dropOutlivedFavicon(tabId, "https://www.netflix.com/title/1", false);
  assert.equal(S().tabs[tabId].favicon, "https://assets.nflxext.com/favicon.ico");
});

const empty = () => Promise.resolve({ pages: new Map(), icons: new Map() });
const answering = (icons) => (profile, pages) => Promise.resolve({ pages: new Map(pages.flatMap((p) => (icons[p] ? [[p, { uri: icons[p] }]] : []))), icons: new Map() });
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const cached = (page) => useFavicons.getState().profiles[engineProfile(useBrowser.getState(), "default")]?.pages[page];

test("a lookup that failed is asked again the next time the page is shown", async () => {
  useBrowser.getState().hydrate({});
  const page = "https://retry.test/";
  const asked = [];
  globalThis.faviconsForTest = (profile, pages) => (asked.push(...pages), asked.length === 1 ? Promise.reject(new Error("engine busy")) : answering({ [page]: "data:image/png;base64,RETRY" })(profile, pages));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const first = mount(() => useFavicon(page, null, "default"));
    await waitFor(() => asked.length === 1);
    await settle();
    first.unmount();
    const second = mount(() => useFavicon(page, null, "default"));
    await waitFor(() => resolveFavicon(page, null, "default")?.uri === "data:image/png;base64,RETRY");
    assert.deepEqual(asked, [page, page]);
    second.unmount();
  } finally {
    console.warn = warn;
    delete globalThis.faviconsForTest;
  }
});

test("a page Chrome has no icon for is answered once, and its own icon is fetched from the page's link", async () => {
  useBrowser.getState().hydrate({});
  const page = "https://no-icon.test/";
  const asked = [];
  const fetched = [];
  globalThis.faviconsForTest = (profile, pages) => (asked.push(...pages), empty());
  globalThis.fetchFaviconForTest = (src) => (fetched.push(src), Promise.resolve({ uri: "data:image/png;base64,LINKED" }));
  globalThis.storedFavicons = [];
  try {
    const row = mount(() => useFavicon(page, "https://no-icon.test/icon.png", "default"));
    await waitFor(() => resolveFavicon(page, "https://no-icon.test/icon.png", "default")?.uri === "data:image/png;base64,LINKED");
    assert.deepEqual(fetched, ["https://no-icon.test/icon.png"]);
    row.unmount();
    const plain = "https://no-icon-plain.test/";
    const again = mount(() => useFavicon(plain, null, "default"));
    await waitFor(() => cached(plain) !== undefined);
    assert.equal(resolveFavicon(plain, null, "default"), null);
    again.unmount();
    const third = mount(() => useFavicon(plain, null, "default"));
    await settle();
    third.unmount();
    assert.deepEqual(asked.filter((p) => p === plain), [plain]);
  } finally {
    delete globalThis.faviconsForTest;
    delete globalThis.fetchFaviconForTest;
  }
});

test("pruning a profile's icons looks the pages still waiting on screen up again", async () => {
  useBrowser.getState().hydrate({});
  const page = "https://pruned.test/";
  const asked = [];
  globalThis.faviconsForTest = (profile, pages) => (asked.push(...pages), empty());
  try {
    const row = mount(() => useFavicon(page, null, "default"));
    await waitFor(() => cached(page) === null);
    pruneEngineFavicons(engineProfile(useBrowser.getState(), "default"));
    await waitFor(() => asked.filter((p) => p === page).length === 2);
    row.unmount();
  } finally {
    delete globalThis.faviconsForTest;
  }
});

test("the cache starts over past 3000 pages with the newest icons, and a waiting row still sees its page answered", async () => {
  useBrowser.getState().hydrate({});
  const known = Array.from({ length: 2990 }, (_, i) => ({ page: `https://cap${i}.test/`, icon: "i", png: `P${i}` }));
  adoptFavicons("default", known);
  assert.equal(cached("https://cap5.test/"), "data:image/png;base64,P5");
  const waiting = "https://cap-waiting.test/";
  globalThis.faviconsForTest = answering({ [waiting]: "data:image/png;base64,LATE" });
  globalThis.storedFavicons = [];
  try {
    const row = mount(() => useFavicon(waiting, null, "default"));
    adoptFavicons("default", Array.from({ length: 20 }, (_, i) => ({ page: `https://over${i}.test/`, icon: "i", png: `O${i}` })));
    assert.equal(cached("https://cap5.test/"), undefined);
    assert.equal(cached("https://over3.test/"), "data:image/png;base64,O3");
    await waitFor(() => resolveFavicon(waiting, null, "default")?.uri === "data:image/png;base64,LATE");
    row.unmount();
  } finally {
    delete globalThis.faviconsForTest;
  }
});

test("a page the cache dropped when it started over is looked up again the next time it is shown", async () => {
  useBrowser.getState().hydrate({});
  const page = "https://dropped.test/";
  const asked = [];
  globalThis.faviconsForTest = (profile, pages) => (asked.push(...pages), answering({ [page]: "data:image/png;base64,DROPPED" })(profile, pages));
  globalThis.storedFavicons = [];
  try {
    const first = mount(() => useFavicon(page, null, "default"));
    await waitFor(() => cached(page) === "data:image/png;base64,DROPPED");
    first.unmount();
    adoptFavicons("default", Array.from({ length: 3001 }, (_, i) => ({ page: `https://flood${i}.test/`, icon: "i", png: `F${i}` })));
    await waitFor(() => cached(page) === undefined);
    const second = mount(() => useFavicon(page, null, "default"));
    await waitFor(() => resolveFavicon(page, null, "default")?.uri === "data:image/png;base64,DROPPED");
    assert.deepEqual(asked.filter((p) => p === page), [page, page]);
    second.unmount();
  } finally {
    delete globalThis.faviconsForTest;
  }
});

test("a page that changes its icon right after the appearance flips keeps both, and shows the one for the appearance", async () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const setDark = (appDark) => useBrowser.setState((s) => ({ ui: { ...s.ui, appDark } }));
  setDark(false);
  const stop = startFavicons();
  const page = "https://github.test/";
  const windowId = S().createWindow({ url: page });
  const tabId = S().windows[windowId].tabIds[0];
  S().updateTab(tabId, { url: page });
  const key = engineProfile(S(), "default");
  seedFavicons({ images: ["data:light", "data:dark", "data:other"], profiles: { [key]: { pages: { [page]: 0 }, srcs: { "https://github.test/dark.svg": 1, "https://github.test/other.svg": 2 } } }, themes: {} });
  try {
    setDark(true);
    noteFavicon(tabId, "https://github.test/dark.svg");
    await settle();
    assert.equal(resolveFavicon(page, null, "default")?.uri, "data:dark");
    setDark(false);
    assert.equal(resolveFavicon(page, null, "default")?.uri, "data:light");
    const now = Date.now;
    Date.now = () => now() + 6000;
    try {
      const other = "https://other-site.test/";
      S().updateTab(tabId, { url: other });
      seedFavicons({ images: ["data:before"], profiles: { [key]: { pages: { [other]: 0 }, srcs: {} } }, themes: {} });
      noteFavicon(tabId, "https://github.test/other.svg");
      await settle();
      assert.equal(resolveFavicon(other, null, "default")?.uri, "data:other");
      setDark(true);
      assert.equal(resolveFavicon(other, null, "default")?.uri, "data:other");
    } finally {
      Date.now = now;
    }
  } finally {
    setDark(false);
    stop();
  }
});

const heldLookups = () => {
  const held = [];
  globalThis.faviconsForTest = (profile, pages) => new Promise((resolve) => held.push({ pages, answer: (icons = {}) => resolve({ pages: new Map(pages.flatMap((p) => (icons[p] ? [[p, { uri: icons[p] }]] : []))), icons: new Map() }) }));
  return held;
};

const pruneRaces = {
  "the older lookup answers first, with no icon": (before, after, page) => [() => before.answer(), () => after.answer({ [page]: "data:image/png;base64,FRESH" })],
  "the older lookup answers first, with a stale icon": (before, after, page) => [() => before.answer({ [page]: "data:image/png;base64,STALE" }), () => after.answer({ [page]: "data:image/png;base64,FRESH" })],
  "the newer lookup answers first": (before, after, page) => [() => after.answer({ [page]: "data:image/png;base64,FRESH" }), () => before.answer({ [page]: "data:image/png;base64,STALE" })],
};

for (const [n, [order, answersFor]] of Object.entries(pruneRaces).entries())
  test(`after a prune, the lookup a new row starts wins over the one from before the prune (${order})`, async () => {
    useBrowser.getState().hydrate({});
    const page = `https://pruned-race-${n}.test/`;
    const held = heldLookups();
    try {
      const first = mount(() => useFavicon(page, null, "default"));
      await waitFor(() => held.length === 1);
      pruneEngineFavicons(engineProfile(useBrowser.getState(), "default"));
      first.unmount();
      const second = mount(() => useFavicon(page, null, "default"));
      await waitFor(() => held.length === 2);
      const [before, after] = held;
      for (const answer of answersFor(before, after, page)) {
        answer();
        await settle();
      }
      assert.equal(resolveFavicon(page, null, "default")?.uri, "data:image/png;base64,FRESH");
      second.unmount();
    } finally {
      delete globalThis.faviconsForTest;
    }
  });

test("an icon the page reported during a lookup still wins after the cache starts over and drops it", async () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const page = "https://evicted-race.test/";
  const windowId = S().createWindow({ url: page });
  const tabId = S().windows[windowId].tabIds[0];
  S().updateTab(tabId, { url: page });
  const key = engineProfile(S(), "default");
  seedFavicons({ images: ["data:image/png;base64,NEW"], profiles: { [key]: { pages: {}, srcs: { "https://evicted-race.test/new.png": 0 } } }, themes: {} });
  const held = heldLookups();
  globalThis.storedFavicons = [];
  try {
    const row = mount(() => useFavicon(page, null, "default"));
    await waitFor(() => held.some((l) => l.pages.includes(page)));
    noteFavicon(tabId, "https://evicted-race.test/new.png");
    await settle();
    assert.equal(cached(page), "data:image/png;base64,NEW");
    adoptFavicons("default", Array.from({ length: 3000 }, (_, i) => ({ page: `https://evict${i}.test/`, icon: "i", png: `E${i}` })));
    assert.equal(cached(page), undefined);
    for (const l of held) l.answer({ [page]: "data:image/png;base64,OLD" });
    await settle();
    assert.notEqual(cached(page), "data:image/png;base64,OLD");
    row.unmount();
  } finally {
    delete globalThis.faviconsForTest;
  }
});

const privateWindow = (url) => {
  const s = useBrowser.getState();
  const id = s.createWindow({ kind: "private", url });
  return { id, profile: useBrowser.getState().windows[id].profileId, tab: useBrowser.getState().windows[id].tabIds[0] };
};

test("an icon a private tab reports after its window closed doesn't bring the page back into memory", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const w = privateWindow("https://late-icon.test/");
  let answer;
  webviews.set(w.tab, { downloadFavicon: () => new Promise((resolve) => (answer = resolve)) });
  try {
    noteFavicon(w.tab, "https://late-icon.test/favicon.ico");
    useBrowser.getState().closeWindow(w.id);
    await waitFor(() => !!answer);
    answer({ uri: "data:image/png;base64,LATE", width: 32, height: 32 });
    await settle();
    assert.equal(useFavicons.getState().profiles[w.profile], undefined);
  } finally {
    webviews.clear();
    stop();
  }
});

test("a private tab's icon leaves the theme and accent caches with its window, late answers included", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const shown = "data:image/png;base64,PRIVATESHOWN";
  const pending = "data:image/png;base64,PRIVATEPENDING";
  const w = privateWindow("https://private-theme.test/");
  webviews.set(w.tab, { downloadFavicon: (src) => Promise.resolve({ uri: src.endsWith("a.ico") ? shown : pending, width: 32, height: 32 }) });
  const held = [];
  globalThis.iconThemeForTest = ({ uri }) => (uri === pending ? new Promise((resolve) => held.push(() => resolve({ kind: "template" }))) : Promise.resolve({ kind: "full" }));
  try {
    noteFavicon(w.tab, "https://private-theme.test/a.ico");
    await waitFor(() => resolveFavicon("https://private-theme.test/", null, w.profile)?.uri === shown);
    noteFavicon(w.tab, "https://private-theme.test/b.ico");
    await waitFor(() => Object.values(useFavicons.getState().profiles[w.profile]?.srcs ?? {}).includes(pending));
    askFaviconTheme(shown);
    askFaviconTheme(pending);
    await waitFor(() => useFavicons.getState().themes[shown] !== undefined && held.length === 1);
    useFaviconAccents.setState({ byUri: { [shown]: "#123456" } });
    useBrowser.getState().closeWindow(w.id);
    await waitFor(() => useFavicons.getState().profiles[w.profile] === undefined);
    held[0]();
    await settle();
    assert.equal(useFavicons.getState().themes[shown], undefined);
    assert.equal(useFavicons.getState().themes[pending], undefined, "a theme that answered after the close isn't kept");
    assert.equal(useFaviconAccents.getState().byUri[shown], undefined);
  } finally {
    delete globalThis.iconThemeForTest;
    webviews.clear();
    stop();
  }
});

test("a private icon that already left the cache still takes its theme and accent with it at close", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const uri = "data:image/png;base64,PRIVATEEVICTED";
  const w = privateWindow("https://evicted-theme.test/");
  webviews.set(w.tab, { downloadFavicon: () => Promise.resolve({ uri, width: 32, height: 32 }) });
  globalThis.iconThemeForTest = () => Promise.resolve({ kind: "full" });
  try {
    noteFavicon(w.tab, "https://evicted-theme.test/a.ico");
    await waitFor(() => resolveFavicon("https://evicted-theme.test/", null, w.profile)?.uri === uri);
    askFaviconTheme(uri);
    await waitFor(() => useFavicons.getState().themes[uri] !== undefined);
    useFaviconAccents.setState({ byUri: { [uri]: "#654321" } });
    faviconFailed(w.profile, uri);
    await waitFor(() => !Object.values(useFavicons.getState().profiles[w.profile]?.srcs ?? {}).includes(uri));
    useBrowser.getState().closeWindow(w.id);
    await waitFor(() => useFavicons.getState().profiles[w.profile] === undefined);
    assert.equal(useFavicons.getState().themes[uri], undefined);
    assert.equal(useFaviconAccents.getState().byUri[uri], undefined);
  } finally {
    delete globalThis.iconThemeForTest;
    webviews.clear();
    stop();
  }
});

test("closing a private window cancels no other window's theme or accent request, and keeps no late private answer", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const shared = "data:image/png;base64,SHAREDICON";
  const only = "data:image/png;base64,PRIVATEONLY";
  const s = () => useBrowser.getState();
  const normalWindow = s().createWindow({ url: "https://shared-icon.test/" });
  const normalTab = s().windows[normalWindow].tabIds[0];
  const w = privateWindow("https://shared-icon.test/");
  const [, privateTab] = [w.tab, s().newTab(w.id, { url: "https://private-only-icon.test/" })];
  const icons = { [normalTab]: shared, [w.tab]: shared, [privateTab]: only };
  for (const [tab, uri] of Object.entries(icons)) webviews.set(tab, { downloadFavicon: () => Promise.resolve({ uri, width: 32, height: 32 }) });
  const themes = new Map();
  const accents = new Map();
  globalThis.iconThemeForTest = ({ uri }) => new Promise((resolve) => themes.set(uri, resolve));
  globalThis.iconAccentForTest = (uri) => new Promise((resolve) => accents.set(uri, resolve));
  globalThis.faviconsForTest = () => empty();
  try {
    noteFavicon(normalTab, "https://shared-icon.test/a.ico");
    noteFavicon(w.tab, "https://shared-icon.test/a.ico");
    noteFavicon(privateTab, "https://private-only-icon.test/b.ico");
    await waitFor(() => resolveFavicon("https://private-only-icon.test/", null, w.profile)?.uri === only && resolveFavicon("https://shared-icon.test/", null, "default")?.uri === shared);
    askFaviconTheme(shared);
    askFaviconTheme(only);
    const rows = [mount(() => useFaviconAccent("https://shared-icon.test/", "default")), mount(() => useFaviconAccent("https://private-only-icon.test/", w.profile))];
    await waitFor(() => themes.size === 2 && accents.size === 2);
    for (const row of rows) row.unmount();
    s().closeWindow(w.id);
    await waitFor(() => useFavicons.getState().profiles[w.profile] === undefined);
    for (const resolve of themes.values()) resolve({ kind: "full" });
    for (const resolve of accents.values()) resolve("#112233");
    await settle();
    assert.deepEqual(useFavicons.getState().themes[shared], { kind: "full" }, "the regular window's theme request survived the close");
    assert.equal(useFaviconAccents.getState().byUri[shared], "#112233", "and its accent request");
    assert.equal(useFavicons.getState().themes[only], undefined);
    assert.equal(useFaviconAccents.getState().byUri[only], undefined);
  } finally {
    delete globalThis.iconThemeForTest;
    delete globalThis.iconAccentForTest;
    delete globalThis.faviconsForTest;
    webviews.clear();
    stop();
  }
});

test("a private window's close leaves a pending theme request alone, so a stale answer can't land over a newer one", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const uri = "data:image/png;base64,STALETHEME";
  const w = privateWindow("https://stale-theme.test/");
  webviews.set(w.tab, { downloadFavicon: () => Promise.resolve({ uri, width: 32, height: 32 }) });
  const replies = [];
  globalThis.iconThemeForTest = () => new Promise((resolve) => replies.push(resolve));
  try {
    noteFavicon(w.tab, "https://stale-theme.test/a.ico");
    await waitFor(() => resolveFavicon("https://stale-theme.test/", null, w.profile)?.uri === uri);
    askFaviconTheme(uri);
    await waitFor(() => replies.length === 1);
    useBrowser.getState().closeWindow(w.id);
    await waitFor(() => useFavicons.getState().profiles[w.profile] === undefined);
    askFaviconTheme(uri);
    await settle();
    replies[0](null);
    await settle();
    assert.equal(useFavicons.getState().themes[uri], undefined, "the answer from before the close isn't stored");
    for (const reply of replies.slice(1)) reply({ kind: "full" });
    await settle();
    assert.equal(useFavicons.getState().themes[uri], undefined, "nothing holds the private icon any more");
  } finally {
    delete globalThis.iconThemeForTest;
    webviews.clear();
    stop();
  }
});

test("a theme or accent asked for after its private window closed is never requested or kept", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const uri = "data:image/png;base64,ASKEDTOOLATE";
  const w = privateWindow("https://asked-too-late.test/");
  webviews.set(w.tab, { downloadFavicon: () => Promise.resolve({ uri, width: 32, height: 32 }) });
  const requested = [];
  globalThis.iconThemeForTest = ({ uri: asked }) => (requested.push(asked), Promise.resolve({ kind: "full" }));
  globalThis.iconAccentForTest = (asked) => (requested.push(asked), Promise.resolve("#abcdef"));
  try {
    noteFavicon(w.tab, "https://asked-too-late.test/a.ico");
    await waitFor(() => resolveFavicon("https://asked-too-late.test/", null, w.profile)?.uri === uri);
    useBrowser.getState().closeWindow(w.id);
    await waitFor(() => useFavicons.getState().profiles[w.profile] === undefined);
    askFaviconTheme(uri);
    askFaviconAccent(uri);
    await settle();
    assert.deepEqual(requested, []);
    assert.equal(useFavicons.getState().themes[uri], undefined);
    assert.equal(useFaviconAccents.getState().byUri[uri], undefined);
  } finally {
    delete globalThis.iconThemeForTest;
    delete globalThis.iconAccentForTest;
    webviews.clear();
    stop();
  }
});

test("a private icon's pending theme and accent requests go at close, so a regular window that gets the same icon asks afresh", async () => {
  useBrowser.getState().hydrate({});
  const stop = startFavicons();
  const uri = "data:image/png;base64,HANDEDOVER";
  const s = () => useBrowser.getState();
  const w = privateWindow("https://handed-over.test/");
  const normalWindow = s().createWindow({ url: "https://handed-over.test/" });
  const normalTab = s().windows[normalWindow].tabIds[0];
  for (const tab of [w.tab, normalTab]) webviews.set(tab, { downloadFavicon: () => Promise.resolve({ uri, width: 32, height: 32 }) });
  const themes = [];
  const accents = [];
  globalThis.iconThemeForTest = () => new Promise((resolve) => themes.push(resolve));
  globalThis.iconAccentForTest = () => new Promise((resolve) => accents.push(resolve));
  try {
    noteFavicon(w.tab, "https://handed-over.test/a.ico");
    await waitFor(() => resolveFavicon("https://handed-over.test/", null, w.profile)?.uri === uri);
    askFaviconTheme(uri);
    askFaviconAccent(uri);
    await waitFor(() => themes.length === 1 && accents.length === 1);
    s().closeWindow(w.id);
    await waitFor(() => useFavicons.getState().profiles[w.profile] === undefined);
    noteFavicon(normalTab, "https://handed-over.test/a.ico");
    await waitFor(() => resolveFavicon("https://handed-over.test/", null, "default")?.uri === uri);
    askFaviconTheme(uri);
    askFaviconAccent(uri);
    await waitFor(() => themes.length === 2 && accents.length === 2);
    themes[0](null);
    accents[0](null);
    await settle();
    assert.equal(useFavicons.getState().themes[uri], undefined, "the private request's answer isn't kept");
    assert.equal(useFaviconAccents.getState().byUri[uri], undefined);
    themes[1]({ kind: "full" });
    accents[1]("#0a0b0c");
    await settle();
    assert.deepEqual(useFavicons.getState().themes[uri], { kind: "full" });
    assert.equal(useFaviconAccents.getState().byUri[uri], "#0a0b0c");
  } finally {
    delete globalThis.iconThemeForTest;
    delete globalThis.iconAccentForTest;
    webviews.clear();
    stop();
  }
});

test("checking whether an icon is still held reuses one set until the icon caches change", () => {
  const pages = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`https://held-${i}.test/`, `data:image/png;base64,HELD${i}`]));
  const profiles = Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, { pages, srcs: {}, appearances: {} }]));
  const first = unheldIn(profiles);
  assert.equal(unheldIn(profiles), first, "the same cache state gives the same set");
  const started = performance.now();
  for (let i = 0; i < 300; i++) unheldIn(profiles)(`data:image/png;base64,HELD${i}`);
  assert.ok(performance.now() - started < 50, "300 checks against 12,000 cached icons stay cheap");
  assert.equal(first("data:image/png;base64,HELD7"), false);
  assert.equal(first("data:image/png;base64,ELSEWHERE"), true);
  assert.notEqual(unheldIn({ ...profiles }), first, "a new cache state is read again");
});
