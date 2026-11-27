import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const organize = await import("../pins/tabCleanup.ts");
const clearedTabs = await import("../pins/clearedTabs.ts");
const { controllingSearchExtension, defaultSearchEngine, searchUrlPrefix } = await import("../settings/settings.ts");
const media = await import("../media/media.ts");
const { splitTabIdsOf } = await import("../splits/splits.ts");

let clock = Date.now();
Date.now = () => (clock += 1000);
const S = () => useBrowser.getState();
const view = (w) => model.viewTabIds(S(), w).map((id) => S().tabs[id].url);
const short = (url) => url.replace(/^https:\/\/|\.com$/g, "");
const hosts = (w) => S().windows[w].tabIds.map((id) => short(S().tabs[id].url));
const shown = (w) => short(S().tabs[model.activeTabId(S(), w)].url);

const reset = (settings = {}) => {
  S().hydrate({});
  S().updateSettings({ cmdClickCreatesTabGroup: false, newTabPosition: "bottom", ...settings });
};
const open = (w, url, opener, background = true) => S().newTab(w, { url: `${url}.com`, openerId: opener, background });
const setup = (...urls) => {
  const w = S().createWindow({ url: `${urls[0]}.com` });
  const ids = [S().windows[w].tabIds[0], ...urls.slice(1).map((u) => S().newTab(w, { url: `${u}.com` }))];
  S().activate(ids[0]);
  return [w, ...ids];
};

test("links opened behind line up after their opener in order", () => {
  reset();
  const [w, a] = setup("a", "b");
  open(w, "c1", a);
  open(w, "c2", a);
  open(w, "c3", a);
  assert.deepEqual(hosts(w), ["a", "c1", "c2", "c3", "b"]);
  assert.equal(shown(w), "a", "opened behind: the opener stays in front");
});

test("closing the shown tab goes back to the tab used before it, not its neighbour", () => {
  reset();
  const [w, a, , c] = setup("a", "b", "c");
  S().activate(c);
  S().activate(a);
  S().closeTab(a);
  assert.equal(shown(w), "c", "not b, the tab after it");
  const d = open(w, "d", c, false);
  S().closeTab(d);
  assert.equal(shown(w), "c", "a page opened in front goes back to its opener");
});

test("tabs opened behind don't count as used until they're shown", () => {
  reset();
  const [w, a, b] = setup("a", "b");
  S().activate(b);
  S().activate(a);
  const c1 = open(w, "c1", a);
  open(w, "c2", a);
  S().activate(c1);
  const g = open(w, "g", c1);
  S().closeTab(c1);
  assert.equal(shown(w), "a", "not a tab it opened or a sibling");
  assert.equal(S().tabs[g].openerId, a, "a closed tab's tabs take its opener");
  S().closeTab(a);
  assert.equal(shown(w), "b", "not the tabs a opened behind");
});

test("closing a regular tab goes back to the pinned tab you came from", () => {
  reset();
  const [w, p, , b] = setup("p", "a", "b");
  S().togglePin(p);
  S().activate(p);
  S().activate(b);
  S().closeTab(b);
  assert.equal(shown(w), "p");
});

test("closing goes to a tab opened behind before a closed pinned tab, so the pin doesn't load again", () => {
  reset();
  const [w, p, a] = setup("p", "a");
  S().togglePin(p);
  S().activate(p);
  S().closeTab(p);
  S().activate(a);
  open(w, "b", a);
  S().closeTab(a);
  assert.equal(shown(w), "b");
  assert.ok(!S().tabs[p].page.nav, "the pin stays closed");
});

test("the tab used before wins even in a collapsed group, over tabs opened behind", () => {
  reset();
  const [w, a, b] = setup("a", "b", "x");
  const g = S().createGroup([a], { name: "G" });
  S().activate(a);
  S().activate(b);
  S().updateGroup(g, { collapsed: true });
  open(w, "c", b);
  S().closeTab(b);
  assert.equal(shown(w), "a");
});

test("the tab a close shows counts as used, so the next close comes back to it", () => {
  reset();
  const [w, a, b, c] = setup("a", "b", "c");
  S().createSplit([a, c]);
  S().activate(b);
  S().activate(c);
  S().closeTab(c);
  assert.equal(shown(w), "a", "the split's other pane");
  const d = open(w, "d", a, false);
  S().closeTab(d);
  assert.equal(shown(w), "a");
});

test("closing a group that holds the shown tab shows the tab just above the group", () => {
  reset({ cmdClickCreatesTabGroup: true });
  const [w, pin, home] = setup("pin", "home");
  S().togglePin(pin);
  S().activate(home);
  S().activate(pin);
  const c1 = open(w, "c1", pin);
  open(w, "c2", pin);
  const group = Object.values(S().groups)[0];
  S().moveTab(home, 0);
  S().activate(c1);
  S().closeGroup(group.id);
  assert.equal(shown(w), "home", "not the pinned opener");
});

test("a pinned tab's links keep their group down to the last one; a loose tab's group of two ends with one", () => {
  reset({ cmdClickCreatesTabGroup: true });
  const [w, pin, home] = setup("pin", "home");
  S().togglePin(pin);
  S().activate(pin);
  const c1 = open(w, "c1", pin);
  const c2 = open(w, "c2", pin);
  const gathered = () => Object.values(S().groups).find((g) => g.pinnedOpenerId === pin);
  assert.deepEqual(gathered()?.tabIds, [c1, c2]);
  S().closeTab(c1);
  assert.deepEqual(gathered()?.tabIds, [c2], "the pinned tab's group started with one link and keeps its last");
  const c3 = open(w, "c3", pin);
  assert.deepEqual(gathered()?.tabIds, [c2, c3]);
  S().activate(home);
  const l1 = open(w, "l1", home);
  assert.ok(Object.values(S().groups).some((g) => g.tabIds.includes(home) && g.tabIds.includes(l1)));
  S().closeTab(l1);
  assert.ok(!Object.values(S().groups).some((g) => g.tabIds.includes(home)));
});

