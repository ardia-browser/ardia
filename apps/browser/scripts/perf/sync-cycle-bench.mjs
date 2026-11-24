#!/usr/bin/env node
// What one sync cycle of a profile costs the JS thread as its history grows (#3163): the real history adapter and
// syncScope in Node, on an in-memory folder shared by two devices.
//
//   node --import ./src/test-loader.mjs scripts/perf/sync-cycle-bench.mjs [--sizes 5000,25000,50000,100000] [--cycles 8]
//
// Per history size, after both devices have joined and settled: median and max JS-thread CPU ms of a cycle with nothing changed
// (idle), with one local visit (visit), and with one visit made on the other device (remote), plus heap growth.
// Run from apps/browser.

const { useBrowser } = await import("../../src/state/browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { historyAdapter, historyExpired } = await import("../../src/state/sync/historyAdapter.ts");
const { useEditClock } = await import("../../src/state/sync/editClock.ts");
const stub = await import("../../src/test-native/index.ts");

const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, x, i, all) => (x.startsWith("--") ? [...pairs, [x.slice(2), all[i + 1]]] : pairs), []));
const sizes = (flags.sizes ?? "5000,25000,50000,100000").split(",").map(Number);
const cycles = Number(flags.cycles ?? 8);
const S = () => useBrowser.getState();
const DAY = 86_400_000;

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        const knownIds = new Set(known);
        const shown = [...this.files].filter(([, f]) => f.scope === scope);
        return { files: shown.filter(([id]) => !knownIds.has(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: shown.map(([id]) => id) };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

function historyList(n, now) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const lastVisit = now - Math.floor((i / n) * 80 * DAY) - (i % 1000);
    const visits = 1 + (i % 4);
    list.push({ url: `https://site${i % 997}.example/page/${i}`, title: `Page ${i} about something`, favicon: null, visits, lastVisit, visitTimes: Array.from({ length: visits }, (_, k) => lastVisit - k * 3_600_000).reverse() });
  }
  return list;
}

class Device {
  constructor(id, folder, list) {
    this.id = id;
    this.folder = folder;
    S().hydrate({});
    useBrowser.setState({ history: { "": { list, floor: -Infinity, ready: true } } });
    this.browser = S();
    this.scope = emptyScope();
    this.clock = new Clock(id);
    this.adapter = historyAdapter("default");
  }
  with(fn) {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  async sync() {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      const t = process.threadCpuUsage();
      const result = await syncScope({ scope: "p", state: this.scope, transport: this.folder.transport(), adapters: [this.adapter], clock: this.clock, device: this.id, options: { expired: historyExpired } });
      const used = process.threadCpuUsage(t);
      return { ms: (used.user + used.system) / 1000, ...result };
    } finally {
      this.browser = S();
    }
  }
  visit(url, at) {
    this.with(() => {
      const view = S().history[""];
      const entry = { url, title: "New visit", favicon: null, visits: 1, lastVisit: at, visitTimes: [at] };
      useBrowser.setState({ history: { ...S().history, "": { ...view, list: [entry, ...view.list.filter((e) => e.url !== url)] } } });
    });
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (xs) => `${median(xs).toFixed(1)} (max ${Math.max(...xs).toFixed(1)})`;

for (const n of sizes) {
  stub.historyDbs?.clear?.();
  const now = Date.now();
  const folder = new Folder();
  const a = new Device("A", folder, historyList(n, now));
  const b = new Device("B", folder, historyList(n, now));
  for (let i = 0; i < 3; i++) {
    await a.sync();
    await b.sync();
  }
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const idle = [];
  for (let i = 0; i < cycles; i++) idle.push((await a.sync()).ms);
  const visit = [];
  for (let i = 0; i < cycles; i++) {
    a.visit(`https://fresh.example/a/${n}/${i}`, Date.now());
    visit.push((await a.sync()).ms);
  }
  const remote = [];
  for (let i = 0; i < cycles; i++) {
    b.visit(`https://fresh.example/b/${n}/${i}`, Date.now());
    await b.sync();
    remote.push((await a.sync()).ms);
  }
  global.gc?.();
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1048576;
  console.log(`history ${n}: idle ${fmt(idle)} ms  visit ${fmt(visit)} ms  remote ${fmt(remote)} ms  heap +${heapMb.toFixed(1)} MB  files ${folder.files.size}`);
}
