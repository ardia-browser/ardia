import assert from "node:assert/strict";
import test from "node:test";
import { EXAMPLE, legacyRead, legacyVisits, NEWS, OTTER, T } from "../../../test/legacyFixture.ts";
import { nodeDatabase } from "../../../test/nodeDatabase.ts";
import { parsePreferences } from "../settings/preferences.ts";
import { countVisits, readArchivedTabs, readOpenTabs, readPreferences, readTabState, writePreference, writeTabs } from "../store/browserDatabase.ts";
import { migrate } from "../store/schema.ts";
import { launchTabs } from "../tabs/tabsState.ts";
import type { BrowserTab } from "../tabs/tabModels.ts";
import { runLegacyImport, startWithoutImport, VISIT_PAGE, type ImportDeps, type LegacyApi } from "./importer.ts";
import { importChoices, LEGACY_FRESH_KEY, LEGACY_FRESH_VERSION, LEGACY_RECEIPT_KEY, readReceipt, type LegacyReadInput, type LegacyReceipt, type LegacyVisitInput } from "./importRules.ts";

type Step = "source" | "read" | "readVisits" | "applyNativeSettings" | "markImported";

type Fake = {
  api: LegacyApi;
  calls: string[];
  marked: () => LegacyReceipt | null;
  fresh: () => boolean;
  fail: Set<Step>;
};

function fakeLegacy(options: { read?: LegacyReadInput; visits?: (LegacyVisitInput & { id: number })[]; failVisitsAfter?: number; unusable?: "schema" | "corrupt" | "locked" | "io"; counts?: { tabs: number; archive: number; visits: number } } = {}): Fake {
  const read = options.read ?? legacyRead();
  const visits = options.visits ?? legacyVisits();
  const fail = new Set<Step>();
  const calls: string[] = [];
  let marked: LegacyReceipt | null = null;
  let fresh = false;
  const thrown = (step: Step) => {
    calls.push(step);
    if (fail.has(step)) throw Object.assign(new Error(`ERR_LEGACY_IO from ${step} at https://secret.example/`), { code: "ERR_LEGACY_IO" });
  };
  const api: LegacyApi = {
    source: async () => {
      thrown("source");
      if (options.unusable) return { kind: "unusable", reason: options.unusable };
      if (marked) return { kind: "done", outcome: "imported" };
      if (fresh) return { kind: "done", outcome: "startedFresh" };
      return { kind: "pending", counts: options.counts ?? { tabs: read.tabs.length, archive: read.archive.length, visits: visits.length } };
    },
    read: async () => {
      thrown("read");
      return structuredClone(read);
    },
    readVisits: async (afterId, limit) => {
      calls.push(`readVisits(${afterId},${limit})`);
      if (options.failVisitsAfter !== undefined && afterId >= options.failVisitsAfter) fail.add("readVisits");
      if (fail.has("readVisits")) thrown("readVisits");
      const page = visits.filter((visit) => visit.id > afterId).slice(0, limit);
      return { visits: structuredClone(page), next: page.length === limit ? page[page.length - 1]!.id : null };
    },
    applyNativeSettings: async () => thrown("applyNativeSettings"),
    markImported: async (receipt) => {
      thrown("markImported");
      marked = receipt;
    },
    startFresh: async () => {
      calls.push("startFresh");
      fresh = true;
    },
  };
  return { api, calls, marked: () => marked, fresh: () => fresh, fail };
}

function store() {
  const db = nodeDatabase();
  migrate(db);
  return db;
}

function deps(fake: Fake, db = store(), more: Partial<ImportDeps> = {}): ImportDeps & { lines: string[] } {
  const lines: string[] = [];
  return { legacy: fake.api, db, durable: true, platform: "android", log: (line) => lines.push(line), lines, ...more };
}

const tab = (id: string, url: string, lastActive: number): BrowserTab => ({
  id,
  url,
  title: "Mine",
  created: lastActive,
  lastActive,
  archivedAt: null,
  position: 9000,
  profileSyncId: null,
  faviconUrl: null,
  themeColorHex: null,
  snapshotFileName: null,
  origin: "typed",
  receivedKey: null,
  receivedFromDevice: null,
  pinnedKey: null,
  isPrivate: false,
});