test("closing a pinned tab selects the regular tab the window showed last, not the neighbour", () => {
  reset();
  const [w, p, q, , b] = setup("p", "q", "a", "b", "c");
  S().togglePin(p);
  S().togglePin(q);
  S().activate(b);
  S().activate(q);
  S().activate(p);
  S().closeTab(p);
  assert.equal(model.activeTabId(S(), w), b, "back to the regular tab used before the pinned ones");
  assert.ok(S().tabs[b].page.nav);
  assert.ok(S().tabs[q].page.nav, "the other pinned tab keeps its page");
});

test("closing a pinned row shows the pinned row used before it while its page is loaded, even over a regular tab used since", () => {
  reset();
  const [w, a, b, n] = setup("a", "b", "n");
  S().pinTabs([a, b], true, true);
  S().activate(b);
  S().activate(n);
  S().activate(a);
  S().closeTab(a);
  assert.equal(model.activeTabId(S(), w), b);
  assert.ok(!S().tabs[a].page.nav, "the closed row is unloaded");
});

test("closing a pinned row with no other loaded row goes to the regular tab", () => {
  reset();
  const [w, a, b, n] = setup("a", "b", "n");
  S().pinTabs([a, b], true, true);
  S().activate(b);
  S().activate(n);
  S().activate(a);
  S().closeTab(b);
  assert.ok(!S().tabs[b].page.nav, "the other row is unloaded first");
  S().closeTab(a);
  assert.equal(model.activeTabId(S(), w), n);
  assert.ok(!S().tabs[b].page.nav, "the unloaded row stays unloaded");
});

test("closing a pane of a pinned split unloads both panes and shows the other loaded row, not a regular tab", () => {
  reset();
  const [w, a, b, n, r] = setup("a", "b", "n", "r");
  S().pinTabs([a, b], true, true);
  S().createSplit([a, n]);
  S().activate(b);
  S().activate(r);
  S().activate(a);
  S().closeTab(a);
  assert.equal(model.activeTabId(S(), w), b);
  assert.ok(!S().tabs[a].page.nav && !S().tabs[n].page.nav, "both panes are unloaded");
});

test("groups stay contiguous; splits need two panes", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const b = S().newTab(w, { url: "b.com" });
  const c = S().newTab(w, { url: "c.com" });
  const a = model.viewTabIds(S(), w)[0];
  const g = S().createGroup([a, c], { name: "G" });
  assert.deepEqual(S().windows[w].tabIds, [a, c, b]);
  assert.deepEqual(S().groups[g].tabIds, [a, c]);
  S().addTabsToGroup(g, [b]);
  assert.deepEqual(S().groups[g].tabIds, [a, c, b]);
  S().closeTab(c);
  assert.deepEqual(S().groups[g].tabIds, [a, b]);
  const sp = S().createSplit([a, b]);
  S().closeTab(b);
  assert.equal(S().splits[sp], undefined);
  S().closeTab(a);
  assert.equal(S().closedWindows.at(-1).groups.length, 1);
});

test("closing the focused pane of a split shows the pane left, not the next tab", () => {
  reset();
  const w = S().createWindow({ url: "https://a.com" });
  const a = model.viewTabIds(S(), w)[0];
  const b = S().newTab(w, { url: "https://b.com" });
  S().newTab(w, { url: "https://c.com" });
  const sp = S().createSplit([a, b]);
  S().activate(b);
  S().closeTab(b);
  assert.equal(S().splits[sp], undefined, "the split dissolves");
  assert.equal(shown(w), "a", "the other pane stays on screen as a tab");
  assert.deepEqual(hosts(w), ["a", "c"]);
});

test("closing one pane of a three-pane split keeps the split and shows the pane used last", () => {
  reset();
  const w = S().createWindow({ url: "https://a.com" });
  const a = model.viewTabIds(S(), w)[0];
  const b = S().newTab(w, { url: "https://b.com" });
  const c = S().newTab(w, { url: "https://c.com" });
  S().newTab(w, { url: "https://d.com" });
  const sp = S().createSplit([a, b, c]);
  S().activate(b);
  S().updateTab(a, { lastActiveAt: 1 });
  S().updateTab(c, { lastActiveAt: 2 });
  S().closeTab(b);
  assert.deepEqual(splitTabIdsOf(S().splits[sp]), [a, c]);
  assert.equal(shown(w), "c");
});

test("hydrate drops broken splits", () => {
  reset();
  const w = S().createWindow({ url: "a.com" });
  const a = model.viewTabIds(S(), w)[0];
  const b = S().newTab(w, { url: "b.com" });
  S().hydrate({
    windows: S().windows,
    windowOrder: S().windowOrder,
    tabs: S().tabs,
    splits: {
      ok: { id: "ok", windowId: w, orientation: "horizontal", slots: [{ size: 0.5, tabId: a }, { size: 0.5, tabId: b }] },
      stale: { id: "stale", windowId: w, orientation: "horizontal", slots: [{ size: 0.5, tabId: a }, { size: 0.5, tabId: "gone" }] },
    },
  });
  assert.deepEqual(Object.keys(S().splits), ["ok"]);
});

test("clean up closes duplicates and stale tabs into Recently Cleaned, and restores", () => {
  reset();
  const [w, a, b, c, d] = setup("a", "b", "a", "d");
  const e = S().newTab(w, { url: "e.com" });
  S().pinTabs([d], true);
  const old = Date.now() - 13 * 3600_000;
  S().updateTab(b, { lastActiveAt: old });
  S().updateTab(d, { lastActiveAt: old });
  S().activate(a);
  assert.deepEqual(organize.cleanUpCandidates(S(), w), [b, c]);
  assert.equal(S().cleanUpTabs(w), 2);
  assert.deepEqual(view(w).sort(), ["https://a.com", "https://d.com", "https://e.com"]);
  assert.equal(S().cleanedTabs.length, 2);
  S().restoreCleaned();
  assert.equal(S().cleanedTabs.length, 0);
  assert.equal(view(w).length, 5);
  assert.ok(S().tabs[e]);
});

