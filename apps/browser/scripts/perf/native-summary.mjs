import { frameRows } from "./frames-phase.mjs";
import { median } from "./median.mjs";


export const LOADING_FIXTURE = "/hang?id=load";

const onFixture = (s) => !!(s?.loading && s.id && s.url?.includes(LOADING_FIXTURE));

export const loadingThroughout = (r) => onFixture(r.loadingBefore) && onFixture(r.loadingAfter) && r.loadingBefore.id === r.loadingAfter.id;

export function summary(res) {
  const rows = [];
  const add = (name, xs, unit, digits = 0) => {
    const v = xs.filter(Number.isFinite);
    rows.push({ name, median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length, unit, digits, values: v });
  };
  add("launch → window shown", res.launch.map((r) => r.window), "ms");
  add("launch → window shown with its content", res.launch.map((r) => r.withContent), "ms");
  add("launch → JS running", res.launch.map((r) => r.js), "ms");
  add("launch → first page painted", res.launch.map((r) => r.firstPaint), "ms");
  add("launch → first page's first frame", res.launch.map((r) => r.firstFrame), "ms");
  const P = res.profiles ?? [];
  if (P.length) {
    const of = `${P[0].profiles} profiles, ${P[0].visits} opened`;
    add(`profiles loaded ${P[0].warmupMs / 1000} s after opening them (${of})`, P.map((r) => r.before.loaded), "");
    add(`profiles loaded after ${P[0].idleMs / 1000} s on Personal`, P.map((r) => r.after.loaded), "");
    add(`memory ${P[0].warmupMs / 1000} s after opening them (phys_footprint)`, P.map((r) => r.before.memory.totalMB), "MB");
    add(`memory after ${P[0].idleMs / 1000} s on Personal (phys_footprint)`, P.map((r) => r.after.memory.totalMB), "MB");
    add(`memory after ${P[0].idleMs / 1000} s on Personal, browser process`, P.map((r) => r.after.memory.kinds.browser), "MB");
    add(`processes after ${P[0].idleMs / 1000} s on Personal`, P.map((r) => r.after.memory.processes), "");
    add("back to a profile → its page shown", P.map((r) => r.back), "ms");
    add("back to a profile: runs where it had to load again", [P.filter((r) => r.reloaded).length], "");
  }
  const S = res.session;
  for (const t of ["tabs1", "tabs20"]) {
    add(`idle CPU, ${t.slice(4)} tab(s) (all processes)`, S.map((r) => r.idle[t]?.total.cpu), "%", 2);
    add(`idle wakeups/s, ${t.slice(4)} tab(s) (all processes)`, S.map((r) => r.idle[t]?.total.wakeups), "/s", 1);
    add(`idle CPU, ${t.slice(4)} tab(s) (browser process)`, S.map((r) => r.idle[t]?.kinds.browser?.cpu), "%", 2);
    add(`idle wakeups/s, ${t.slice(4)} tab(s) (browser process)`, S.map((r) => r.idle[t]?.kinds.browser?.wakeups), "/s", 1);
    add(`idle wakeups/s, ${t.slice(4)} tab(s) (GPU process)`, S.map((r) => r.idle[t]?.kinds["gpu-process"]?.wakeups), "/s", 1);
    add(`idle wakeups/s, ${t.slice(4)} tab(s) (renderers)`, S.map((r) => r.idle[t]?.kinds.renderer?.wakeups), "/s", 1);
  }
  const L = res.loading ?? [];
  const heldLoading = L.filter(loadingThroughout);
  for (const [k, what, runs] of [["loaded", "seed tab loaded", L], ["loading", "active tab loading", heldLoading]]) {
    if (!L.length) break;
    add(`${what}: wakeups/s (browser process)`, runs.map((r) => r[k]?.kinds.browser?.wakeups), "/s", 1);
    add(`${what}: CPU (browser process)`, runs.map((r) => r[k]?.kinds.browser?.cpu), "%", 2);
    add(`${what}: wakeups/s (all processes)`, runs.map((r) => r[k]?.total.wakeups), "/s", 1);
    add(`${what}: CPU (all processes)`, runs.map((r) => r[k]?.total.cpu), "%", 2);
    add(`${what}: wakeups/s (GPU process)`, runs.map((r) => r[k]?.kinds["gpu-process"]?.wakeups), "/s", 1);
  }
  if (L.length) {
    add("active tab loading: runs where the same tab was active and loading throughout (the rest are left out)", [heldLoading.length], "");
    add("active tab loading: someone used the Mac (s, per run)", L.map((r) => (r.loaded?.input?.inputSecs ?? NaN) + (r.loading?.input?.inputSecs ?? NaN)), "s", 2);
    add("active tab loading: 1-minute load average (start and end of each run)", L.flatMap((r) => r.load), "", 1);
  }
  for (const m of ["tabs1", "tabs10", "tabs20", "closed"]) add(`memory (phys_footprint), ${m === "closed" ? "after closing back to 1 tab" : m.slice(4) + " tab(s)"}`, S.map((r) => r.memory[m]?.totalMB), "MB");
  add("memory, browser process, 10 tabs", S.map((r) => r.memory.tabs10?.kinds.browser), "MB");
  add("memory, browser process, 20 tabs", S.map((r) => r.memory.tabs20?.kinds.browser), "MB");
  add("memory, browser process, after closing", S.map((r) => r.memory.closed?.kinds.browser), "MB");
  for (const m of ["tabs1", "tabs10", "tabs20", "closed"]) {
    const at = m === "closed" ? "after closing" : `${m.slice(4)} tab(s)`;
    add(`JS heap (Hermes), ${at}`, S.map((r) => r.heap?.[m]?.heapMB), "MB", 1);
    add(`JS allocated, incl. garbage not yet collected (Hermes), ${at}`, S.map((r) => r.heap?.[m]?.allocatedMB), "MB", 2);
  }
  const used = (r, k) => {
    const windows = [r.idle.tabs1, r.idle.tabs20].filter(Boolean);
    return windows.length ? windows.reduce((n, w) => n + (w.input?.[k] ?? NaN), 0) : NaN;
  };
  add("idle windows: someone used the Mac (s, per run)", S.map((r) => used(r, "inputSecs")), "s", 2);
  add("idle windows: …with the pointer moving over the window (s, per run)", S.map((r) => used(r, "overWindowSecs")), "s", 2);
  add("after an idle minute: command answered (App Nap check)", S.map((r) => r.idle.tabs1?.afterIdle?.commandMs), "ms");
  const timedSwitches = (r) => !r.parts || r.parts.includes("switch") || r.parts.includes("newtab");
  add("samples left out: page couldn't paint (switch + new tab, per run)", S.map((r) => r.throttled && timedSwitches(r) ? r.throttled.tabSwitch + r.throttled.newTab : NaN), "");
  add("tab switch → shown (median of 16 per run)", S.map((r) => median(r.tabSwitch)), "ms");
  add("new tab → first paint (median of 5 per run)", S.map((r) => median(r.newTab)), "ms");
  add("new tab → its page's first frame (median of 5 per run)", S.map((r) => median(r.newTabFrame ?? [])), "ms");
  const W = [...S, ...(res.windows ?? [])];
  add("new window → on screen (median per run)", W.map((r) => median(r.newWindow.map((w) => w.window))), "ms");
  add("new window → on screen with its content (median per run)", W.map((r) => median(r.newWindow.map((w) => w.withContent))), "ms");
  add("new window → first paint (median per run)", W.map((r) => median(r.newWindow.map((w) => w.firstPaint))), "ms");
  add("new window → its page's first frame (median per run)", W.map((r) => median(r.newWindow.map((w) => w.firstFrame))), "ms");
  const J = res.journeys ?? [];
  const pooled = (name, get) => {
    const v = J.flatMap((r) => get(r)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return;
    rows.push({ name, median: median(v), p75: v[Math.min(v.length - 1, Math.ceil(v.length * 0.75) - 1)], min: v[0], max: v.at(-1), n: v.length, unit: "ms", digits: 0 });
  };
  const of = (kind, field) => (r) => r[kind].map((x) => x[field]);
  pooled("J2 ⌘T key → JS has the new tab", of("j2", "js"));
  pooled("J2 ⌘T key → its command bar committed", of("j2", "commit"));
  pooled("J2 ⌘T key → that commit on screen", of("j2", "shown"));
  pooled("J2 ⌘T key → bar focused and on screen (typeable)", of("j2", "typeable"));
  pooled("J2 keystroke → its suggestions on screen", of("j2", "suggest"));
  pooled("J2 the app's own ⌘T → typeable (its t0 is the event's timestamp)", of("j2", "appTypeable"));
  pooled("J2 the app's t0 minus the key's timestamp (should be 0)", of("j2", "t0Skew"));
  pooled("J2 acperf hands ⌘T over → the event's timestamp (not in the rows)", of("j2", "postGap"));
  pooled("J2 ⌘T key made → the app's event loop saw it", of("j2", "delivery"));
  pooled("J2 keystroke made → the app's event loop saw it", of("j2", "suggestDelivery"));
  for (const [kind, from] of [["j4new", "new tab's bar (⌘T)"], ["j4page", "page's panel (⌘L)"]]) {
    pooled(`J4 ${from}: Enter → engine asked to load (our side)`, of(kind, "request"));
    pooled(`J4 ${from}: Enter → Chrome started the navigation`, of(kind, "start"));
    pooled(`J4 ${from}: Enter → document committed`, of(kind, "commit"));
    pooled(`J4 ${from}: Enter → first contentful paint (the app's mark)`, of(kind, "fcp"));
    pooled(`J4 ${from}: Enter → first contentful paint (the page's own, CDP)`, of(kind, "pageFcp"));
    pooled(`J4 ${from}: request → first contentful paint (engine and network)`, of(kind, "engine"));
    pooled(`J4 ${from}: Enter made → the app's event loop saw it`, of(kind, "delivery"));
  }
  if (J.length) {
    for (const kind of ["j2", "j4new", "j4page"]) {
      const lost = J.reduce((n, r) => n + r.lost[kind].length, 0);
      const kept = J.reduce((n, r) => n + r[kind].length, 0);
      if (lost || kept) rows.push({ name: `journeys ${kind}: iterations lost (no bar, panel, page or sample)`, median: lost, min: lost, max: lost, n: lost + kept, unit: "", digits: 0 });
    }
    const loads = J.flatMap((r) => r.load ?? []);
    if (loads.length) rows.push({ name: "journeys: 1-minute load average at each run's start and end", median: median(loads), min: Math.min(...loads), max: Math.max(...loads), n: loads.length, unit: "", digits: 0 });
    rows.push({ name: "journeys: fetches the guard answered (nothing left the machine)", median: J.reduce((n, r) => n + (r.blocked ?? 0), 0), min: 0, max: 0, n: J.length, unit: "", digits: 0 });
  }
  rows.push(...frameRows(res));
  return rows;
}