test("a failed import followed by new writes still imports on the next launch, merged in, instead of skipping for good", async () => {
  const fake = fakeLegacy();
  const run = deps(fake);
  fake.fail.add("read");
  assert.deepEqual(await runLegacyImport(run), { kind: "failed", reason: "read" });
  writeTabs(run.db, [tab("mine-1", "https://mine.example/", T + 50_000)], []);
  writePreference(run.db, "legacy.importVersion", "skipped-existing");
  fake.fail.clear();
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.deepEqual(readOpenTabs(run.db).map((t) => t.id).sort(), [EXAMPLE, OTTER, "mine-1"].sort());
  assert.equal(readArchivedTabs(run.db, 10).length, 1);
  assert.equal(countVisits(run.db), 4);
  assert.deepEqual(fake.marked(), { version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 });
});

for (const step of ["source", "read", "readVisits", "applyNativeSettings", "markImported"] as const) {
  test(`a throw from ${step} stops the launch and the next try finishes the job`, async () => {
    const fake = fakeLegacy();
    const run = deps(fake);
    fake.fail.add(step);
    const failed = await runLegacyImport(run);
    assert.equal(failed.kind, "failed");
    const committed = step === "applyNativeSettings" || step === "markImported";
    assert.equal(readReceipt(readPreferences(run.db)[LEGACY_RECEIPT_KEY]) !== null, committed);
    assert.equal(readOpenTabs(run.db).length, committed ? 2 : 0);
    assert.equal(countVisits(run.db), committed ? 4 : 0);
    assert.equal(fake.marked(), null);
    assert.ok(run.lines.every((line) => !/https?:|Otter|example\.com|duckduckgo/.test(line)), run.lines.join("\n"));
    fake.fail.clear();
    fake.calls.length = 0;
    assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
    if (committed) assert.deepEqual(fake.calls, ["source", "applyNativeSettings", "markImported"]);
    assert.equal(readOpenTabs(run.db).length, 2);
    assert.equal(countVisits(run.db), 4);
    assert.deepEqual(fake.marked(), { version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 });
  });
}

test("a visit page that fails after the first one rolls back every row, the receipt included", async () => {
  const visits = Array.from({ length: VISIT_PAGE + 10 }, (_, i) => ({ id: i + 1, url: `https://site${i}.example/`, title: `Site ${i}`, visitedAt: T + i, transition: "link" }));
  const fake = fakeLegacy({ visits, failVisitsAfter: VISIT_PAGE });
  const run = deps(fake);
  assert.deepEqual(await runLegacyImport(run), { kind: "failed", reason: "readVisits" });
  assert.equal(countVisits(run.db), 0);
  assert.equal(readOpenTabs(run.db).length, 0);
  assert.equal(readPreferences(run.db)[LEGACY_RECEIPT_KEY], undefined);
});

test("the in-memory store never imports or marks anything done, and an absent source still starts", async () => {
  const fake = fakeLegacy();
  const run = deps(fake, store(), { durable: false });
  assert.deepEqual(await runLegacyImport(run), { kind: "failed", reason: "memory" });
  assert.equal(readOpenTabs(run.db).length, 0);
  assert.deepEqual(fake.calls, ["source"]);
  const none: LegacyApi = { ...fake.api, source: async () => ({ kind: "none" }) };
  assert.deepEqual(await runLegacyImport({ ...run, legacy: none }), { kind: "ready", outcome: "none" });
});

test("an unusable source or a source whose counts don't match what it reads stops the launch", async () => {
  for (const reason of ["schema", "corrupt", "locked", "io"] as const) {
    assert.deepEqual(await runLegacyImport(deps(fakeLegacy({ unusable: reason }))), { kind: "failed", reason: `unusable_${reason}` });
  }
  const short = deps(fakeLegacy({ counts: { tabs: 3, archive: 1, visits: 9 } }));
  assert.deepEqual(await runLegacyImport(short), { kind: "failed", reason: "mismatch" });
  assert.equal(countVisits(short.db), 0);
  assert.equal(readOpenTabs(short.db).length, 0);
  const shapeless = fakeLegacy();
  const broken = deps(shapeless);
  broken.legacy = { ...shapeless.api, read: async () => ({ tabs: "nope" }) as never };
  assert.deepEqual(await runLegacyImport(broken), { kind: "failed", reason: "shape" });
});

