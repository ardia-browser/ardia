import type { SqlDatabase } from "../lib/sqlDatabase";
import type { BrowserTab } from "../state/tabs/tabModels";

type PageListener = (event: Record<string, unknown>) => void;

const mockNative = {
  syncDemo: false,
  arguments: {} as Record<string, unknown>,
  listeners: [] as PageListener[],
  deleted: [] as string[],
  closed: [] as string[],
  inboxReads: 0,
  inboxApplied: [] as number[][],
};

const mockFiles = { real: null as SqlDatabase | null, opens: 0 };

jest.mock("../platform/database", () => {
  const { renderDatabase } = require("../../test/render/renderDatabase");
  return {
    openSqlDatabase: () => {
      mockFiles.opens += 1;
      return (mockFiles.real ??= renderDatabase());
    },
    openMemoryDatabase: () => renderDatabase(),
  };
});

jest.mock("../platform/telemetry", () => ({
  ...jest.requireActual("../platform/telemetry"),
  canPostTelemetry: () => false,
  setUsageConsent: () => undefined,
  takePendingCounts: () => ({}),
}));

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  return {
    ...actual,
    closePage: async (id: string) => void mockNative.closed.push(id),
    pages: {
      ...actual.pages,
      launchOptions: () => ({ pageLab: false, syncDemo: mockNative.syncDemo, lab: true, arguments: mockNative.arguments }),
      addListener: (listener: PageListener) => {
        mockNative.listeners.push(listener);
        return { remove: () => undefined };
      },
      deleteSnapshots: async (id: string) => void mockNative.deleted.push(id),
      snapshot: async (id: string) => ({ uri: `file:///pictures/${id}-captured.jpg`, path: "", width: 400, height: 800 }),
      saveState: async (id: string) => `saved-state-of-${id}`,
      scrollPosition: async () => ({ x: 0, y: 240 }),
      open: async () => undefined,
      close: async (id: string) => void mockNative.closed.push(id),
      ids: async () => [],
    },
    sync: {
      ...actual.sync,
      inbox: async () => {
        mockNative.inboxReads += 1;
        return [{ id: 7, received: [{ key: "mac-sent", url: "https://sent-from-mac.example/", title: "Sent", fromDevice: "MacBook Pro", fromDeviceId: "mac", sentAt: 1, profileSyncId: "personal" }], removals: [] }];
      },
      inboxApplied: async (ids: number[]) => void mockNative.inboxApplied.push(ids),
      deviceId: () => "this-phone",
    },
  };
});

type Launch = {
  tabs: typeof import("../state/tabs/store");
  browse: typeof import("../state/browse/store");
  positions: typeof import("../state/browse/positions");
  pages: typeof import("../state/pages/store");
  syncActions: typeof import("../state/sync/actions");
  telemetry: typeof import("../state/telemetry/telemetry");
  settings: typeof import("../state/settings/store");
  database: typeof import("../state/store/database");
  history: typeof import("../state/history/store");
};

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