test("one clean-up keeps every tab it closes in Recently Cleaned, past the cap, so Undo brings them all back", () => {
  reset();
  const many = organize.MAX_CLEANED + 20;
  const [w] = setup("a", ...Array(many).fill("a"));
  assert.equal(S().cleanUpTabs(w), many);
  assert.equal(S().cleanedTabs.length, many);
  S().restoreCleaned(S().cleanedTabs.map((c) => c.id), w);
  assert.equal(view(w).length, many + 1);
  open(w, "a");
  assert.equal(S().cleanUpTabs(w), many + 1);
  assert.equal(S().cleanedTabs.length, many + 1, "the newest batch is whole even when it alone is past the cap");
  open(w, "b");
  S().updateTab(model.viewTabIds(S(), w).find((id) => S().tabs[id].url === "https://b.com"), { lastActiveAt: Date.now() - 13 * 3600_000 });
  S().activate(model.viewTabIds(S(), w)[0]);
  assert.equal(S().cleanUpTabs(w), 1);
  assert.equal(S().cleanedTabs.length, organize.MAX_CLEANED, "a later clean-up trims older entries back to the cap");
});

test("a reopened group's and cleaned tabs' tabs take their back/forward lists back", () => {
  reset();
  const [w, a, b, c, d] = setup("a", "b", "c", "d");
  const g = S().createGroup([b, c], { name: "G" });
  S().closeGroup(g);
  S().restoreClosed(S().closedGroups.at(-1).id);
  const adopts = (id) => S().tabs[id].page.adopt ?? S().tabs[id].page.wake;
  const back = Object.values(S().groups).find((x) => x.name === "G");
  assert.deepEqual(back.tabIds.map(adopts), [`restore:${b}`, `restore:${c}`]);
  const g2 = S().createGroup([d], { name: "Old" });
  S().closeGroup(g2);
  const entry = S().closedGroups.at(-1);
  useBrowser.setState({ closedGroups: [...S().closedGroups.slice(0, -1), { ...entry, tabIds: undefined }] });
  S().restoreClosed(entry.id);
  const old = Object.values(S().groups).find((x) => x.name === "Old");
  assert.equal(adopts(old.tabIds[0]), undefined);
  assert.ok(S().tabs[old.tabIds[0]].url.includes("d.com"));
  S().updateTab(a, { lastActiveAt: Date.now() - 13 * 3600_000 });
  assert.equal(S().cleanUpTabs(w), 1);
  S().restoreCleaned();
  const restored = S().windows[w].tabIds.find((id) => adopts(id) === `restore:${a}`);
  assert.ok(restored, "the cleaned tab comes back with its list");
});

test("a reopened tab not shown yet keeps its back/forward list's source through another close", () => {
  reset();
  const [w, , b, c] = setup("a", "b", "c");
  const g = S().createGroup([b, c], { name: "G" });
  S().closeGroup(g);
  S().restoreClosed(S().closedGroups.at(-1).id);
  const [, c2] = Object.values(S().groups).find((x) => x.name === "G").tabIds;
  assert.equal(S().tabs[c2].page.wake, `restore:${c}`, "the second tab hasn't been shown");
  S().closeGroup(Object.values(S().groups).find((x) => x.name === "G").id);
  S().restoreClosed(S().closedGroups.at(-1).id);
  const [, c3] = Object.values(S().groups).find((x) => x.name === "G").tabIds;
  assert.equal(S().tabs[c3].page.wake, `restore:${c}`);
  S().closeTab(c3);
  S().reopenClosedTab();
  const c4 = S().windows[w].tabIds.find((id) => S().tabs[id].url.includes("c.com"));
  assert.equal(S().tabs[c4].page.adopt ?? S().tabs[c4].page.wake, `restore:${c}`);
});

test("a pinned group's reopened tab, closed before it was shown, still wakes with its back/forward list", () => {
  reset();
  const [, , b, c] = setup("a", "b", "c");
  const g = S().groupTabs([b, c], { name: "P" });
  assert.equal(S().groups[g].pinned, true);
  S().closeGroup(g);
  S().restoreClosed(S().closedGroups.at(-1).id);
  const [, c2] = Object.values(S().groups).find((x) => x.name === "P").tabIds;
  assert.equal(S().tabs[c2].page.wake, `restore:${c}`);
  S().closeTab(c2);
  assert.equal(S().tabs[c2]?.page.kind, "asleep", "it keeps its row");
  S().activate(c2);
  assert.equal(S().tabs[c2].page.adopt, `restore:${c}`);
});

test("a pinned group's reopened tab not shown yet keeps its back/forward list through parking in the last window's close", () => {
  reset();
  const [w, , b, c] = setup("a", "b", "c");
  const g = S().groupTabs([b, c], { name: "P" });
  S().closeGroup(g);
  S().restoreClosed(S().closedGroups.at(-1).id);
  const [, c2] = Object.values(S().groups).find((x) => x.name === "P").tabIds;
  S().closeTab(c2);
  assert.equal(S().tabs[c2].page.wake, `restore:${c}`);
  S().closeWindow(w);
  assert.ok(S().parkedPins.default, "the profile's pins are parked");
  const n = S().createWindow();
  const back = S().windows[n].tabIds.find((id) => S().tabs[id].url.includes("c.com"));
  S().activate(back);
  assert.equal(S().tabs[back].page.adopt, `restore:${c}`);
});

test("Settings shows the tab layout of the window in front, not a default it no longer follows", () => {
  reset({ tabLayout: "sidebar" });
  const [w] = setup("a");
  S().toggleTabLayout(w);
  S().toggleTabLayout(w);
  S().updateSettings({ tabLayout: "top" }, { fromSync: true });
  assert.equal(S().windows[w].tabLayout, "sidebar", "the window keeps its own layout");
  assert.equal(model.tabLayoutOf(S()), "sidebar", "so Settings shows that one");
  S().toggleTabLayout(w);
  assert.equal(model.tabLayoutOf(S()), "top");
});

