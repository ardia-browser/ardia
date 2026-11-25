import { turn } from "./world.mjs";
import { instrumentStore, startServices } from "./probe.mjs";
import { loadRowHooks, mountRows, rowsOf } from "./rowHooks.mjs";

const BOUNDED = new Set(["closedTabs", "closedWindows", "closedGroups", "deletedGroups", "cleanedTabs"]);
const HEAP_SLACK_BYTES = 4 * 1024 * 1024;

function recordSizes(s) {
  const sizes = {};
  for (const [key, v] of Object.entries(s)) {
    if (typeof v === "function" || v === null || typeof v !== "object") continue;
    sizes[key] = Array.isArray(v) ? v.length : Object.keys(v).length;
  }
  return sizes;
}

function nodeCount(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 8) return 0;
  let n = 1;
  for (const v of Array.isArray(value) ? value : Object.values(value)) n += nodeCount(v, depth + 1);
  return n;
}

const retained = (s) => nodeCount(Object.fromEntries(Object.entries(s).filter(([k, v]) => !BOUNDED.has(k) && typeof v !== "function")));

async function cycle(world, n, rowsChanged) {
  const S = world.S;
  const [home] = S().windowOrder;
  const url = (i) => `https://cycle${n}-${i}.example/`;
  const opened = [1, 2, 3, 4].map((i) => S().newTab(home, { url: url(i), background: i % 2 === 0 }));
  rowsChanged();
  S().activate(opened[1]);
  S().moveTab(opened[2], 1);
  S().pinTabs([opened[0]], true);
  S().pinTabs([opened[0]], false);
  const group = S().groupTabs([opened[1], opened[2]], { pinned: false, name: "Cycle" });
  S().ungroup(group);
  const other = S().createWindow({ url: url(5) });
  S().newTab(other, { url: url(6) });
  rowsChanged();
  S().moveTabsToWindow([opened[3]], other);
  S().closeWindow(other);
  for (const id of opened) if (S().tabs[id]) S().closeTab(id);
  await turn();
}

export async function leakCheck(world, { out, asJson, warmup = 10, cycles = 80, eachCycle, rows = true, services = true, hookFilter = () => true } = {}) {
  const probe = instrumentStore(world, { keepUnsubscribed: false });
  process.on("unhandledRejection", () => {});
  if (services) await startServices(world);
  const loaded = await loadRowHooks(world);
  loaded.hooks = rows ? loaded.hooks.filter((h) => hookFilter(`${h.module}#${h.name}`)) : [];
  await world.reset();
  const mounted = new Map();
  let mounts = 0;
  const syncRows = () => {
    const rows = new Map(rowsOf(world).map((r) => [r.tabId, r]));
    for (const [id, m] of mounted) {
      const row = rows.get(id);
      if (row && JSON.stringify(row) === m.key) continue;
      m.instances.forEach((i) => i.instance.unmount());
      mounted.delete(id);
    }
    for (const [id, row] of rows) {
      if (mounted.has(id)) continue;
      mounts++;
      mounted.set(id, { key: JSON.stringify(row), instances: mountRows(world, loaded, [row]).instances });
    }
  };
  const measure = () => {
    globalThis.gc?.();
    const s = world.S();
    const sizes = recordSizes(s);
    return {
      shape: `${s.windowOrder.length} window(s), ${Object.keys(s.tabs).length} tab(s)`,
      storeListeners: probe.alive(),
      rowSubscriptions: [...mounted.values()].reduce((n, m) => n + m.instances.reduce((k, i) => k + i.instance.subscriptions, 0), 0),
      timers: world.timers.pending(),
      records: Object.fromEntries(Object.entries(sizes).filter(([k]) => !BOUNDED.has(k))),
      retainedNodes: retained(s),
      rowMounts: mounts,
      bounded: Object.fromEntries(Object.entries(sizes).filter(([k]) => BOUNDED.has(k))),
      heap: globalThis.gc ? process.memoryUsage().heapUsed : null,
    };
  };
  syncRows();
  const runCycles = async (from, count) => {
    for (let n = from; n < from + count; n++) {
      await cycle(world, n, syncRows);
      eachCycle?.(world);
      loaded.runner.settleAll();
      syncRows();
    }
  };
  const started = performance.now();
  await runCycles(0, warmup);
  const start = measure();
  await runCycles(warmup, cycles / 2);
  const middle = measure();
  await runCycles(warmup + cycles / 2, cycles / 2);
  const end = measure();
  for (const m of mounted.values()) m.instances.forEach((i) => i.instance.unmount());
  const problems = [];
  if (start.shape !== end.shape) problems.push(`cycles did not end in the starting shape: ${start.shape} -> ${end.shape}`);
  for (const field of ["storeListeners", "rowSubscriptions", "timers"]) if (end[field] > start[field]) problems.push(`${field} grew ${start[field]} -> ${end[field]}`);
  if (end.retainedNodes > start.retainedNodes) problems.push(`store data grew ${start.retainedNodes} -> ${end.retainedNodes} nested objects`);
  if (rows && end.rowMounts - middle.rowMounts < cycles) problems.push("rows were not mounted and unmounted during the cycles");
  for (const [key, n] of Object.entries(end.records)) if (n > (start.records[key] ?? 0)) problems.push(`store record ${key} grew ${start.records[key] ?? 0} -> ${n}`);
  for (const [key, n] of Object.entries(end.bounded)) if (n > middle.bounded[key]) problems.push(`bounded list ${key} still growing ${middle.bounded[key]} -> ${n}`);
  if (start.heap !== null && end.heap - start.heap > HEAP_SLACK_BYTES) problems.push(`heap after GC grew ${((end.heap - start.heap) / 1048576).toFixed(1)} MB over ${cycles} cycles`);
  const ms = Math.round(performance.now() - started);
  if (asJson) out(JSON.stringify({ mode: "leak", warmup, cycles, start, end, problems }, null, 2));
  else {
    out(`leak: ${cycles} open/close/window cycles after ${warmup} warm-up, ${end.shape}`);
    process.stderr.write(`leak: ${ms} ms\n`);
    out(`  store listeners ${start.storeListeners} -> ${end.storeListeners}, row subscriptions ${start.rowSubscriptions} -> ${end.rowSubscriptions}, timers ${start.timers} -> ${end.timers}, ${start.heap !== null ? `heap after GC within ${HEAP_SLACK_BYTES / 1048576} MB` : "heap not checked (run with --expose-gc)"}`);
    if (start.heap !== null) process.stderr.write(`leak: heap ${(start.heap / 1048576).toFixed(1)} -> ${(end.heap / 1048576).toFixed(1)} MB\n`);
    out(`  bounded lists at the end: ${Object.entries(end.bounded).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    for (const p of problems) out(`  ✗ ${p}`);
  }
  return problems.length === 0;
}
