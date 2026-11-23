const P = globalThis.acPerf;
if (!P) throw new Error("perf probe is off (no perf-probe file in the data folder)");
const S = () => ac.store.getState();
const sleep = (ms) => new Promise((resolve) => setTimeout(function soakSleep() {
  resolve();
}, ms));
const windowIds = () => S().windowOrder ?? Object.keys(S().windows);
const activeIn = (w) => S().windows[w]?.activeTabIds?.[S().windows[w].profileId];
const harness = (label) => /soakSleep|soakLagTick|pollDevEval|benchSleep|benchSettleStep|watchDevEval/.test(label) || label === "setInterval:anonymous";
const isPinned = (tab) => !!(tab.pin ?? tab.pinned);

let navSeq = 0;
let made = [];

function sizeOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (value && typeof value === "object") return Object.keys(value).length;
  return null;
}

function storeSizes() {
  const s = S();
  const sizes = {};
  for (const key of Object.keys(s)) {
    const n = sizeOf(s[key]);
    if (n !== null) sizes[key] = n;
  }
  for (const [engine, view] of Object.entries(s.history ?? {})) sizes[`history.${engine || "default"}`] = view?.list?.length ?? 0;
  const others = { pages: ac.pageState, favicons: ac.favicons?.useFavicons, media: ac.media, toasts: ac.toasts, settingsNav: ac.settingsNav };
  for (const [name, store] of Object.entries(others)) {
    const state = store?.getState?.();
    if (!state) continue;
    for (const key of Object.keys(state)) {
      const n = sizeOf(state[key]);
      if (n !== null && n > 0) sizes[`${name}.${key}`] = n;
    }
  }
  return sizes;
}

function busyMs(stats) {
  let ms = 0;
  for (const [k, v] of Object.entries(stats.taskMs ?? {})) if (k !== "JSTimers.callTimers") ms += v;
  for (const [k, v] of Object.entries(stats.timerMs ?? {})) if (!harness(k)) ms += v;
  return ms;
}

function top(counter, n = 8) {
  return Object.entries(counter ?? {}).filter(([k]) => !harness(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v * 10) / 10]);
}

function heap() {
  const read = () => (globalThis.HermesInternal?.getInstrumentedStats?.() ?? {});
  const before = read();
  const t = P.now();
  if (typeof globalThis.gc === "function") globalThis.gc();
  const gcMs = P.now() - t;
  const after = read();
  return { heapMb: (after.js_heapSize ?? 0) / 1048576, allocatedMb: (after.js_allocatedBytes ?? 0) / 1048576, liveBeforeGcMb: (before.js_allocatedBytes ?? 0) / 1048576, numGCs: after.js_numGCs, gcTimeS: after.js_gcTime, forcedGcMs: gcMs };
}

const hermes = () => globalThis.HermesInternal?.getInstrumentedStats?.() ?? {};

function lagMeter() {
  const lags = [];
  let expected = Date.now() + 50;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 50;
    setTimeout(soakLagTick, 50);
  };
  const soakLagTick = () => tick();
  setTimeout(soakLagTick, 50);
  return () => {
    stopped = true;
    const sorted = [...lags].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return { ticks: lags.length, lagP50: at(0.5), lagP95: at(0.95), lagMax: sorted[sorted.length - 1] ?? 0, lagTotalMs: lags.reduce((a, b) => a + b, 0) };
  };
}

function gcDelta(before) {
  const after = hermes();
  return { gcs: (after.js_numGCs ?? 0) - (before.js_numGCs ?? 0), gcMs: ((after.js_gcTime ?? 0) - (before.js_gcTime ?? 0)) * 1000, gcCpuMs: ((after.js_gcCPUTime ?? 0) - (before.js_gcCPUTime ?? 0)) * 1000 };
}

function syncState() {
  const sync = ac.sync;
  if (!sync?.useSync) return null;
  const u = sync.useSync.getState();
  return { status: u.status, enabled: u.enabled, pending: u.pending, lastSyncedAt: u.lastSyncedAt, devices: u.devices?.length ?? 0 };
}

function sumCounter(counter) {
  return Object.values(counter ?? {}).reduce((a, b) => a + b, 0);
}

async function timedAction(fn, settleMs = 600) {
  P.reset();
  const t = P.now();
  P.batch(fn);
  const syncMs = P.now() - t;
  await sleep(settleMs);
  const stats = P.read();
  return { syncMs, busyMs: busyMs(stats), commits: stats.commits };
}

function switchCandidates(w) {
  const s = S();
  const win = s.windows[w];
  return win.tabIds.filter((id) => s.tabs[id] && s.tabs[id].profileId === win.profileId && !isPinned(s.tabs[id]));
}