function launch({ syncDemo = false, ardiaDemo = false }: { syncDemo?: boolean; ardiaDemo?: boolean } = {}): Launch {
  jest.clearAllTimers();
  mockNative.syncDemo = syncDemo;
  mockNative.arguments = ardiaDemo ? { ArdiaDemo: true } : {};
  mockNative.listeners = [];
  let made: Launch | null = null;
  jest.isolateModules(() => {
    made = {
      tabs: require("../state/tabs/store"),
      browse: require("../state/browse/store"),
      positions: require("../state/browse/positions"),
      pages: require("../state/pages/store"),
      syncActions: require("../state/sync/actions"),
      telemetry: require("../state/telemetry/telemetry"),
      settings: require("../state/settings/store"),
      database: require("../state/store/database"),
      history: require("../state/history/store"),
    };
  });
  return made!;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const pageEvent = (event: Record<string, unknown>) => mockNative.listeners.forEach((listener) => listener(event));

const persisted = (db: SqlDatabase) =>
  JSON.stringify({
    tabs: db.all("SELECT * FROM tabs ORDER BY id"),
    visits: db.all("SELECT * FROM visits ORDER BY id"),
    tabState: db.all("SELECT * FROM tab_state ORDER BY id"),
    archived: db.all("SELECT * FROM tabs WHERE archivedAt IS NOT NULL ORDER BY id"),
    preferences: db.all("SELECT * FROM preferences ORDER BY key"),
  });

const ids = (tabs: readonly BrowserTab[]) => tabs.map((tab) => tab.id);

function seedRealStore() {
  const real = launch();
  real.settings.setPreference("hasFinishedOnboarding", true);
  real.settings.setPreference("autoOpensKeyboard", false);
  real.telemetry.startTelemetry();
  real.telemetry.setUsageSharing(true, "settings");
  real.browse.startBrowser();
  const opened = Array.from({ length: 6 }, (_, i) => real.tabs.openNewTab({ url: `https://real-${i}.example/`, origin: "typed" }));
  opened.slice(0, 4).forEach((tab, i) => {
    real.tabs.updateTabById(tab.id, { title: `Real ${i}`, snapshotFileName: `file:///pictures/real-${i}.jpg` });
    real.tabs.saveTabState(tab.id, `real-state-${i}`);
  });
  real.tabs.receiveSentTabs([{ key: "real-received", url: "https://received.example/", title: "Received", fromDevice: "MacBook Pro", sentAt: T0, profileSyncId: null }]);
  for (const tab of opened.slice(0, 3)) pageEvent({ name: "page.visited", pageId: tab.id, url: `${tab.url}page`, title: `Visited ${tab.id}`, kind: "link" });
  real.tabs.archiveTabById(opened[4]!.id);
  real.tabs.archiveTabById(opened[5]!.id);
  real.pages.storeTone(opened[0]!.id, { top: "#112233", bottom: "#445566" });
  jest.advanceTimersByTime(2000);
  return { real, opened };
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  mockFiles.real = null;
  mockFiles.opens = 0;
  mockNative.deleted = [];
  mockNative.closed = [];
  mockNative.inboxReads = 0;
  mockNative.inboxApplied = [];
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test("a sync-demo launch shows the demo's own seeded tabs, and every change made in the demo shows in the demo", async () => {
  const { DEMO_ARCHIVED, DEMO_OPEN } = require("../state/app/demoSeed") as typeof import("../state/app/demoSeed");
  seedRealStore();
  await settle();
  const demo = launch({ syncDemo: true });
  demo.browse.startBrowser();
  const tabs = () => demo.tabs.currentTabs();
  expect(demo.database.tabDatabase()).not.toBe(demo.database.browserDatabase());
  expect(tabs().open.map((tab) => tab.url)).toEqual(DEMO_OPEN.map((page) => page.url));
  expect(tabs().open.map((tab) => tab.title)).toEqual(DEMO_OPEN.map((page) => page.title));
  expect(tabs().archivedCount).toBe(DEMO_ARCHIVED.length);
  expect(tabs().open.find((tab) => tab.id === tabs().selectedId)?.url).toBe("https://en.wikipedia.org/wiki/Sintra");
  demo.tabs.loadArchive();
  expect(tabs().archive?.map((tab) => tab.url)).toEqual(DEMO_ARCHIVED.map((page) => page.url));

  const [lisbon, arts, iphone] = tabs().open;
  const fresh = demo.tabs.openNewTab({ url: "https://demo-new.example/", origin: "typed" });
  expect(tabs().selectedId).toBe(fresh.id);
  pageEvent({ name: "page.visited", pageId: fresh.id, url: "https://demo-new.example/next", title: "Next Page", kind: "link" });
  expect(tabs().open.find((tab) => tab.id === fresh.id)).toMatchObject({ url: "https://demo-new.example/next", title: "Next Page" });
  await demo.browse.captureSnapshot(lisbon!.id);
  expect(tabs().open.find((tab) => tab.id === lisbon!.id)?.snapshotFileName).toBe(`file:///pictures/${lisbon!.id}-captured.jpg`);
  demo.tabs.selectTabById(arts!.id);
  expect(tabs().selectedId).toBe(arts!.id);
  await demo.positions.saveTabPosition(arts!.id);
  expect(demo.tabs.tabSavedState(arts!.id)).toBe(`saved-state-of-${arts!.id}`);
  demo.tabs.moveTabToSpace(iphone!.id, "demo-work");
  expect(tabs().open.find((tab) => tab.id === iphone!.id)?.profileSyncId).toBe("demo-work");
  const received = demo.tabs.receiveSentTabs([{ key: "real-received", url: "https://received.example/", title: "Received", fromDevice: "MacBook Pro", sentAt: T0, profileSyncId: null }]);
  expect(received).toHaveLength(1);
  expect(tabs().open.some((tab) => tab.id === received[0]!.id)).toBe(true);
  demo.tabs.archiveTabById(lisbon!.id);
  await settle();
  expect(tabs().archivedCount).toBe(DEMO_ARCHIVED.length + 1);
  expect(demo.tabs.archivedTabById(lisbon!.id)?.url).toBe(lisbon!.url);
  expect(demo.tabs.searchArchive("Lisbon").map((tab) => tab.url)).toContain("https://www.timeout.com/lisbon");
  expect(demo.history.history().search("sintra").map((visit) => visit.url)).toContain("https://www.google.com/search?q=best+time+to+visit+sintra");
  expect(demo.history.history().search("demo-new").map((visit) => visit.url)).toEqual(["https://demo-new.example/next"]);
  expect(demo.history.history().search("real-")).toEqual([]);
});

test("a sync-demo session never changes the real tab store: tabs, saved states, archive and remembered tones are byte for byte the same afterwards, no real picture or page is touched, and the real tabs come back at the next launch", async () => {
  const { real, opened } = seedRealStore();
  await settle();
  const realOpen = ids(real.tabs.currentTabs().open);
  const realIds = new Set(mockFiles.real!.all<{ id: string }>("SELECT id FROM tabs").map((row) => row.id));
  expect(realIds.size).toBe(7);
  expect(mockFiles.real!.all("SELECT id FROM tab_state")).toHaveLength(6);
  const before = persisted(mockFiles.real!);
  const usageBefore = real.telemetry.usageToday();
  expect(usageBefore.sharing).toBe(true);
  expect(usageBefore.counts.tabs_opened).toBe(6);
  mockNative.deleted = [];
  mockNative.closed = [];

  const demo = launch({ syncDemo: true });
  demo.telemetry.startTelemetry();
  demo.browse.startBrowser();
  const tabs = () => demo.tabs.currentTabs();
  for (const id of ids(tabs().open)) expect(realIds.has(id)).toBe(false);
  const [first, second, third, fourth, fifth] = tabs().open;
  const fresh = demo.tabs.openNewTab({ url: "https://demo-new.example/", origin: "typed" });
  demo.tabs.openNewTab({ url: "https://demo-search.example/", origin: "search" });
  pageEvent({ name: "page.visited", pageId: fresh.id, url: "https://demo-new.example/next", title: "Next Page", kind: "link" });
  pageEvent({ name: "page.state", pageId: second!.id, state: { url: "https://demo-state.example/", title: "State", progress: 1, isLoading: false, canGoBack: true, canGoForward: false } });
  await demo.browse.captureSnapshot(first!.id);
  pageEvent({ name: "page.snapshotLanded", pageId: second!.id, uri: "file:///pictures/landed.jpg", generation: 3 });
  demo.tabs.selectTabById(second!.id);
  await demo.positions.saveTabPosition(second!.id);
  demo.tabs.saveTabState(third!.id, "demo-state");
  demo.pages.storeTone(second!.id, { top: "#AABBCC", bottom: "#DDEEFF" });
  jest.advanceTimersByTime(2000);
  demo.tabs.receiveSentTabs([{ key: "real-received", url: "https://received.example/", title: "Received", fromDevice: "MacBook Pro", sentAt: T0, profileSyncId: null }]);
  demo.tabs.moveTabToSpace(third!.id, "demo-work");
  demo.tabs.rewriteTab(first!.id);
  demo.tabs.archiveTabById(fourth!.id);
  await settle();
  demo.tabs.loadArchive();
  const archive = tabs().archive!;
  demo.tabs.restoreArchivedTab(archive[0]!);
  demo.tabs.deleteArchivedTabsById([archive[1]!.id]);
  demo.tabs.closeTabById(fifth!.id);
  expect(demo.tabs.reopenClosedTab()?.url).toBe(fifth!.url);
  demo.tabs.openNewTab({ url: "https://private.example/", origin: "typed", isPrivate: true });
  demo.tabs.closePrivateTabs();
  demo.tabs.pruneExpiredArchive();
  demo.tabs.archiveDueTabs();
  expect(await demo.syncActions.applyInbox()).toBe(0);
  expect(mockNative.inboxReads).toBe(0);
  expect(mockNative.inboxApplied).toEqual([]);
  expect(demo.telemetry.usageToday().counts).toEqual(usageBefore.counts);
  demo.tabs.closeEveryTab();
  demo.tabs.clearArchivedTabs();
  await settle();
  jest.advanceTimersByTime(5000);
  await settle();
  expect(tabs().open).toEqual([]);
  expect(tabs().archivedCount).toBe(0);

  expect(persisted(mockFiles.real!)).toBe(before);
  expect(mockNative.deleted.length).toBeGreaterThan(0);
  expect(mockNative.deleted.filter((id) => realIds.has(id))).toEqual([]);
  expect(mockNative.closed.length).toBeGreaterThan(0);
  expect(mockNative.closed.filter((id) => realIds.has(id))).toEqual([]);

  const next = launch();
  next.telemetry.startTelemetry();
  next.browse.startBrowser();
  expect(ids(next.tabs.currentTabs().open)).toEqual(realOpen);
  expect(next.tabs.currentTabs().archivedCount).toBe(2);
  opened.slice(0, 4).forEach((tab, i) => expect(next.tabs.tabSavedState(tab.id)).toBe(`real-state-${i}`));
  expect(next.tabs.currentTabs().open.find((tab) => tab.id === opened[0]!.id)?.snapshotFileName).toBe("file:///pictures/real-0.jpg");
  expect(persisted(mockFiles.real!)).toBe(before);
  next.tabs.openNewTab({ url: "https://after-demo.example/", origin: "typed" });
  expect(next.telemetry.usageToday().counts.tabs_opened).toBe(7);
});

test("an ArdiaDemo launch keeps today's single in-memory store: the tabs come from the same seeded database as the rest, and the real file is never opened", () => {
  const { DEMO_OPEN } = require("../state/app/demoSeed") as typeof import("../state/app/demoSeed");
  const demo = launch({ syncDemo: true, ardiaDemo: true });
  demo.browse.startBrowser();
  expect(demo.database.tabDatabase()).toBe(demo.database.browserDatabase());
  expect(demo.tabs.currentTabs().open.map((tab) => tab.url)).toEqual(DEMO_OPEN.map((page) => page.url));
  demo.tabs.openNewTab({ url: "https://demo-new.example/", origin: "typed" });
  expect(mockFiles.opens).toBe(0);
  expect(mockFiles.real).toBeNull();
});
