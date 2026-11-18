import assert from "node:assert/strict";
import test from "node:test";
import { collectSince, createTelemetryLocal, downloadSaver, planPrune, startFlushRelay, telemetryLocalAvailable, utf8Bytes } from "./hostTelemetryLocal.ts";
import { resolveHostModule } from "./hostModules.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const line = (at, extra = {}) => `${JSON.stringify({ at, kind: "event", sent: true, ...extra })}\n`;

function memoryStore() {
  let next = 1;
  const rows = new Map();
  const chunks = () => [...rows].map(([key, value]) => ({ key, ...value }));
  return {
    rows,
    adds: 0,
    text: () => chunks().sort((a, b) => (a.day === b.day ? a.key - b.key : a.day < b.day ? -1 : 1)).map((chunk) => chunk.text).join(""),
    async add(chunkDay, text) {
      this.adds++;
      rows.set(next++, { day: chunkDay, text });
    },
    all: async () => chunks(),
    async change(plan) {
      const { put, remove, result } = plan(chunks());
      for (const key of remove) rows.delete(key);
      for (const { key, day: chunkDay, text } of put) rows.set(key, { day: chunkDay, text });
      return result;
    },
    async clear() {
      rows.clear();
    },
  };
}

function local(overrides = {}) {
  const store = memoryStore();
  const saved = [];
  const module = createTelemetryLocal({
    chunks: store,
    writes: true,
    save: async (name, text) => (saved.push({ name, text }), `/home/me/Downloads/${name}`),
    clock: () => 0,
    now: () => NOW,
    ...overrides,
  });
  return { store, saved, module };
}

test("appends keep their order, and a day is one record after a prune", async () => {
  const { store, module } = local();
  module.append(day(NOW), line(NOW - 3000, { n: 1 }));
  module.appendNow(day(NOW), line(NOW - 2000, { n: 2 }) + line(NOW - 1000, { n: 3 }));
  module.append("not-a-day", line(NOW));
  module.append(day(NOW), "");
  await module.settled();
  assert.equal(store.rows.size, 2);
  const stats = await module.prune(NOW);
  assert.deepEqual({ lines: stats.lines, files: stats.files, droppedLines: stats.droppedLines, writes: stats.writeMs.length }, { lines: 3, files: 1, droppedLines: 0, writes: 2 });
  assert.equal(stats.bytes, utf8Bytes(store.text()));
  assert.equal(store.rows.size, 1);
  assert.deepEqual(store.text().trim().split("\n").map((text) => JSON.parse(text).n), [1, 2, 3]);
  assert.deepEqual((await module.prune(NOW)).writeMs, []);
});

test("a prune drops days outside the window and the old lines of the oldest day", async () => {
  const { store, module } = local();
  const cutoff = NOW - 7 * DAY_MS;
  module.append(day(cutoff - DAY_MS), line(cutoff - DAY_MS, { n: "gone-day" }));
  module.append(day(cutoff), line(cutoff - 1, { n: "gone-line" }) + line(cutoff, { n: "edge" }) + line(cutoff + 1, { n: "kept" }));
  module.append(day(NOW), line(NOW, { n: "today" }));
  module.append(day(NOW + 3 * DAY_MS), line(NOW + 3 * DAY_MS, { n: "future" }));
  const stats = await module.prune(NOW);
  assert.equal(stats.droppedLines, 3);
  assert.equal(stats.files, 2);
  assert.deepEqual(store.text().trim().split("\n").map((text) => JSON.parse(text).n), ["edge", "kept", "today"]);
  assert.equal((await module.prune(NOW)).droppedLines, 0);
});

test("the size cap drops the oldest lines first, down to nine tenths", () => {
  const each = utf8Bytes(line(NOW, { pad: "x".repeat(60) }));
  const chunks = [];
  for (let i = 0; i < 30; i++) chunks.push({ key: i + 1, day: day(NOW - (i < 10 ? DAY_MS : 0)), text: line(NOW - (i < 10 ? DAY_MS : 0), { pad: "x".repeat(60) }) });
  const max = each * 19;
  const plan = planPrune(chunks, NOW, 7 * DAY_MS, max);
  assert.ok(plan.bytes <= max - Math.floor(max / 10));
  assert.equal(plan.bytes, each * 17);
  assert.equal(plan.dropped, 13);
  assert.equal(plan.files, 1);
  assert.equal(plan.lines, 17);
  assert.equal(utf8Bytes(plan.put[0].text), plan.bytes);
  assert.ok(plan.remove.includes(1) && plan.remove.includes(10));
  const under = planPrune(chunks, NOW, 7 * DAY_MS, each * 30);
  assert.equal(under.dropped, 0);
  assert.equal(under.bytes, each * 30);
});

test("a write past the cap prunes without waiting for the hourly check", async () => {
  const { store, module } = local();
  const text = line(NOW, { pad: "é".repeat(100) });
  module.configure(utf8Bytes(text) * 4, 7);
  await module.prune(NOW);
  for (let i = 0; i < 6; i++) module.append(day(NOW), text);
  await module.settled();
  assert.ok(utf8Bytes(store.text()) <= utf8Bytes(text) * 4);
  assert.ok((await module.prune(NOW)).droppedLines >= 2);
});

test("Clear empties the copy and later writes start again", async () => {
  const { store, module } = local();
  module.append(day(NOW), line(NOW));
  await module.clear();
  assert.equal(store.rows.size, 0);
  module.append(day(NOW), line(NOW, { n: "after" }));
  await module.settled();
  assert.equal(store.rows.size, 1);
});