async function idleWindow(idleMs) {
  P.reset();
  const idleGc = hermes();
  const idleLag = lagMeter();
  await sleep(idleMs);
  const idle = P.read();
  return { idleBusyMsPerS: busyMs(idle) / (idleMs / 1000), idleTop: top({ ...idle.taskMs, ...idle.timerMs }, 6), idleLag: idleLag(), idleGc: gcDelta(idleGc) };
}

async function probeActions(origin, idleMs) {
  const w = windowIds()[0];
  const ids = switchCandidates(w);
  const start = activeIn(w);
  const switches = [];
  for (let i = 0; i < 6; i++) {
    const id = ids[(i * 7 + 3) % ids.length];
    switches.push(await timedAction(() => {
      S().setSelection(w, []);
      S().activate(id);
    }, 400));
  }
  let opened;
  const open = await timedAction(() => {
    const r = S().newTab(w, { url: `${origin}/p/probe-${Date.now()}` });
    opened = typeof r === "string" ? r : r?.id ?? activeIn(w);
  }, 800);
  const close = await timedAction(() => S().closeTab(opened), 800);
  await timedAction(() => S().activate(start), 300);
  P.reset();
  const idleGc = hermes();
  const idleLag = lagMeter();
  await sleep(idleMs);
  const idle = P.read();
  const idleLagStats = idleLag();
  const idleGcStats = gcDelta(idleGc);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return {
    switchSyncMs: median(switches.map((x) => x.syncMs)),
    switchBusyMs: median(switches.map((x) => x.busyMs)),
    openSyncMs: open.syncMs,
    openBusyMs: open.busyMs,
    closeSyncMs: close.syncMs,
    closeBusyMs: close.busyMs,
    idleBusyMsPerS: busyMs(idle) / (idleMs / 1000),
    idleTop: top({ ...idle.taskMs, ...idle.timerMs }, 6),
    idleLag: idleLagStats,
    idleGc: idleGcStats,
  };
}

globalThis.acSoak = {
  async sample({ origin, actions = true, idleMs = 4000, idleOnly = false } = {}) {
    const timing = idleOnly ? await idleWindow(idleMs) : actions ? await probeActions(origin, idleMs) : null;
    const live = P.live ? P.live() : null;
    const liveTotals = live ? Object.fromEntries(Object.entries(live).map(([k, c]) => [k, sumCounter(c)])) : null;
    return {
      at: Date.now(),
      navSeq,
      heap: heap(),
      store: storeSizes(),
      live: liveTotals,
      liveTop: live ? Object.fromEntries(Object.entries(live).map(([k, c]) => [k, top(c, 12)])) : null,
      nativeNodes: typeof P.nativeNodes === "function" ? P.nativeNodes() : null,
      sync: syncState(),
      timing,
    };
  },

  async round({ origin, navigations = 60, opens = 20, switches = 40, fanout = 6, gapMs = 40, uniqueShare = 0.6 } = {}) {
    const started = Date.now();
    const ws = windowIds();
    P.reset();
    const gcBefore = hermes();
    const lag = lagMeter();
    for (let i = 0; i < navigations; i += fanout) {
      const w = ws[(i / fanout) % ws.length];
      const ids = switchCandidates(w);
      for (let k = 0; k < fanout && i + k < navigations; k++) {
        const id = ids[(navSeq * 13 + k * 5) % ids.length];
        navSeq++;
        const unique = (navSeq * 7919) % 100 < uniqueShare * 100;
        const path = unique ? `soak-${navSeq}` : `repeat-${navSeq % 40}`;
        S().navigate(id, `${origin}/p/${path}?h=${navSeq % 3}`);
      }
      await sleep(gapMs * 4);
    }
    for (let i = 0; i < opens; i++) {
      const w = ws[i % ws.length];
      const r = S().newTab(w, { url: `${origin}/p/open-${navSeq++}` });
      made.push(typeof r === "string" ? r : r?.id ?? activeIn(w));
      await sleep(gapMs);
      if (made.length > 6) {
        const id = made.shift();
        if (S().tabs[id]) S().closeTab(id);
        await sleep(gapMs);
      }
    }
    for (let i = 0; i < switches; i++) {
      const w = ws[i % ws.length];
      const ids = switchCandidates(w);
      const id = ids[(navSeq + i * 11) % ids.length];
      S().setSelection(w, []);
      S().activate(id);
      await sleep(gapMs);
    }
    const stats = P.read();
    return { ms: Date.now() - started, busyMs: busyMs(stats), commits: stats.commits, ...lag(), ...gcDelta(gcBefore), top: top({ ...stats.taskMs, ...stats.timerMs, ...stats.listenerMs }, 10) };
  },

  async closeMade() {
    for (const id of made) if (S().tabs[id]) S().closeTab(id);
    made = [];
    await sleep(500);
    return true;
  },
};