test("⇧⌘T reopens only what the window's shown profile closed", () => {
  reset();
  const [w, , b] = setup("a", "b");
  S().closeTab(b);
  const p = S().createProfile({ name: "Work" });
  S().switchProfile(w, p);
  const work = S().newTab(w, { url: "w.com" });
  S().reopenClosed(w);
  assert.equal(S().windows[w].profileId, p, "it stays on Work");
  assert.ok(!Object.values(S().tabs).some((t) => short(t.url) === "b"), "the default profile's tab stays closed");
  S().closeTab(work);
  S().reopenClosed(w);
  assert.ok(Object.values(S().tabs).some((t) => short(t.url) === "w" && t.profileId === p), "Work's own tab comes back");
  S().switchProfile(w, "default");
  S().reopenClosedTab(w);
  assert.ok(Object.values(S().tabs).some((t) => short(t.url) === "b" && t.profileId === "default"));
});

test("switching tabs in one profile keeps another profile's opener links in the same window", () => {
  reset();
  const [w, a] = setup("a", "b");
  const c = open(w, "c", a);
  const p = S().createProfile({ name: "Work" });
  S().switchProfile(w, p);
  const w1 = model.activeTabId(S(), w);
  const w2 = S().newTab(w, { url: "w2.com", background: true });
  const w3 = open(w, "w3", w1);
  S().activate(w3);
  S().activate(w2);
  assert.equal(S().tabs[w3].openerId, null, "Work's own opener links clear on a switch, as before");
  assert.equal(S().tabs[c].openerId, a, "a switch in Work keeps the default profile's opener link");
  open(w, "w4", w2, false);
  S().navigate(w2, "typed.com");
  assert.equal(S().tabs[c].openerId, a, "a link opened in front and a typed address in Work keep it too");
  S().switchProfile(w, "default");
  open(w, "c2", a);
  const personal = hosts(w).filter((_, i) => S().tabs[S().windows[w].tabIds[i]].profileId === "default");
  assert.deepEqual(personal, ["a", "c", "c2", "b"], "the next link from the same tab still lines up after the first");
});

test("tabs closed together come back to their places, from ⇧⌘T or Recently Closed in any order (#2492)", () => {
  reset();
  const [w, , b, c, , e] = setup("a", "b", "c", "d", "e");
  S().closeTabs([b, c, e]);
  assert.deepEqual(hosts(w), ["a", "d"]);
  S().reopenClosed(w);
  assert.deepEqual(hosts(w), ["a", "d", "e"]);
  S().reopenClosed(w);
  S().reopenClosed(w);
  assert.deepEqual(hosts(w), ["a", "b", "c", "d", "e"]);
  const [, b2, c2] = S().windows[w].tabIds;
  S().closeTabs([b2, c2]);
  const entry = (host) => S().closedTabs.find((x) => short(x.tab.url) === host).id;
  S().restoreClosed(entry("b"), w);
  S().restoreClosed(entry("c"), w);
  assert.deepEqual(hosts(w), ["a", "b", "c", "d", "e"]);
});

test("abandoned New Tab cleanup never closes a window or the tab it shows", () => {
  reset();
  const w = S().createWindow();
  S().newTab(w, { background: true });
  const front = S().newTab(w);
  S().closeAbandonedNewTabs();
  assert.deepEqual(S().windows[w].tabIds, [front]);
  const p = S().createProfile({ name: "Work" });
  S().switchProfile(w, p);
  const work = model.activeTabId(S(), w);
  S().switchProfile(w, "default");
  S().closeAbandonedNewTabs();
  assert.ok(S().tabs[work] && S().tabs[front]);
  const w2 = S().createWindow();
  S().newTab(w2);
  useBrowser.setState((s) => ({ windows: { ...s.windows, [w2]: { ...s.windows[w2], activeTabIds: {} } } }));
  S().closeAbandonedNewTabs();
  assert.equal(S().windows[w2].tabIds.length, 1);
});

test("an extension that took the default search engine controls it until it goes", () => {
  reset();
  const ddg = {
    profile: "",
    extensionId: "dcielhccnenaljfdmekhnepaeenphgjp",
    extensionName: "Search Fixture Default",
    name: "DuckDuckGo Fixture",
    keyword: "ddgfix",
    url: "https://duckduckgo.com/?q=%s&t=nnfixture",
    isDefault: true,
  };
  const wiki = { ...ddg, extensionId: "lfkochledepkdapbginilfnephdpkfjc", extensionName: "Search Fixture Extra", name: "Wikipedia Fixture", keyword: "wfix", url: "https://en.wikipedia.org/w/index.php?search=%s", isDefault: false };
  S().updateSettings({ searchEngine: "bing", extensionSearchEngines: [ddg, wiki] });
  assert.equal(controllingSearchExtension(S().settings)?.extensionId, ddg.extensionId);
  assert.equal(defaultSearchEngine(S().settings).id, `extension:${ddg.extensionId}`);
  assert.equal(searchUrlPrefix(S().settings), ddg.url);

  S().updateSettings({ extensionSearchEngines: [wiki] });
  assert.equal(controllingSearchExtension(S().settings), undefined);
  assert.equal(defaultSearchEngine(S().settings).id, "bing");

  S().setSearchEngine(`extension:${wiki.extensionId}`);
  assert.equal(defaultSearchEngine(S().settings).name, "Wikipedia Fixture");
  S().updateSettings({ extensionSearchEngines: [] });
  assert.equal(defaultSearchEngine(S().settings).id, "google", "a removed engine falls back to Google");
});