test("the export saves every kept line under the Mac's file name", async () => {
  const gathered = [];
  const { saved, module } = local({ gather: async () => void gathered.push(true) });
  module.append(day(NOW - 8 * DAY_MS), line(NOW - 8 * DAY_MS, { n: "old" }));
  module.append(day(NOW - DAY_MS), line(NOW - DAY_MS, { n: "yesterday" }));
  module.append(day(NOW), line(NOW, { n: "today" }));
  const exported = await module.exportToDownloads(NOW);
  assert.equal(gathered.length, 1);
  assert.equal(saved[0].name, "Ardia data 2026-11-14.jsonl");
  assert.deepEqual(saved[0].text.trim().split("\n").map((text) => JSON.parse(text).n), ["yesterday", "today"]);
  assert.deepEqual(exported, { path: "/home/me/Downloads/Ardia data 2026-11-14.jsonl", bytes: utf8Bytes(saved[0].text), lines: 2 });
  assert.equal(await module.exportForReport(NOW - DAY_MS), null);
  const failed = local({ save: async () => null });
  assert.equal(await failed.module.exportToDownloads(NOW), null);
  assert.deepEqual(collectSince([{ key: 1, day: day(NOW), text: line(NOW - 10) + line(NOW + 10) }], NOW), { text: line(NOW + 10), lines: 1 });
});

test("a private window never writes but can still read", async () => {
  const { store, saved, module } = local({ writes: false });
  module.append(day(NOW), line(NOW));
  module.appendNow(day(NOW), line(NOW));
  await module.settled();
  assert.equal(store.adds, 0);
  await store.add(day(NOW), line(NOW, { n: "other-window" }));
  assert.equal((await module.exportToDownloads(NOW)).lines, 1);
  assert.equal(saved.length, 1);
});

test("several windows writing one copy lose nothing", async () => {
  const store = memoryStore();
  const windows = [0, 1, 2].map(() => createTelemetryLocal({ chunks: store, writes: true, save: async () => null, clock: () => 0, now: () => NOW }));
  windows.forEach((window, index) => {
    for (let i = 0; i < 20; i++) window.append(day(NOW), line(NOW + i, { window: index, i }));
  });
  await Promise.all([windows[0].prune(NOW), windows[1].prune(NOW), ...windows.map((window) => window.settled())]);
  const stats = await windows[2].prune(NOW);
  assert.equal(stats.lines, 60);
  assert.equal(stats.droppedLines, 0);
});

test("without storage the copy says so instead of pretending", async () => {
  const module = createTelemetryLocal({ chunks: null, writes: true, save: async () => "/x" });
  assert.throws(() => module.append(day(NOW), line(NOW)), { code: "ERR_UNAVAILABLE" });
  await assert.rejects(module.prune(NOW), { code: "ERR_UNAVAILABLE" });
  assert.equal(await module.clear(), undefined);
  assert.equal(await module.exportToDownloads(NOW), null);
  assert.equal(telemetryLocalAvailable(), false);
  const host = { bootstrap: { windowId: "main", profileId: "", capabilities: [] }, invoke: async () => null, call: async () => "null", onEvent: () => () => {} };
  assert.throws(() => resolveHostModule(host, "ArdiaTelemetryLocal", "append")(day(NOW), line(NOW)), { code: "ERR_UNAVAILABLE" });
  assert.equal(resolveHostModule(host, "ArdiaTelemetryLocal", "configure")(1024, 7), undefined);
  assert.equal(await resolveHostModule(host, "ArdiaTelemetryLocal", "exportToDownloads")(NOW), null);
});

test("the saved file is the finished download of the blob the page started", async () => {
  const steps = [[], [{ url: "blob:other", state: "finished", path: "/other" }, { url: "blob:mine", state: "downloading", path: "" }], [{ url: "blob:mine", state: "finished", path: "/home/me/Downloads/Ardia data 2026-11-14.jsonl" }]];
  const released = [];
  let clock = 0;
  const deps = { begin: () => "blob:mine", release: (url) => released.push(url), list: async () => steps.shift() ?? [], pause: async (ms) => void (clock += ms), now: () => clock };
  assert.equal(await downloadSaver(deps)("Ardia data 2026-11-14.jsonl", "{}\n"), "/home/me/Downloads/Ardia data 2026-11-14.jsonl");
  assert.deepEqual(released, ["blob:mine"]);
  assert.equal(await downloadSaver({ ...deps, list: async () => [{ url: "blob:mine", state: "cancelled", path: "" }] })("a", "b"), null);
  assert.equal(await downloadSaver({ ...deps, list: async () => [] })("a", "b"), null);
  assert.ok(clock >= 30_000);
});

test("an export asks the window that owns telemetry to flush first", async () => {
  const ports = [];
  const port = () => {
    const self = { onmessage: null, postMessage: (data) => queueMicrotask(() => ports.forEach((other) => other !== self && other.onmessage?.({ data }))) };
    ports.push(self);
    return self;
  };
  const flushed = [];
  const window = (name, leading) => startFlushRelay({ channel: port(), leading: async () => leading, flush: async () => void flushed.push(name), settled: async () => void flushed.push(`${name}:settled`), timeoutMs: 50 });
  const owner = window("owner", true);
  window("other", false);
  const settings = window("settings", false);
  await settings.gather();
  assert.deepEqual(flushed, ["owner", "owner:settled"]);
  await owner.gather();
  assert.deepEqual(flushed, ["owner", "owner:settled"]);
  ports.length = 0;
  const alone = startFlushRelay({ channel: port(), leading: async () => false, flush: async () => {}, settled: async () => {}, timeoutMs: 20 });
  await alone.gather();
});
