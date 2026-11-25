const P = globalThis.acPerf;
const bench = globalThis.acBench;
if (!P || !bench) throw new Error("load bench-app.js first (and turn the perf probe on)");
const sleep = (ms) => new Promise((resolve) => setTimeout(function benchSleep() {
  resolve();
}, ms));
const pageOf = (tab) => tab.page ?? { nav: tab.navigation, adopt: tab.adoptId };
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);

const CHURN_OPEN_MS = 60;
const CHURN_CLOSE_MS = 10;
const CHURN_SWITCH_MS = 10;
const NODES_SETTLE_BEFORE_MS = 1500;
const NODES_WATCH_AFTER_MS = 2500;

const extra = {
  async nodeChurn({ origin, opens = 60, switches = 120 } = {}) {
    if (!P.nativeNodes?.()) return { left: null };
    const S = () => ac.store.getState();
    const w = S().ui.focusOrder?.[0] ?? S().ui.focusedWindowId;
    const ids = S().windows[w].tabIds.slice(0, 20);
    const visit = (n, gap) => Array.from({ length: n }).reduce((p, _, i) => p.then(() => S().activate(ids[(i * 7) % ids.length])).then(() => sleep(gap)), Promise.resolve());
    await visit(ids.length, 60);
    S().activate(ids[0]);
    await sleep(NODES_SETTLE_BEFORE_MS);
    const start = P.nativeNodes().live;
    for (let i = 0; i < opens; i++) {
      const made = S().newTab(w, { url: `${origin}/p/churn-${i}-${Date.now()}` });
      const id = typeof made === "string" ? made : made?.id;
      await sleep(CHURN_OPEN_MS);
      if (id) S().closeTab(id);
      await sleep(CHURN_CLOSE_MS);
    }
    await visit(switches, CHURN_SWITCH_MS);
    S().activate(ids[0]);
    await sleep(NODES_WATCH_AFTER_MS);
    const end = P.nativeNodes().live;
    return { start, end, left: end - start };
  },
  async launch({ quietMs = 2500, timeoutMs = 30000 } = {}) {
    const state = () => {
      const s = P.read();
      return `${s.commits}:${sum(s.storeUpdates)}:${sum(s.writes)}`;
    };
    const copy = () => JSON.parse(JSON.stringify(P.read()));
    const shownTabs = (s) => {
      const ids = new Set();
      for (const w of Object.values(s.windows)) {
        const id = w.activeTabIds?.[w.profileId];
        if (!id) continue;
        ids.add(id);
        for (const split of Object.values(s.splits ?? {})) {
          const panes = split.slots ? split.slots.flatMap((x) => x.stack ?? [x.tabId]) : split.tabIds ?? [];
          if (panes.includes(id)) for (const pane of panes) ids.add(pane);
        }
      }
      return ids;
    };
    let backgroundWakeAt = 0;
    const stopWatching = ac.store.subscribe.unprobed((s, prev) => {
      if (backgroundWakeAt || s.tabs === prev.tabs) return;
      const shown = shownTabs(s);
      for (const [id, t] of Object.entries(s.tabs)) {
        const was = prev.tabs[id];
        if (!was || t === was || shown.has(id)) continue;
        const now = pageOf(t);
        const before = pageOf(was);
        if ((now.nav && !before.nav) || (now.adopt && !before.adopt)) {
          backgroundWakeAt = Date.now();
          return;
        }
      }
    });
    const end = Date.now() + timeoutMs;
    let last = state();
    let since = Date.now();
    let beforeWake = copy();
    try {
      while (Date.now() < end) {
        await sleep(250);
        if (backgroundWakeAt) return { stats: beforeWake, settled: true, endedAtBackgroundWake: backgroundWakeAt - since, firstCommitMounts: P.firstCommitMounts ?? null };
        const now = state();
        if (now !== last) {
          last = now;
          since = Date.now();
        } else if (Date.now() - since >= quietMs) break;
        beforeWake = copy();
      }
    } finally {
      stopWatching();
    }
    return { stats: P.read(), settled: Date.now() < end, firstCommitMounts: P.firstCommitMounts ?? null };
  },
};

bench.names.push(...Object.keys(extra));
const run = bench.run;
bench.run = (name, options) => (name in extra ? extra[name](options ?? {}) : run(name, options));
return bench.names;
