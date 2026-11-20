import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });

let reply = {};
const requested = [];
globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    isBrowserUnlocked: () => true,
    listExtensions: async () => "[]",
    importData: async (_job, _browser, profileId, kinds) => {
      requested.push([profileId, kinds]);
      const own = reply[profileId] ?? {};
      return JSON.stringify({
        browserId: "arc",
        profileId,
        history: [],
        historyCount: 0,
        tabs: [],
        tabGroups: [],
        credentials: [],
        cookieCount: 0,
        addressCount: 0,
        cardCount: 0,
        spaces: own.spaces ?? [],
        favorites: [],
        favicons: [],
        failed: [],
        warnings: [],
        ...(kinds.includes("linkRules") ? { arcRouting: own.routing } : {}),
        ...(kinds.includes("archive") ? { arcArchive: own.archive } : {}),
        ...(own.cachedIcons !== undefined ? { arcCachedIcons: own.cachedIcons } : {}),
      });
    },
  },
};

const stub = await import("../../test-native/index.ts");
const client = await import("../telemetry/client.ts");
const { takeArcImportCounts } = await import("../telemetry/importRuns.ts");
const { useBrowser } = await import("../browser/store.ts");
const { importNow, patchImport } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");
const { linkMatches, NO_AIR_TRAFFIC } = await import("../airTraffic/rules.ts");
const { currentAirTraffic, resetAirTrafficForTests, setAirTrafficFallback, updateAirTrafficRule } = await import("../airTraffic/store.ts");
const { ARC_GLYPH_EMOJI, ARC_UNKNOWN_GLYPH_EMOJI, arcGlyphEmoji, arcLinkCondition, arcRuleId, arcSpaceEmoji } = await import("./arcExtras.ts");

const S = () => useBrowser.getState();
const profileNamed = (name) => S().profileOrder.find((id) => S().profiles[id].name === name);
const space = (id, name, extra = {}) => ({ id, name, profileId: "Default", pinned: [], tabs: [], ...extra });
const DAY = 86_400_000;

const ARC_ICON_TAB = [
  "star", "bookmark", "heart", "flag", "flash", "triangle", "medical", "notifications", "bulb", "shapes", "grid", "apps", "layers", "server",
  "albums", "copy", "folder", "fileTrayFull", "calendar", "mail", "checkbox", "document", "book", "chatBubbleEllipses", "people", "terminal",
  "construction", "square", "egg", "ellipse", "moon", "sunny", "planet", "leaf", "cloud", "paw", "bag", "gift", "bed", "restaurant", "barbell",
  "airplane", "musicalNote", "colorPallete", "video", "bandage", "code", "baseball", "cloudOutline", "map", "bonfire", "pizza", "skull",
  "receipt", "thumbsUp", "train",
];

const source = {
  id: "arc",
  name: "Arc",
  family: "arc",
  requiresExport: false,
  needsKeychain: false,
  sidebar: "arc",
  profiles: [
    { id: "Default", name: "Default", path: "/arc", isDefault: true, available: ["spaces", "linkRules", "archive"], spaces: [] },
    { id: "Profile 1", name: "Work", path: "/arc1", isDefault: false, available: ["spaces", "linkRules", "archive"], spaces: [] },
  ],
};

const ROUTING = {
  rules: [
    { id: "R-meet", match: "contains", text: "meet.google.com", to: { kind: "mostRecent" } },
    { id: "R-jira", match: "contains", text: "jira.example/browse", to: { kind: "space", spaceId: "s-work", spaceName: "Work" } },
    { id: "R-docs", match: "contains", text: "https://www.docs.example/", to: { kind: "littleArc" } },
    { id: "R-cal", match: "equals", text: "calendar.example", to: { kind: "littleArc", spaceId: "s-home", spaceName: "Home" } },
    { id: "R-gone", match: "contains", text: "gone.example", to: { kind: "space", spaceId: "s-gone" } },
    { id: "R-gone-little", match: "contains", text: "gone.example", to: { kind: "littleArc", spaceId: "s-gone" } },
    { id: "R-query", match: "equals", text: "example.com/?q=1", to: { kind: "mostRecent" } },
    { id: "bad id!", match: "contains", text: "x.example", to: { kind: "mostRecent" } },
  ],
  skipped: 2,
  fallback: { kind: "mostRecent" },
};