test("closing the mini player lasts until its tab plays again", async () => {
  const M = () => media.useMedia.getState();
  const report = (overrides = {}) => ({
    title: "Song", artist: "Band", album: "", artwork: null, playbackState: "playing", position: 10, duration: 200,
    playbackRate: 1, timestamp: Date.now(), hasVideo: false, actions: ["play", "pause"], controllable: true, ...overrides,
  });
  reset();
  const w = S().createWindow({ url: "a.com" });
  const [a] = model.viewTabIds(S(), w);
  const b = S().newTab(w, { url: "b.com", background: true });
  const c = S().newTab(w, { url: "c.com", background: true });

  media.setNowPlaying(b, report());
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  assert.equal(media.playerTabFor(M(), [a, b, c]), b, "the tab that played");
  media.setNowPlaying(b, report({ playbackState: "paused" }));
  await new Promise((resolve) => setTimeout(resolve, 3));
  media.setNowPlaying(c, report());
  assert.equal(media.playerTabFor(M(), [a, b, c]), c, "the tab that played last");

  media.useMedia.setState({ dismissed: { [c]: true } });
  assert.equal(media.playerTabFor(M(), [a, b, c]), b);
  media.setNowPlaying(c, report({ position: 30 }));
  assert.equal(M().dismissed[c], true, "still playing: stays dismissed");
  media.setNowPlaying(c, report({ playbackState: "paused" }));
  media.setNowPlaying(c, report());
  assert.equal(M().dismissed[c], undefined, "played again");
  assert.equal(media.playerTabFor(M(), [a, b, c]), c);

  S().closeTab(b);
  assert.equal(M().sessions[b], undefined);
});

test("Clear closes the unselected unpinned tabs into Recently Closed, keeps pinned tabs and pinned groups, and undoes", () => {
  reset();
  const [w, a, b, c, d, e, f] = setup("a", "b", "c", "d", "e", "f");
  S().pinTabs([a], true);
  const pinnedGroup = S().groupTabs([b], { name: "P" });
  const g = S().createGroup([d, e], { name: "G" });
  S().updateGroup(g, { color: "blue" });
  S().activate(e);
  const before = hosts(w);
  assert.deepEqual(clearedTabs.unpinnedTabIds(S(), w), [c, d, e, f]);
  const cleared = S().clearUnpinnedTabs(w);
  assert.equal(cleared.entries.length, 3);
  assert.deepEqual(hosts(w), ["a", "b", "e"]);
  assert.equal(shown(w), "e", "the selected tab stays selected");
  assert.ok(S().groups[pinnedGroup], "the pinned group stays");
  assert.deepEqual(S().groups[g].tabIds, [e], "the selected tab keeps its group");
  assert.deepEqual(S().closedTabs.slice(-3).map((x) => short(x.tab.url)), ["c", "d", "f"]);
  S().undoClearTabs(cleared);
  assert.deepEqual(hosts(w), before);
  assert.equal(shown(w), "e");
  const back = Object.values(S().groups).filter((x) => x.name === "G");
  assert.equal(back.length, 1, "undo refills the group, no second one");
  assert.deepEqual(back[0].tabIds.map((id) => short(S().tabs[id].url)), ["d", "e"]);
  assert.equal(back[0].color, "blue");
  assert.equal(S().closedTabs.length, 0, "undone tabs leave Recently Closed");
  assert.equal(S().clearUnpinnedTabs(w).entries.length, 3);
  S().reopenClosedTab(w);
  assert.deepEqual(hosts(w), ["a", "b", "e", "f"], "⇧⌘T brings the last one back");
});

test("Clear keeps the selected tab's split and tabs playing media, and a second click closes the split but keeps the media", () => {
  reset();
  const [w, a, b, , d] = setup("a", "b", "c", "d", "e");
  S().createSplit([a, b]);
  S().activate(a);
  S().updateLive(d, { playingAudio: true });
  const before = hosts(w);
  const cleared = S().clearUnpinnedTabs(w);
  assert.deepEqual(cleared.entries.map((x) => short(x.tab.url)), ["c", "e"]);
  assert.deepEqual(hosts(w), ["a", "b", "d"]);
  assert.equal(shown(w), "a");
  assert.ok(Object.values(S().splits).some((v) => splitTabIdsOf(v).includes(a) && splitTabIdsOf(v).includes(b)), "the split stays whole");
  S().undoClearTabs(cleared);
  assert.deepEqual(hosts(w), before);
  assert.equal(shown(w), "a");
  S().clearUnpinnedTabs(w);
  const second = S().clearUnpinnedTabs(w);
  assert.deepEqual(second.entries.map((x) => short(x.tab.url)), ["a", "b"]);
  assert.deepEqual(hosts(w), ["d"], "the playing tab keeps playing");
  S().undoClearTabs(second);
  assert.deepEqual(hosts(w), ["a", "b", "d"]);
  assert.equal(shown(w), "a");
});

test("Clear and undo bring an automatic group back whole, with the member Clear kept", () => {
  reset({ cmdClickCreatesTabGroup: true });
  const [w, a] = setup("a", "c");
  const b = open(w, "b", a);
  assert.equal(Object.values(S().groups)[0].autoUngroup, true);
  S().activate(b);
  const cleared = S().clearUnpinnedTabs(w);
  assert.deepEqual(hosts(w), ["b"]);
  assert.equal(Object.keys(S().groups).length, 0, "with one member left the automatic group dissolves");
  S().undoClearTabs(cleared);
  assert.deepEqual(hosts(w), ["a", "b", "c"]);
  const groups = Object.values(S().groups);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].tabIds.map((id) => short(S().tabs[id].url)), ["a", "b"]);
  assert.equal(groups[0].autoUngroup, true);
});

test("Clear and undo keep a nested group inside the automatic group it was in", () => {
  reset({ cmdClickCreatesTabGroup: true });
  const [w, a] = setup("a", "c");
  const b = open(w, "b", a);
  const parent = Object.values(S().groups)[0].id;
  const child = S().groupTabs([b], { pinned: false, name: "C" });
  assert.equal(S().groups[child].parentId, parent);
  S().activate(b);
  const cleared = S().clearUnpinnedTabs(w);
  assert.equal(S().groups[parent], undefined, "the automatic group dissolves");
  S().undoClearTabs(cleared);
  assert.deepEqual(hosts(w), ["a", "b", "c"]);
  const auto = Object.values(S().groups).find((g) => g.autoUngroup);
  const nested = Object.values(S().groups).find((g) => g.name === "C");
  assert.equal(nested.parentId, auto.id);
  assert.deepEqual(auto.tabIds.map((id) => short(S().tabs[id].url)), ["a", "b"]);
  assert.deepEqual(nested.tabIds.map((id) => short(S().tabs[id].url)), ["b"]);
});

