import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const icon = (page) => ({ page, icon: `${new URL(page).origin}/favicon.ico`, png: PNG });
const tab = (url, extra = {}) => ({ url, title: url, pinned: false, windowIndex: 0, active: false, ...extra });
const link = (url) => ({ type: "url", title: url, url });

const FIREFOX = {
  bookmarks: { type: "folder", title: "Bookmarks", children: [
    { type: "folder", title: "Bookmarks Toolbar", role: "toolbar", children: [link("https://bar.example/"), { type: "folder", title: "Dev", children: [link("https://dev.example/docs")] }] },
    { type: "folder", title: "Bookmarks Menu", role: "menu", children: [link("https://menu.example/")] },
  ] },
  tabs: [tab("https://open.example/"), tab("https://pinned.example/", { pinned: true })],
  spaces: [],
  favorites: [],
  favicons: ["https://bar.example/", "https://dev.example/docs", "https://open.example/", "https://pinned.example/", "https://menu.example/"].map(icon),
};

const ZEN = {
  bookmarks: undefined,
  tabs: [],
  spaces: [{ id: "work", name: "Work", profileId: "zen", pinned: [link("https://pin.example/"), { type: "folder", title: "Docs", children: [link("https://folder.example/a")] }], tabs: [tab("https://today.example/")] }],
  favorites: [tab("https://essential.example/", { pinned: true })],
  favicons: ["https://pin.example/", "https://folder.example/a", "https://today.example/", "https://essential.example/"].map(icon),
};

let reply = FIREFOX;
globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    unlockBrowser: async () => {},
    isBrowserUnlocked: () => true,
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) =>
      JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabGroups: [], credentials: [], cookieCount: 0, addressCount: 0, cardCount: 0,
        failed: [], warnings: [], ...reply,
      }),
  },
};

const stub = await import("../../test-native/index.ts");
const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useFavicons, cacheKey } = await import("../favicons/favicons.ts");
const { patchImport } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");

const S = () => useBrowser.getState();
const iconPages = (profileId) =>
  Object.entries(useFavicons.getState().profiles[cacheKey(profileId)]?.pages ?? {})
    .filter(([, uri]) => uri?.startsWith("data:image/png;base64,"))
    .map(([page]) => page)
    .sort();

after(() => client.setSharing(false, "settings"));

async function importFrom(source, kinds) {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  useFavicons.setState({ profiles: {}, themes: {} });
  S().createWindow({ url: "https://start.example/" });
  patchImport({ source, sourceProfiles: [source.profiles[0].id], spaces: (source.profiles[0].spaces ?? []).map((s) => s.id), target: "default", kinds: new Set(kinds) });
  await runImport(new Set(kinds));
  await new Promise((r) => setTimeout(r, 5));
}

test("Firefox's icons arrive for its open tabs and bookmarks toolbar, and are counted", async () => {
  client.setSharing(true, "onboarding");
  reply = FIREFOX;
  const firefox = { id: "firefox", name: "Firefox", family: "firefox", requiresExport: false, needsKeychain: false,
    profiles: [{ id: "Profiles/a.default", name: "default", path: "/ff", isDefault: true, available: ["bookmarks", "tabs"] }] };
  await importFrom(firefox, ["bookmarks", "tabs"]);
  assert.deepEqual(iconPages("default"), ["https://bar.example/", "https://dev.example/docs", "https://open.example/", "https://pinned.example/"]);
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  const sent = queue.events.filter((e) => e.event === "usage_counts").at(-1)?.properties ?? {};
  assert.equal(sent.import_firefox_profiles, 1);
  assert.equal(sent.import_firefox_favicons, 5);
});

test("Zen's icons arrive for pinned tabs, folders, today's tabs and Essentials", async () => {
  reply = ZEN;
  const zen = { id: "zen", name: "Zen", family: "firefox", sidebar: "zen", requiresExport: false, needsKeychain: false,
    profiles: [{ id: "Profiles/z.Default", name: "Default", path: "/zen", isDefault: true, available: ["spaces", "pinnedTabs", "tabs", "favorites"],
      spaces: ZEN.spaces.map((s) => ({ ...s, pinnedCount: 2, tabCount: 1 })) }] };
  await importFrom(zen, ["spaces", "pinnedTabs", "tabs", "favorites"]);
  const everywhere = [...new Set(S().profileOrder.flatMap(iconPages))].sort();
  assert.deepEqual(everywhere, ["https://essential.example/", "https://folder.example/a", "https://pin.example/", "https://today.example/"]);
});