function begin({ routing = ROUTING, archive, now = Date.now() } = {}) {
  useBrowser.setState({ bookmarks: { nodes: {} }, cleanedTabs: [] });
  S().hydrate({});
  resetAirTrafficForTests(NO_AIR_TRAFFIC);
  requested.length = 0;
  reply = {
    Default: {
      spaces: [space("s-home", "Home", { icon: "construction" }), space("s-play", "Play", { emoji: "🎮", icon: "star" })],
      routing,
      archive: archive ?? {
        tabs: [
          { url: "https://report.example/q3", title: "Q3 report", customTitle: "Report", archivedAt: now - 3 * DAY, spaceId: "s-work", spaceName: "Work", auto: false },
          { url: "https://little.example/", title: "From Little Arc", archivedAt: now - 20 * DAY, auto: false },
          { url: "https://old.example/", title: "Old", archivedAt: now - 40 * DAY, spaceId: "s-home", spaceName: "Home", auto: true },
          { url: "https://ghost.example/", title: "Gone", archivedAt: now - DAY, spaceId: "s-gone", spaceName: "Gone", auto: false },
        ],
        cleanUpAfterMinutes: 7 * 24 * 60,
      },
      cachedIcons: 2,
    },
    "Profile 1": { spaces: [space("s-work", "Work", { profileId: "Profile 1", icon: "notAGlyph" })], cachedIcons: 1 },
  };
  patchImport({ source, sourceProfiles: ["Default", "Profile 1"], spaces: ["s-home", "s-play", "s-work"], target: "default", kinds: new Set(["tabs", "linkRules", "archive"]) });
}

after(() => client.setSharing(false, "settings"));
beforeEach(() => stub.docs.clear());

test("every glyph on Arc's Icon tab has an emoji, an unknown glyph keeps an icon, and an emoji wins", () => {
  assert.equal(ARC_ICON_TAB.length, 56);
  for (const name of ARC_ICON_TAB) assert.ok(ARC_GLYPH_EMOJI[name], name);
  assert.equal(new Set(ARC_ICON_TAB.map((n) => ARC_GLYPH_EMOJI[n])).size, 56);
  assert.equal(arcGlyphEmoji("construction"), "🛠️");
  assert.equal(arcGlyphEmoji("linear"), ARC_UNKNOWN_GLYPH_EMOJI);
  assert.equal(arcGlyphEmoji("constructor"), ARC_UNKNOWN_GLYPH_EMOJI);
  assert.equal(arcGlyphEmoji(undefined), undefined);
  assert.equal(arcSpaceEmoji({ emoji: "🏡", icon: "star" }), "🏡");
  assert.equal(arcSpaceEmoji({}), undefined);
});