test("Undo of Clear keeps a rename or collapse made after Clear", () => {
  reset();
  const [w, , , d, e] = setup("a", "b", "d", "e");
  const g = S().createGroup([d, e], { name: "G" });
  S().activate(e);
  const cleared = S().clearUnpinnedTabs(w);
  S().updateGroup(g, { name: "Renamed", color: "red", collapsed: true });
  S().undoClearTabs(cleared);
  assert.deepEqual(hosts(w), ["a", "b", "d", "e"]);
  assert.deepEqual(S().groups[g].tabIds.map((id) => short(S().tabs[id].url)), ["d", "e"]);
  assert.equal(S().groups[g].name, "Renamed");
  assert.equal(S().groups[g].color, "red");
  assert.equal(S().groups[g].collapsed, true);
});

const nestedInAutomatic = () => {
  reset({ cmdClickCreatesTabGroup: true });
  const [w, a] = setup("a", "c");
  const b = open(w, "b", a);
  const child = S().groupTabs([b], { pinned: false, name: "C" });
  S().activate(b);
  return { w, b, child, cleared: S().clearUnpinnedTabs(w) };
};

const frozen = (w) => JSON.stringify({ tabs: S().windows[w].tabIds, groups: S().groups, closed: S().closedTabs.map((c) => c.id) });

for (const [name, edit] of [
  ["moves the surviving group into another group", ({ w, child }) => S().moveGroup(child, { pinned: false, parentId: S().groupTabs([open(w, "d")], { pinned: false, name: "Q" }) })],
  ["ungroups the surviving group", ({ child }) => S().ungroup(child)],
  ["pins the surviving group", ({ child }) => S().moveGroup(child, { pinned: true })],
  ["pins the surviving tab", ({ b }) => S().pinTabs([b], true)],
  ["reopens the cleared tab with ⇧⌘T", ({ w }) => S().reopenClosedTab(w)],
]) {
  test(`Undo of Clear does nothing once the user ${name}`, () => {
    const ctx = nestedInAutomatic();
    edit(ctx);
    const before = frozen(ctx.w);
    S().undoClearTabs(ctx.cleared);
    assert.equal(frozen(ctx.w), before);
    assert.equal(clearedTabs.canUndoClear(S(), ctx.cleared), false);
  });
}

test("Undo of Clear still works after changes in another window", () => {
  const ctx = nestedInAutomatic();
  const other = S().createWindow({ url: "z.com" });
  S().newTab(other, { url: "y.com" });
  assert.equal(clearedTabs.canUndoClear(S(), ctx.cleared), true);
  S().undoClearTabs(ctx.cleared);
  assert.deepEqual(hosts(ctx.w), ["a", "b", "c"]);
});

test("a second Clear closes the tab the first one kept, as in Arc, and undo brings it back selected (#3947)", () => {
  reset();
  const [w, a] = setup("a", "b", "c");
  S().pinTabs([a], true);
  S().activate(S().windows[w].tabIds.find((id) => short(S().tabs[id].url) === "c"));
  S().clearUnpinnedTabs(w);
  assert.deepEqual(hosts(w), ["a", "c"]);
  const second = S().clearUnpinnedTabs(w);
  assert.deepEqual(second.entries.map((x) => short(x.tab.url)), ["c"]);
  assert.deepEqual(hosts(w), ["a"]);
  assert.equal(S().clearUnpinnedTabs(w), null, "pinned tabs stay");
  S().undoClearTabs(second);
  assert.deepEqual(hosts(w), ["a", "c"]);
  assert.equal(shown(w), "c");
});

test("a second Clear keeps the selected tab while it plays sound, as the first does", () => {
  reset();
  const [w, a] = setup("a", "b");
  S().updateLive(a, { playingAudio: true });
  S().clearUnpinnedTabs(w);
  assert.deepEqual(hosts(w), ["a"]);
  assert.equal(S().clearUnpinnedTabs(w), null, "the playing selected tab stays");
  assert.deepEqual(hosts(w), ["a"]);
});

test("Undo of a second Clear puts the selected split back together", () => {
  reset();
  const [w, a, b] = setup("a", "b");
  S().createSplit([a, b], "vertical");
  S().activate(a);
  const cleared = S().clearUnpinnedTabs(w);
  assert.deepEqual(cleared.entries.map((x) => short(x.tab.url)), ["a", "b"]);
  assert.equal(Object.keys(S().splits).length, 0);
  S().undoClearTabs(cleared);
  const splits = Object.values(S().splits);
  assert.equal(splits.length, 1, "one split again");
  assert.deepEqual(splitTabIdsOf(splits[0]).map((id) => short(S().tabs[id].url)), ["a", "b"]);
  assert.equal(splits[0].orientation, "vertical");
  assert.equal(shown(w), "a");
});

test("Clear on the blank tab a second Clear left does nothing, and the earlier Undo still works", () => {
  reset();
  const [w] = setup("a");
  const cleared = S().clearUnpinnedTabs(w);
  const blank = S().windows[w].tabIds.slice();
  assert.equal(S().clearUnpinnedTabs(w), null, "no blank tab swapped for another");
  assert.deepEqual(S().windows[w].tabIds, blank);
  assert.equal(clearedTabs.canUndoClear(S(), cleared), true);
  S().undoClearTabs(cleared);
  assert.deepEqual(hosts(w), ["a"]);
});

test("Undo of a second Clear after switching profiles brings the tab back in its profile without switching back", () => {
  reset();
  const [w] = setup("a");
  const p = S().createProfile({ name: "Work" });
  S().switchProfile(w, p);
  S().switchProfile(w, "default");
  const cleared = S().clearUnpinnedTabs(w);
  S().switchProfile(w, p);
  assert.equal(clearedTabs.canUndoClear(S(), cleared), true, "switching profiles leaves the toast's Undo working");
  S().undoClearTabs(cleared);
  assert.equal(S().windows[w].profileId, p, "the window stays on Work");
  const back = S().windows[w].activeTabIds.default;
  assert.equal(short(S().tabs[back].url), "a", "the default profile's selected tab is the one Clear closed");
  S().switchProfile(w, "default");
  assert.equal(shown(w), "a");
});