test("a store that already has rows keeps them and its settings, and gains only the ids it lacks", async () => {
  const run = deps(fakeLegacy());
  writeTabs(run.db, [{ ...tab(OTTER, "https://mine.example/", T), title: "Kept" }], []);
  writePreference(run.db, "settings.color", "blue");
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  const open = readOpenTabs(run.db);
  assert.equal(open.find((t) => t.id === OTTER)!.title, "Kept");
  assert.equal(readTabState(run.db, OTTER), null);
  assert.ok(open.some((t) => t.id === EXAMPLE));
  assert.equal(parsePreferences(readPreferences(run.db)).colorChoice, "blue");
  assert.equal(parsePreferences(readPreferences(run.db)).nightShade, "automatic");
  assert.match(run.lines.join("\n"), /tabs\.present=1/);
  assert.match(run.lines.join("\n"), /preferences\.present=1/);
});

test("Archive tabs keep their saved state and thumbnail, and Android ids stay exactly as stored", async () => {
  const run = deps(fakeLegacy());
  await runLegacyImport(run);
  const [news] = readArchivedTabs(run.db, 10);
  assert.equal(news!.id, NEWS);
  assert.equal(news!.archivedAt, T - 7_000);
  assert.equal(news!.snapshotFileName, "file:///data/user/0/com.ardia.browser.android/files/PageSnapshots/news-1-300x600.jpg");
  assert.equal(readTabState(run.db, NEWS), "BAUG");
  assert.equal(readTabState(run.db, OTTER), "AAECAw==");
  assert.equal(readOpenTabs(run.db).find((t) => t.id === OTTER)!.snapshotFileName, "file:///data/user/0/com.ardia.browser.android/files/PageSnapshots/otter-1-300x600.jpg");
});

test("on iPhone ids are lowercased with every reference that points at them: state, selection and duplicates", async () => {
  const read = legacyRead();
  read.archive.push({ ...read.archive[0]!, id: NEWS.toLowerCase() });
  const fake = fakeLegacy({ read });
  const run = deps(fake, store(), { platform: "ios" });
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  const otter = OTTER.toLowerCase();
  assert.equal(readTabState(run.db, otter), "AAECAw==");
  assert.equal(launchTabs(readOpenTabs(run.db), 1).selectedId, otter);
  assert.equal(readArchivedTabs(run.db, 10).length, 1);
  assert.match(run.lines.join("\n"), /archive\.duplicate=1/);
});

test("the old app's selected tab is the one selected after the import, even when another was used later", async () => {
  const run = deps(fakeLegacy());
  await runLegacyImport(run);
  const open = readOpenTabs(run.db);
  assert.equal(launchTabs(open, 1).selectedId, OTTER);
  assert.equal(open.find((t) => t.id === EXAMPLE)!.lastActive, T + 9_000);
});

test("every record is imported or excluded with a reason, and the log line holds only counts and reasons", async () => {
  const read = legacyRead();
  read.tabs.push({ id: "", url: "https://x.example/", title: "x", created: T, lastActive: T, position: 1, origin: "typed" });
  read.tabs.push({ ...read.tabs[1]!, title: "Twice" });
  read.preferences["tabs.autoArchiveInterval"] = "fortnight";
  const run = deps(fakeLegacy({ read }));
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  const line = run.lines.find((l) => l.startsWith("ardia-legacy imported"))!;
  assert.match(line, /tabs=2 /);
  assert.match(line, /tabs\.notWeb=1/);
  assert.match(line, /tabs\.malformed=1/);
  assert.match(line, /tabs\.duplicate=1/);
  assert.match(line, /visits=4 /);
  assert.match(line, /visits\.notWeb=1/);
  assert.match(line, /preferences\.badValue=2/);
  assert.match(line, /preferences\.unknownKey=1/);
  assert.match(line, /preferences\.empty=1/);
  assert.doesNotMatch(line, /https?:|Otter|example|duckduckgo|fortnight|sideways/);
  assert.equal(parsePreferences(readPreferences(run.db)).autoArchiveInterval, parsePreferences({}).autoArchiveInterval);
});