test("Arc's contains and is-equal-to rules match literally, as Arc matched", () => {
  const when = (match, text) => arcLinkCondition({ match, text });
  const matches = (c, url) => linkMatches(c, url);
  const scheme = when("contains", "https://example.com/atc-scheme");
  assert.ok(matches(scheme, "http://example.com/atc-scheme/x") && matches(scheme, "https://www.example.com/atc-scheme"));
  assert.ok(matches(when("contains", "ATC-CASE"), "https://example.com/atc-case"));
  assert.ok(matches(when("contains", "atc-order"), "https://example.com/?x=atc-order"));
  assert.ok(matches(when("contains", "atc-recent"), "https://example.com/#atc-recent"));
  assert.ok(matches(when("contains", "meet.google.com"), "https://meet.google.com/abc-defg-hij"));
  for (const glob of ["*", "<all_urls>", "*.example.com", "a?c"]) assert.ok(!matches(when("contains", glob), "https://a.example.com/abc"), glob);
  assert.ok(matches(when("contains", "*"), "https://a.example/search?q=*"));
  const equal = when("equals", "example.com/atc-eq");
  assert.deepEqual(equal, { kind: "equals", text: "example.com/atc-eq" });
  for (const url of ["https://example.com/atc-eq", "https://example.com/atc-eq?x=1", "https://example.com/atc-eq#frag", "http://www.example.com/atc-eq/", "https://EXAMPLE.com/ATC-EQ"])
    assert.ok(matches(equal, url), url);
  for (const url of ["https://example.com/atc-eq/more", "https://example.com/atc-eqx", "https://sub.example.com/atc-eq", "https://evil.example/example.com/atc-eq"]) assert.ok(!matches(equal, url), url);
  const host = when("equals", "calendar.example");
  assert.ok(matches(host, "https://calendar.example/") && matches(host, "https://calendar.example/?x") && !matches(host, "https://calendar.example/week"));
  assert.equal(when("equals", "example.com/?q=1"), null);
  assert.equal(when("contains", "   "), null);
  assert.equal(when("contains", "x".repeat(3000)), null);
  assert.equal(arcRuleId("R-1"), "arc-R-1");
  assert.equal(arcRuleId("bad id!"), null);
});

const settle = () => new Promise((r) => setTimeout(r, 5));

test("an Arc import brings its rules, archive, glyph icons and threshold into the profiles its spaces went to", async () => {
  client.setSharing(true, "onboarding");
  takeArcImportCounts();
  const now = Date.now();
  begin({ now });
  await runImport(new Set(["tabs", "linkRules", "archive"]));
  assert.deepEqual(requested.map(([p, kinds]) => [p, kinds.includes("linkRules"), kinds.includes("archive")]), [
    ["Default", true, true],
    ["Profile 1", false, false],
  ]);
  const home = profileNamed("Home");
  const work = profileNamed("Work");
  assert.equal(S().profiles[home].icon, "🛠️");
  assert.equal(S().profiles[profileNamed("Play")].icon, "🎮");
  assert.equal(S().profiles[work].icon, ARC_UNKNOWN_GLYPH_EMOJI);

  const rules = currentAirTraffic().rules.map((r) => [r.id, r.when.kind, r.when.text, r.profileId, r.open, r.enabled, r.from]);
  assert.deepEqual(rules, [
    ["arc-R-meet", "contains", "meet.google.com", null, "tab", true, null],
    ["arc-R-jira", "contains", "jira.example/browse", work, "tab", true, null],
    ["arc-R-docs", "contains", "https://www.docs.example/", null, "littleArdia", true, null],
    ["arc-R-cal", "equals", "calendar.example", home, "littleArdia", true, null],
  ]);
  assert.equal(currentAirTraffic().fallback, null);
  assert.equal(S().settings.openLinksInLittleArdia, false);

  const cleaned = S().cleanedTabs;
  assert.deepEqual(cleaned.map((c) => [c.tab.url, c.tab.profileId, c.tab.customTitle]).reverse(), [
    ["https://report.example/q3", work, "Report"],
    ["https://little.example/", home, null],
    ["https://old.example/", home, null],
  ]);
  assert.ok(cleaned.every((c) => c.closedAt <= Date.now() && c.closedAt > now - 1000 && c.windowId === "" && c.group === null));
  assert.equal(cleaned.at(-1).tab.lastActiveAt, now - 3 * DAY);
  assert.equal(S().settings.cleanUpInactiveTabsAfterMinutes, 7 * 24 * 60);

  await settle();
  const done = importNow().step;
  assert.equal(done.name, "done");
  assert.deepEqual([done.counts.rules, done.counts.archived, done.counts.settings], [4, 3, 2]);
  assert.ok(done.notes.some((n) => n.startsWith("6 Air Traffic Control rules from Arc stayed behind")), JSON.stringify(done.notes));
  assert.ok(done.notes.includes("1 archived tab from spaces that didn't come over stayed in Arc."), JSON.stringify(done.notes));

  assert.deepEqual(takeArcImportCounts(), {
    import_arc_rules: 4,
    import_arc_rules_skipped: 6,
    import_arc_archived_tabs: 3,
    import_arc_glyph_icons: 2,
    import_arc_cached_icons: 3,
  });

  updateAirTrafficRule("arc-R-jira", { profileId: home });
  await runImport(new Set(["linkRules", "archive"]));
  assert.equal(currentAirTraffic().rules.length, 4, "importing again adds no second copy");
  assert.equal(currentAirTraffic().rules.find((r) => r.id === "arc-R-jira").profileId, home, "and keeps the person's edit");
  assert.equal(S().cleanedTabs.length, 3, "nor duplicate archived tabs");
  await settle();
  assert.deepEqual(importNow().step.counts.rules, 0);
  assert.ok(!importNow().step.notes.some((n) => n.startsWith("Arc's choice")), JSON.stringify(importNow().step.notes));
  assert.ok(importNow().step.notes.includes("1 archived tab from spaces that didn't come over stayed in Arc."), "the tab from the deleted space still stays behind");
});