const splitShape = (split) => ({ panes: splitTabIdsOf(split).map((id) => short(S().tabs[id].url || "(blank)")), sizes: split.slots.map((slot) => Math.round(slot.size * 1000) / 1000) });
const splitWith = (id) => Object.values(S().splits).find((v) => splitTabIdsOf(v).includes(id));

test("Undo of Clear puts an unpinned pane back into the split it shared with pinned tiles, in its place and at its size", () => {
  reset();
  const [w, p1, p2, u, x] = setup("p1", "p2", "u", "x");
  S().pinTabs([p1, p2], true);
  S().createSplit([p1, p2, u]);
  const before = splitShape(splitWith(p1));
  assert.deepEqual(before.panes, ["p1", "p2", "u"]);
  assert.ok(S().tabs[p1].pin && S().tabs[p2].pin && !S().tabs[u].pin, "two pinned tiles and an unpinned pane");
  S().activate(x);
  const cleared = S().clearUnpinnedTabs(w);
  assert.deepEqual(cleared.entries.map((e) => short(e.tab.url)), ["u"]);
  assert.deepEqual(splitShape(splitWith(p1)).panes, ["p1", "p2"]);
  S().undoClearTabs(cleared);
  assert.deepEqual(splitShape(splitWith(p1)), before);
  assert.equal(Object.keys(S().splits).length, 1);
});

test("Undo of Clear brings back a split's empty pane and selects it again", () => {
  reset();
  const [w, a] = setup("a");
  const blank = S().newTab(w, {});
  S().createSplit([a, blank]);
  S().activate(blank);
  const cleared = S().clearUnpinnedTabs(w);
  assert.ok(cleared, "the split with a page in it closes");
  assert.equal(Object.keys(S().splits).length, 0);
  S().undoClearTabs(cleared);
  const splits = Object.values(S().splits);
  assert.equal(splits.length, 1);
  assert.deepEqual(splitShape(splits[0]).panes, ["a", "(blank)"]);
  const active = model.activeTabId(S(), w);
  assert.equal(S().tabs[active].url, "", "the empty pane is selected again");
  assert.ok(splitTabIdsOf(splits[0]).includes(active));
});

test("switching to a profile the window never showed keeps the Undo of a second Clear, and Undo stays on that profile", () => {
  reset();
  const [w] = setup("a");
  const cleared = S().clearUnpinnedTabs(w);
  const p = S().createProfile({ name: "Work" });
  S().switchProfile(w, p);
  assert.ok(S().windows[w].tabIds.some((id) => S().tabs[id].profileId === p), "Work got its first tab");
  assert.equal(clearedTabs.canUndoClear(S(), cleared), true);
  S().undoClearTabs(cleared);
  assert.equal(S().windows[w].profileId, p);
  assert.equal(short(S().tabs[S().windows[w].activeTabIds.default].url), "a");
});

for (const [name, arrange] of [
  ["is selected", ({ p }) => S().activate(p)],
  ["plays sound", ({ p, y }) => (S().updateLive(p, { playingAudio: true }), S().activate(y))],
]) {
  test(`Clear keeps the unpinned partner of a split whose pinned pane ${name}`, () => {
    reset();
    const [w, p, u, x, y] = setup("p", "u", "x", "y");
    S().pinTabs([p], true);
    S().createSplit([p, u]);
    assert.ok(S().tabs[p].pin && !S().tabs[u].pin && splitWith(u), "a pinned pane and an unpinned partner");
    arrange({ p, y });
    const cleared = S().clearUnpinnedTabs(w);
    assert.ok(cleared.entries.every((e) => !["p", "u"].includes(short(e.tab.url))), JSON.stringify(cleared.entries.map((e) => short(e.tab.url))));
    assert.ok(cleared.entries.some((e) => short(e.tab.url) === "x"));
    assert.deepEqual(splitShape(splitWith(p)).panes, ["p", "u"], "the split stays whole");
  });
}

test("Undo of a Clear in one profile leaves a group made since in another profile, and that profile's tab order, alone", () => {
  reset();
  const [w, a] = setup("a", "b");
  S().activate(a);
  const cleared = S().clearUnpinnedTabs(w);
  assert.deepEqual(cleared.entries.map((e) => short(e.tab.url)), ["b"]);
  const p = S().createProfile({ name: "Work" });
  S().switchProfile(w, p);
  const x = S().newTab(w, { url: "x.com" });
  const y = S().newTab(w, { url: "y.com" });
  S().moveTab(y, 0);
  const g = S().createGroup([x, y], { name: "Work group" });
  const workOrder = model.viewTabIds(S(), w, p);
  assert.equal(clearedTabs.canUndoClear(S(), cleared), true);
  S().undoClearTabs(cleared);
  assert.ok(S().groups[g], "Work's group stays");
  assert.deepEqual([...S().groups[g].tabIds].sort(), [x, y].sort(), "with both its tabs");
  assert.deepEqual(model.viewTabIds(S(), w, p), workOrder, "Work's order stays");
  assert.deepEqual(model.viewTabIds(S(), w, "default").map((id) => short(S().tabs[id].url)), ["a", "b"], "Personal gets its tab back in place");
  assert.equal(S().windows[w].profileId, p);
});