test("a source that never finished onboarding imports as not finished, and data alone doesn't count as finished", async () => {
  for (const finished of ["false", undefined]) {
    const read = legacyRead();
    if (finished === undefined) delete read.preferences["settings.finishedOnboarding"];
    else read.preferences["settings.finishedOnboarding"] = finished;
    const run = deps(fakeLegacy({ read }));
    await runLegacyImport(run);
    assert.equal(readOpenTabs(run.db).length, 2);
    assert.equal(parsePreferences(readPreferences(run.db)).hasFinishedOnboarding, false);
  }
  const run = deps(fakeLegacy());
  await runLegacyImport(run);
  const typed = parsePreferences(readPreferences(run.db));
  assert.equal(typed.hasFinishedOnboarding, true);
  assert.equal(typed.searchSuggestions, false);
  assert.equal(typed.readerStep, 4);
  assert.equal(typed.autoOpensKeyboard, true);
});

test("history comes in pages of at most 5,000, each asked for after the last id, and all of it lands", async () => {
  const total = VISIT_PAGE * 2 + 1;
  const visits = Array.from({ length: total }, (_, i) => ({ id: i * 2 + 1, url: `https://site${i}.example/`, title: `Site ${i}`, visitedAt: T + i, transition: "link" }));
  const fake = fakeLegacy({ visits });
  const run = deps(fake);
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith("readVisits(")),
    [`readVisits(0,${VISIT_PAGE})`, `readVisits(${(VISIT_PAGE - 1) * 2 + 1},${VISIT_PAGE})`, `readVisits(${(VISIT_PAGE * 2 - 1) * 2 + 1},${VISIT_PAGE})`],
  );
  assert.equal(countVisits(run.db), total);
  assert.equal(fake.marked()!.visits, total);
});

test("after two failures the choice to start without the old data is offered, recorded apart from an import, and leaves the source alone", async () => {
  assert.deepEqual(importChoices(1, true), { tryAgain: true, startWithout: false });
  assert.deepEqual(importChoices(2, true), { tryAgain: true, startWithout: true });
  assert.deepEqual(importChoices(2, false), { tryAgain: true, startWithout: false });
  const fake = fakeLegacy();
  const run = deps(fake);
  fake.fail.add("read");
  await runLegacyImport(run);
  await runLegacyImport(run);
  assert.equal(await startWithoutImport(run), true);
  assert.ok(readPreferences(run.db)[LEGACY_FRESH_KEY]);
  assert.equal(readPreferences(run.db)[LEGACY_RECEIPT_KEY], undefined);
  assert.equal(fake.fresh(), true);
  fake.fail.clear();
  fake.calls.length = 0;
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "startedFresh" });
  assert.deepEqual(fake.calls, ["source"]);
  assert.equal(fake.marked(), null);
  assert.equal(readOpenTabs(run.db).length, 0);
});

test("an iPhone store the old importer already filled finishes only the native step instead of importing twice", async () => {
  const fake = fakeLegacy();
  const run = deps(fake, store(), { platform: "ios" });
  writeTabs(run.db, [tab(OTTER.toLowerCase(), "https://en.wikipedia.org/wiki/Otter", T)], []);
  writePreference(run.db, "legacy.importVersion", "1");
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.deepEqual(fake.calls, ["source", "applyNativeSettings", "markImported"]);
  assert.equal(readOpenTabs(run.db).length, 1);
});

test("a source already marked done starts without reading anything", async () => {
  const fake = fakeLegacy();
  const run = deps(fake);
  await runLegacyImport(run);
  fake.calls.length = 0;
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.deepEqual(fake.calls, ["source"]);
});