test("a fallback or Little Ardia choice the person made stays, and the done screen says so", async () => {
  begin({ routing: { rules: [], skipped: 0, fallback: { kind: "space", spaceId: "s-home", spaceName: "Home" } } });
  setAirTrafficFallback(null);
  S().updateSettings({ cleanUpInactiveTabsAfterMinutes: 12 * 60 });
  await runImport(new Set(["tabs", "linkRules", "archive"]));
  assert.equal(S().settings.cleanUpInactiveTabsAfterMinutes, 12 * 60);
  assert.equal(currentAirTraffic().fallback, null, "Ardia's usual routing, chosen on purpose, stays");
  await settle();
  assert.ok(importNow().step.notes.some((n) => n.startsWith("Arc's choice for links from other apps wasn't imported, because")));
  assert.ok(importNow().step.notes.some((n) => n.startsWith("Arc's archive timing wasn't imported")));

  begin({ routing: { rules: [], skipped: 0, fallback: { kind: "mostRecent" } } });
  S().updateSettings({ openLinksInLittleArdia: true });
  await runImport(new Set(["linkRules"]));
  assert.equal(S().settings.openLinksInLittleArdia, true);

  begin({ routing: { rules: [], skipped: 0, fallback: { kind: "space", spaceId: "s-home", spaceName: "Home" } } });
  S().updateSettings({ openLinksInLittleArdia: false }, { fromSync: true });
  await runImport(new Set(["tabs", "linkRules"]));
  assert.equal(currentAirTraffic().fallback, null, "Little Ardia turned off elsewhere counts as a choice");

  begin({ routing: { rules: [], skipped: 0, fallback: { kind: "space", spaceId: "s-home", spaceName: "Home" } } });
  await runImport(new Set(["tabs", "linkRules"]));
  assert.deepEqual(currentAirTraffic().fallback, { profileId: profileNamed("Home"), open: "tab" });

  begin({ routing: { rules: [], skipped: 0, fallback: { kind: "space", spaceId: "s-gone" } } });
  await runImport(new Set(["linkRules"]));
  assert.equal(currentAirTraffic().fallback, null);
  assert.equal(S().settings.openLinksInLittleArdia, true, "a default naming a deleted space changes nothing");
  await settle();
  assert.ok(importNow().step.notes.some((n) => n.includes("the space it named didn't come over")));
});

test("a rules-only import reports what it brought", async () => {
  begin();
  await runImport(new Set(["linkRules"]));
  await settle();
  const done = importNow().step;
  assert.equal(done.counts.rules, 4);
  assert.equal(done.counts.archived, 0);
});