test("Clear on a split of two empty panes offers Undo, and Undo puts the split back", async () => {
  reset();
  const { closeAllTabs } = await import("../sidebar/clearTabs.ts");
  const { useToasts } = await import("../app/toasts.ts");
  const [w] = setup("a");
  const one = S().newTab(w, {});
  const two = S().newTab(w, {});
  S().createSplit([one, two]);
  S().activate(one);
  S().clearUnpinnedTabs(w);
  assert.equal(S().windows[w].tabIds.length, 2, "the first Clear closes a and keeps the selected split");
  closeAllTabs(w);
  assert.equal(Object.keys(S().splits).length, 0);
  const toast = useToasts.getState().toasts[w];
  assert.equal(toast?.title, "Cleared 2 Tabs");
  toast.action.run();
  const splits = Object.values(S().splits);
  assert.equal(splits.length, 1, "the split is back");
  assert.ok(splitTabIdsOf(splits[0]).every((id) => !S().tabs[id].url));
  assert.equal(S().windows[w].tabIds.length, 2, "and the blank tab Clear left is gone");
});

for (const [name, edit] of [
  ["rotated", (split) => S().toggleSplitOrientation(split.id)],
  ["resized", (split) => S().updateSplit(split.id, { sizes: [0.7, 0.3] })],
]) {
  test(`the split Clear left behind ${name} afterwards ends the Clear's Undo instead of being overwritten`, () => {
    reset();
    const [w, p1, p2, u, x] = setup("p1", "p2", "u", "x");
    S().pinTabs([p1, p2], true);
    S().createSplit([p1, p2, u]);
    S().activate(x);
    const cleared = S().clearUnpinnedTabs(w);
    assert.equal(clearedTabs.canUndoClear(S(), cleared), true);
    const survivor = splitWith(p1);
    edit(survivor);
    const edited = JSON.stringify(splitWith(p1));
    assert.equal(clearedTabs.canUndoClear(S(), cleared), false);
    S().undoClearTabs(cleared);
    assert.equal(JSON.stringify(splitWith(p1)), edited, "the edit stays");
  });
}

test("Clear on a lone selected tab closes it and leaves the window open", () => {
  reset({ newTabPosition: "top" });
  const [w] = setup("a");
  const cleared = S().clearUnpinnedTabs(w);
  assert.equal(cleared.entries.length, 1);
  assert.ok(S().windows[w], "the window stays");
  assert.ok(S().windows[w].tabIds.every((id) => !S().tabs[id].url));
  S().undoClearTabs(cleared);
  assert.equal(shown(w), "a");
  assert.deepEqual(S().windows[w].tabIds.map((id) => S().tabs[id].url), ["https://a.com"], "the blank tab Clear left goes with the undo");
});

test("Undo of Clear in one profile keeps another profile's Recently Closed reopen index intact", () => {
  reset();
  const [w, p1] = setup("p1", "p2");
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const a = S().newTab(w, { url: "a.com" });
  const b = S().newTab(w, { url: "b.com" });
  const c = S().newTab(w, { url: "c.com" });
  const blank = model.viewTabIds(S(), w, work).find((id) => !S().tabs[id].url);
  if (blank) S().closeTabs([blank]);
  S().closeTabs([b]);
  S().switchProfile(w, "default");
  S().activate(p1);
  const cleared = S().clearUnpinnedTabs(w);
  S().undoClearTabs(cleared);
  S().switchProfile(w, work);
  S().reopenClosedTab(w);
  assert.deepEqual(model.viewTabIds(S(), w, work).map((id) => short(S().tabs[id].url)), ["a", "b", "c"]);
  assert.ok(S().tabs[a] && S().tabs[c]);
});

test("Undo of Clear in one profile keeps a tab closed afterwards in another profile reopening in its middle slot", () => {
  reset();
  const [w, p1] = setup("p1", "p2");
  S().activate(p1);
  const cleared = S().clearUnpinnedTabs(w);
  assert.deepEqual(cleared.entries.map((e) => short(e.tab.url)), ["p2"]);
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const a = S().newTab(w, { url: "a.com" });
  const b = S().newTab(w, { url: "b.com" });
  const c = S().newTab(w, { url: "c.com" });
  const blank = model.viewTabIds(S(), w, work).find((id) => !S().tabs[id].url);
  if (blank) S().closeTabs([blank]);
  S().closeTabs([b]);
  S().undoClearTabs(cleared);
  S().reopenClosedTab(w);
  assert.deepEqual(model.viewTabIds(S(), w, work).map((id) => short(S().tabs[id].url)), ["a", "b", "c"]);
  assert.deepEqual(model.viewTabIds(S(), w, "default").map((id) => short(S().tabs[id].url)), ["p1", "p2"]);
  assert.ok(S().tabs[a] && S().tabs[c]);
});

test("Undo of a second Clear keeps a Live Folder tab attached to its folder", async () => {
  reset();
  const { createFolder, removeFolder } = await import("../live/store.ts");
  const { openLiveItem } = await import("../live/engine.ts");
  const [w] = setup("a");
  const folderId = createFolder("default", "pullRequests", ["github"]);
  try {
    const item = { id: "pr-1", title: "PR 1", url: "https://github.com/org/repo/pull/1", source: "github", updatedAt: 1 };
    const liveTab = openLiveItem(w, folderId, item);
    S().activate(liveTab);
    S().clearUnpinnedTabs(w);
    const second = S().clearUnpinnedTabs(w);
    assert.ok(second);
    S().undoClearTabs(second);
    const restored = model.activeTabId(S(), w);
    assert.deepEqual(S().tabs[restored].liveItem, { folderId, itemId: item.id });
    const reopened = openLiveItem(w, folderId, item);
    assert.equal(reopened, restored, "clicking the item in the folder focuses the restored tab instead of duplicating it");
  } finally {
    removeFolder(folderId);
  }
});

test("a tab opened behind joins the ⌃Tab order only once it is shown, so ⌃Tab still returns to the tab before (#1190)", (t) => {
  reset();
  let now = Date.now();
  t.mock.method(Date, "now", () => (now += 1000));
  const [w, a, b] = setup("a", "b");
  S().activate(b);
  S().activate(a);
  const link = open(w, "link", a);
  const order = () => organize.recentTabIds(S(), w, now).map((id) => short(S().tabs[id].url));
  assert.deepEqual(order(), ["a", "link", "b"]);
  S().activate(link);
  assert.deepEqual(order(), ["link", "a", "b"]);
  assert.equal(S().tabs[link].unseen, undefined);
});