test("Start Without Them never starts when the native side can't open without importing, and records nothing", async () => {
  const fake = fakeLegacy();
  const { startFresh: _unused, ...withoutFresh } = fake.api;
  const run = deps(fake);
  run.legacy = withoutFresh;
  assert.equal(await startWithoutImport(run), false);
  assert.equal(readPreferences(run.db)[LEGACY_FRESH_KEY], undefined);
  const failing = deps(fake);
  failing.legacy = { ...fake.api, startFresh: async () => Promise.reject(new Error("gate")) };
  assert.equal(await startWithoutImport(failing), false);
  assert.equal(readPreferences(failing.db)[LEGACY_FRESH_KEY], undefined);
});

test("a committed receipt finishes the native steps even when the source has since become unusable", async () => {
  const fake = fakeLegacy({ unusable: "corrupt" });
  const run = deps(fake);
  writePreference(run.db, LEGACY_RECEIPT_KEY, JSON.stringify({ version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 }));
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.deepEqual(fake.calls, ["source", "applyNativeSettings", "markImported"]);
});

test("a recorded Start Without Them holds even when the source is unusable or can't be asked", async () => {
  const fake = fakeLegacy({ unusable: "corrupt" });
  const run = deps(fake);
  writePreference(run.db, LEGACY_FRESH_KEY, LEGACY_FRESH_VERSION);
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "startedFresh" });
  fake.fail.add("source");
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "startedFresh" });
});

test("a receipt whose native steps keep failing starts anyway once the person chose to start without them", async () => {
  const fake = fakeLegacy();
  const run = deps(fake);
  fake.fail.add("markImported");
  await runLegacyImport(run);
  assert.deepEqual(await runLegacyImport(run), { kind: "failed", reason: "markImported" });
  assert.equal(await startWithoutImport(run), true);
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "startedFresh" });
  fake.fail.clear();
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
});

test("the old app's selected tab stays selected over a newer tab the store already had", async () => {
  const run = deps(fakeLegacy());
  writeTabs(run.db, [tab("mine-1", "https://mine.example/", T + 90_000)], []);
  await runLegacyImport(run);
  assert.equal(launchTabs(readOpenTabs(run.db), 1).selectedId, OTTER);
  const kept = deps(fakeLegacy());
  writeTabs(kept.db, [{ ...tab(OTTER, "https://mine.example/", T), title: "Kept" }, tab("mine-2", "https://two.example/", T + 90_000)], []);
  await runLegacyImport(kept);
  const open = readOpenTabs(kept.db);
  assert.equal(launchTabs(open, 1).selectedId, OTTER);
  assert.equal(open.find((t) => t.id === OTTER)!.title, "Kept");
});

test("a write from elsewhere that rolls back the import's transaction is caught, and none of the import stays behind", async () => {
  const inner = store();
  const expoLike = {
    ...inner,
    transaction: (work: () => void) => {
      try {
        inner.exec("BEGIN");
        work();
        inner.exec("COMMIT");
      } catch (error) {
        inner.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const fake = fakeLegacy();
  const run = deps(fake, expoLike);
  const pages = fake.api.readVisits;
  let interfered = false;
  run.legacy = {
    ...fake.api,
    readVisits: async (afterId, limit) => {
      if (!interfered) {
        interfered = true;
        try {
          writeTabs(expoLike, [tab("other", "https://other.example/", T)], []);
        } catch {}
      }
      return pages(afterId, limit);
    },
  };
  assert.equal((await runLegacyImport(run)).kind, "failed");
  assert.equal(countVisits(inner), 0);
  assert.equal(readOpenTabs(inner).length, 0);
  run.legacy = fake.api;
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.equal(countVisits(inner), 4);
});

test("a source the native side marked started fresh starts without importing, and a receipt still finishes over it", async () => {
  const fake = fakeLegacy();
  const run = deps(fake);
  await fake.api.startFresh!();
  fake.calls.length = 0;
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "startedFresh" });
  assert.deepEqual(fake.calls, ["source"]);
  assert.equal(readOpenTabs(run.db).length, 0);
  assert.deepEqual(await runLegacyImport({ ...run, durable: false }), { kind: "ready", outcome: "startedFresh" });
  writePreference(run.db, LEGACY_RECEIPT_KEY, JSON.stringify({ version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 }));
  assert.deepEqual(await runLegacyImport(run), { kind: "ready", outcome: "imported" });
  assert.deepEqual(fake.marked(), { version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 });
});