test("the newest archived tabs that have a profile fill Recently Cleaned, and the rest are counted", async () => {
  const now = Date.now();
  const tabs = Array.from({ length: 130 }, (_, i) => ({ url: `https://e.example/${i}`, title: `${i}`, archivedAt: now - i * 60_000, auto: true, ...(i < 10 ? { spaceId: "s-gone", spaceName: "Gone" } : {}) }));
  tabs.splice(12, 0, { ...tabs[11] });
  begin({ archive: { tabs, dropped: 7 } });
  await runImport(new Set(["archive"]));
  const urls = S().cleanedTabs.map((c) => c.tab.url);
  assert.equal(urls.length, 100, "a duplicate row doesn't take a place");
  assert.equal(urls.at(-1), "https://e.example/10");
  assert.equal(urls[0], "https://e.example/109");
  await settle();
  const notes = importNow().step.notes;
  assert.ok(notes.includes("20 archived tabs stayed in Arc: Recently Cleaned keeps the newest 100 for a week."), JSON.stringify(notes));
  assert.ok(notes.includes("10 archived tabs from spaces that didn't come over stayed in Arc."), JSON.stringify(notes));
  assert.ok(notes.includes("7 older archived tabs weren't read: Ardia reads Arc's newest 1,500."), JSON.stringify(notes));

  useBrowser.setState({ cleanedTabs: S().cleanedTabs.slice(-5) });
  await runImport(new Set(["archive"]));
  assert.equal(S().cleanedTabs.length, 100, "rows already imported count toward the hundred");
  await settle();
  assert.equal(importNow().step.counts.archived, 95);
  const second = S().cleanedTabs.map((c) => c.tab.url);
  assert.deepEqual([...new Set(second)].sort(), Array.from({ length: 100 }, (_, i) => `https://e.example/${i + 10}`).sort());
});

test("Recently Cleaned dedupes against rows still kept and within the batch", async () => {
  const { withImportedCleaned } = await import("../pins/importedCleaned.ts");
  const now = Date.now();
  const row = (url, closedAt, lastActiveAt = 1) => ({ kind: "tab", id: `ct-${url}-${closedAt}`, tab: { url, title: "", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, profileId: "default", lastActiveAt }, windowId: "", index: 0, group: null, closedAt });
  const s = { profiles: { default: {} }, cleanedTabs: [row("https://old.example/", now - 30 * DAY), row("https://kept.example/", now - DAY)] };
  const out = withImportedCleaned(s, [row("https://old.example/", now), row("https://kept.example/", now), row("https://twice.example/", now), row("https://twice.example/", now - 1)]);
  assert.deepEqual([out.added, out.already], [2, 2]);
  assert.deepEqual(out.cleanedTabs.map((c) => c.tab.url), ["https://kept.example/", "https://old.example/", "https://twice.example/"]);
});

test("a setting whose save didn't land is reported, not counted", async () => {
  const { refusedWrites } = await import("../../test-native/shell.ts");
  begin({ routing: { rules: [], skipped: 0, fallback: { kind: "mostRecent" } }, archive: { tabs: [] } });
  refusedWrites.on = true;
  try {
    await runImport(new Set(["linkRules", "archive"]));
  } finally {
    refusedWrites.on = false;
  }
  await settle();
  const done = importNow().step;
  assert.equal(done.counts.settings, 0);
  assert.ok(done.notes.includes("Some of Arc's settings may not have been saved. Check Settings, or try the import again."), JSON.stringify(done.notes));
});

test("a rule that can't be written is reported apart from one that has no match", async () => {
  const { refusedWrites } = await import("../../test-native/shell.ts");
  begin({ routing: { rules: [ROUTING.rules[0]], skipped: 0 } });
  refusedWrites.returnsFalse = true;
  try {
    await runImport(new Set(["linkRules"]));
  } finally {
    refusedWrites.returnsFalse = false;
  }
  await settle();
  const done = importNow().step;
  assert.equal(done.counts.rules, 0);
  assert.ok(done.notes.includes("1 Air Traffic Control rule from Arc couldn't be saved. Try the import again."), JSON.stringify(done.notes));
  assert.ok(!done.notes.some((n) => n.includes("stayed behind")), JSON.stringify(done.notes));
});
