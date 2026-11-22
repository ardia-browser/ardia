import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seededRandom } from "./rng.mjs";
import { generateSteps, turn } from "./world.mjs";
import { instrumentStore, startServices } from "./probe.mjs";
import { loadRowHooks, mountRows, rowsOf } from "./rowHooks.mjs";
import { leakCheck } from "./leak.mjs";

const BASELINE = new URL("./baseline.json", import.meta.url);
export const COST_SEEDS = 10;

const label = (hook) => `${hook.module}#${hook.name}`;
const HOT_TITLE = "one tab's title changes";
const HOT_PAGE = "one tab's page state changes";
const RARE_SHARE = "one tab starts a screen share";
const HOT = new Set([HOT_TITLE, HOT_PAGE]);

export async function buildScene(world) {
  await world.reset();
  const S = world.S;
  const [w] = S().windowOrder;
  const url = (n) => `https://scene${n}.example/`;
  const ids = [1, 2, 3, 4, 5, 6].map((n) => S().newTab(w, { url: url(n), background: true }));
  S().pinTabs([ids[0]], true);
  S().groupTabs([ids[1], ids[2]], { pinned: false, name: "Loose" });
  S().groupTabs([ids[3]], { pinned: true, name: "Folder" });
  const work = S().createProfile({ name: "Work" });
  const other = S().createWindow({ url: url(7), profileId: work });
  for (const n of [8, 9, 10]) S().newTab(other, { url: url(n), background: true });
  await turn();
}

function mountWithTags(world, probe, loaded, rows) {
  const hooks = loaded.hooks;
  const instances = [];
  const failures = new Map();
  for (const hook of hooks) {
    probe.rowMount = label(hook);
    const mounted = mountRows(world, { ...loaded, hooks: [hook] }, rows);
    probe.rowMount = null;
    instances.push(...mounted.instances);
    for (const [k, v] of mounted.failures) failures.set(k, v);
  }
  return { instances, failures };
}

export async function rowProbe(world, probe, { extraHooks = [] } = {}) {
  await buildScene(world);
  const loaded = await loadRowHooks(world);
  loaded.hooks.push(...extraHooks);
  const rows = rowsOf(world);
  const { instances, failures } = mountWithTags(world, probe, loaded, rows);
  const media = (await world.modules.optional("state/media/media.ts"))?.useMedia;
  const probes = [];
  const targets = rows.slice(0, 4).map((r) => r.tabId);
  const wakes = new Map();
  const runProbe = async (name, tabId, act) => {
    for (let n = 0; n < 5; n++) await turn();
    for (const i of instances) i.instance.notified = 0;
    act();
    await turn();
    loaded.runner.settleAll();
    for (const { hook, row, instance } of instances) {
      if (row.tabId === tabId || !instance.notified) continue;
      const key = label(hook);
      if (!wakes.has(key)) wakes.set(key, { probes: new Set(), instances: 0 });
      wakes.get(key).probes.add(name);
      wakes.get(key).instances += 1;
    }
    probes.push(name);
  };
  for (const [n, tabId] of targets.entries()) await runProbe(HOT_TITLE, tabId, () => world.S().updateTab(tabId, { title: `probe ${n}` }));
  const pages = (await world.modules.optional("state/tabs/pageState.ts"))?.usePages;
  if (pages && pages.getState().pages)
    for (const [n, tabId] of targets.entries()) await runProbe(HOT_PAGE, tabId, () => pages.setState((p) => ({ pages: { ...p.pages, [tabId]: { ...(p.pages[tabId] ?? {}), status: `probe ${n}` } } })));
  if (media && media.getState().sharedTabs)
    for (const tabId of targets) await runProbe(RARE_SHARE, tabId, () => media.setState((m) => ({ sharedTabs: { ...m.sharedTabs, [tabId]: true } })));
  const wholeStore = [...new Set(instances.filter((i) => i.instance.sources.has(probe.wholeStoreSubscribe)).map((i) => label(i.hook)))].sort();
  for (const i of instances) i.instance.unmount();
  const leftOver = probe.registry.filter((e) => e.alive && e.rowHook && e.via !== "keyed watch").length;
  const flagged = [...wakes.keys()].sort();
  return {
    rows: rows.length,
    hooks: loaded.hooks.map((h) => ({ hook: label(h), usedBy: h.usedBy, mounted: !!h.fn && !failures.has(label(h)), failure: failures.get(label(h)) ?? (h.fn ? null : "not exported") })),
    flagged: flagged.map((k) => ({ hook: k, probes: [...wakes.get(k).probes], hot: [...wakes.get(k).probes].some((p) => HOT.has(p)), wokenRows: wakes.get(k).instances })),
    wholeBrowserStore: wholeStore,
    leftOverListeners: leftOver,
  };
}

export async function actionCosts(world, probe, { seeds, steps }) {
  const loaded = await loadRowHooks(world);
  const { changedIds } = await world.modules.at("state/browser/changes.ts");
  const perKind = {};
  const bump = (kind, field, n = 1) => {
    perKind[kind] ??= { steps: 0, listenerCalls: 0, byVia: {}, rowWakes: 0, outOfScopeRowWakes: 0, outOfScopeByHook: {} };
    if (typeof field === "string") perKind[kind][field] += n;
    return perKind[kind];
  };
  for (const seed of seeds) {
    await world.reset();
    const mounted = new Map();
    const sync = () => {
      const rows = new Map(rowsOf(world).map((r) => [r.tabId, r]));
      for (const [id, m] of mounted) {
        const row = rows.get(id);
        if (row && JSON.stringify(row) === m.key) continue;
        m.instances.forEach((i) => i.instance.unmount());
        mounted.delete(id);
      }
      for (const [id, row] of rows) {
        if (mounted.has(id)) continue;
        mounted.set(id, { key: JSON.stringify(row), instances: mountWithTags(world, probe, loaded, [row]).instances });
      }
    };
    sync();
    for (const step of generateSteps(seededRandom(seed), steps)) {
      const calls = new Map(probe.registry.map((e) => [e, e.calls[step.kind] ?? 0]));
      for (const m of mounted.values()) for (const i of m.instances) i.instance.notified = 0;
      const outcome = await probe.during(step.kind, () => world.run(step));
      if (outcome.skipped) continue;
      const entry = bump(step.kind);
      entry.steps++;
      for (const e of probe.registry) {
        const n = (e.calls[step.kind] ?? 0) - (calls.get(e) ?? 0);
        if (!n) continue;
        if (e.via === "keyed watch") entry.byVia[e.via] = (entry.byVia[e.via] ?? 0) + n;
        if (e.rowHook || e.via === "keyed watch") continue;
        entry.listenerCalls += n;
        entry.byVia[e.via] = (entry.byVia[e.via] ?? 0) + n;
      }
      const { before, after } = outcome;
      const global = before.settings !== after.settings || before.profiles !== after.profiles || before.profileOrder !== after.profileOrder || !!outcome.roundTrip || !!outcome.relaunch || !!outcome.syncPair;
      const touched = new Set(changedIds(after.tabs, before.tabs));
      for (const wid of changedIds(after.windows, before.windows)) for (const id of [...(after.windows[wid]?.tabIds ?? []), ...(before.windows[wid]?.tabIds ?? [])]) touched.add(id);
      for (const gid of changedIds(after.groups, before.groups)) for (const id of [...(after.groups[gid]?.tabIds ?? []), ...(before.groups[gid]?.tabIds ?? [])]) touched.add(id);
      for (const [id, m] of mounted)
        for (const { hook, instance } of m.instances) {
          if (!instance.notified) continue;
          entry.rowWakes += instance.notified;
          if (global || touched.has(id)) continue;
          entry.outOfScopeRowWakes += instance.notified;
          entry.outOfScopeByHook[label(hook)] = (entry.outOfScopeByHook[label(hook)] ?? 0) + instance.notified;
        }
      loaded.runner.settleAll();
      sync();
    }
    for (const m of mounted.values()) m.instances.forEach((i) => i.instance.unmount());
  }
  return perKind;
}

export function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    return { wholeStoreRowHooks: [] };
  }
}

function costSummary(result, baseline) {
  const lines = [];
  const known = new Set(baseline.wholeStoreRowHooks);
  const flagged = result.rows.flagged.filter((f) => f.hot).map((f) => f.hook);
  const fresh = flagged.filter((h) => !known.has(h));
  const fixed = baseline.wholeStoreRowHooks.filter((h) => !flagged.includes(h) && result.rows.hooks.some((x) => x.hook === h && x.mounted));
  lines.push(`cost: ${result.services.started.length} services started in node${result.services.failed.length ? `, ${result.services.failed.length} could not start (${result.services.failed.map((f) => f.split(":")[0]).join(", ")})` : ""}`);
  lines.push(`per-row hooks: ${result.rows.hooks.length} imported by per-row components, ${result.rows.hooks.filter((h) => h.mounted).length} mounted on ${result.rows.rows} rows`);
  for (const f of result.rows.flagged) lines.push(`  ${!f.hot ? "~" : known.has(f.hook) ? "·" : "✗"} ${f.hook} wakes ${f.wokenRows} rows of other tabs when ${f.probes.join("; ")}${!f.hot ? " [rare event: reported, not budgeted]" : known.has(f.hook) ? " [baseline]" : ""}`);
  for (const h of result.rows.wholeBrowserStore) lines.push(`  whole browser store from a per-row path: ${h}`);
  for (const h of fixed) lines.push(`  ✓ ${h} no longer wakes other rows: take it out of scripts/sim/baseline.json`);
  if (result.rows.leftOverListeners) lines.push(`  ✗ unmounting every row left ${result.rows.leftOverListeners} store listeners behind`);
  for (const h of result.rows.hooks.filter((x) => !x.mounted)) lines.push(`  (not mounted: ${h.hook}: ${h.failure})`);
  lines.push("per action: service listener calls (plain + keyed), keyed-watch hears, and per-row hook wakes (outOfScope: rows of tabs the action did not touch)");
  lines.push(`  ${"action".padEnd(18)} ${"steps".padStart(6)} ${"calls/step".padStart(10)} ${"plain".padStart(7)} ${"keyed".padStart(7)} ${"watch".padStart(7)} ${"rowWakes/step".padStart(13)} ${"outOfScope/step".padStart(15)}`);
  for (const [kind, e] of Object.entries(result.actions).sort()) {
    const per = (n) => (e.steps ? (n / e.steps).toFixed(1) : "-");
    lines.push(`  ${kind.padEnd(18)} ${String(e.steps).padStart(6)} ${per(e.listenerCalls).padStart(10)} ${per(e.byVia.subscribe ?? 0).padStart(7)} ${per(e.byVia.subscribeTo ?? 0).padStart(7)} ${per(e.byVia["keyed watch"] ?? 0).padStart(7)} ${per(e.rowWakes).padStart(13)} ${per(e.outOfScopeRowWakes).padStart(15)}`);
  }
  const unmounted = result.rows.hooks.filter((x) => !x.mounted);
  const ok = fresh.length === 0 && fixed.length === 0 && !result.rows.leftOverListeners && unmounted.length === 0;
  if (unmounted.length) lines.push(`✗ ${unmounted.length} per-row hook(s) could not be mounted, so they were not checked`);
  if (fresh.length) lines.push(`✗ ${fresh.length} per-row hook(s) wake rows of other tabs and are not in the baseline: ${fresh.join(", ")}`);
  return { text: lines.join("\n"), ok };
}

export function dependencyMap(probe, rows) {
  const byKey = new Map();
  const add = (key, entry) => {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  };
  const live = probe.registry.filter((e) => e.alive || e.rowHook);
  const sites = new Map();
  for (const e of live) {
    const id = `${e.via}|${e.site}|${e.rowHook ?? ""}`;
    if (!sites.has(id)) sites.set(id, { ...e, count: 0, reads: new Set(), calls: {} });
    const s = sites.get(id);
    if (e.alive) s.count++;
    for (const r of e.reads) s.reads.add(r);
    for (const [k, v] of Object.entries(e.calls)) s.calls[k] = (s.calls[k] ?? 0) + v;
  }
  for (const s of sites.values()) {
    const keys = s.keys ?? [...s.reads];
    if (!keys.length) add("(reads nothing it was handed: decides from other stores or getState)", s);
    for (const key of keys) add(key, s);
  }
  const owner = (site) => {
    const m = site.match(/^(state|components)\/([^/]+)\/([^#]+)/);
    return m ? `${m[1]}/${m[2]}` : site;
  };
  const lines = ["# Browser store dependency map", "", "Generated by `scripts/sim/run.mjs --mode map`: every listener on the browser store, by the top-level key it is keyed on (subscribeTo) or reads when it runs (plain listeners and keyed watches), with where it was registered.", ""];
  const all = [...sites.values()];
  const totalCalls = (s) => Object.values(s.calls).reduce((a, b) => a + b, 0);
  lines.push("## Summary", "");
  lines.push("- listeners registered before the probe was installed (the store's own session persistence and live-tab bookkeeping, set up when the store loads) are not in this map");
  lines.push(`- ${all.length} registration sites (${all.reduce((n, s) => n + s.count, 0)} live at the end; per-row hook registrations are listed once per site, not counted): ${all.filter((s) => s.via === "subscribe" && !s.rowHook).length} plain service listeners, ${all.filter((s) => s.via === "subscribeTo").length} keyed (subscribeTo), ${all.filter((s) => s.via === "keyed watch").length} keyed watches, ${all.filter((s) => s.rowHook).length} from per-row hooks`);
  const plainNarrow = all.filter((s) => s.via === "subscribe" && !s.rowHook && s.reads.size && s.reads.size <= 3);
  if (plainNarrow.length) lines.push(`- plain listeners that read three keys or fewer (candidates for subscribeTo): ${plainNarrow.map((s) => `${s.site} (${[...s.reads].join(", ")})`).join("; ")}`);
  const busiest = [...all].sort((a, b) => totalCalls(b) - totalCalls(a)).slice(0, 8);
  lines.push(`- most called during the run: ${busiest.map((s) => `${s.site} ${totalCalls(s)}`).join(", ")}`);
  lines.push("", "## By store key", "");
  for (const [key, entries] of [...byKey].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${key} (${entries.length})`, "");
    for (const s of entries.sort((a, b) => a.site.localeCompare(b.site))) lines.push(`- ${s.via}${s.rowHook ? " (one per row)" : s.count > 1 ? ` ×${s.count}` : ""}: \`${s.site}\` → ${s.rowHook ? `per-row hook ${s.rowHook}` : owner(s.site)}; called ${totalCalls(s)} times`);
    lines.push("");
  }
  if (rows) {
    lines.push("## Per-row hooks", "");
    for (const h of rows.hooks) lines.push(`- \`${h.hook}\` used by ${h.usedBy.join(", ")}${rows.wholeBrowserStore.includes(h.hook) ? "; **subscribes to the whole browser store**" : ""}${rows.flagged.some((f) => f.hook === h.hook) ? `; wakes rows of other tabs when ${rows.flagged.find((f) => f.hook === h.hook).probes.join("; ")}` : ""}${h.mounted ? "" : ` (not mounted: ${h.failure})`}`);
  }
  return lines.join("\n") + "\n";
}

export async function runMode(world, mode, { seeds, steps, out, asJson, mapFile, write }) {
  if (mode === "leak") return leakCheck(world, { out, asJson });
  const probe = instrumentStore(world, { trackReads: mode === "map" });
  world.setKind = (kind) => (probe.kind = kind);
  Object.defineProperty(world, "kind", { get: () => probe.kind, configurable: true });
  process.on("unhandledRejection", () => {});
  const services = await startServices(world);
  const rows = await rowProbe(world, probe);
  const costSeeds = seeds.slice(0, COST_SEEDS);
  const actions = await actionCosts(world, probe, { seeds: costSeeds, steps });
  if (mode === "map") {
    write(mapFile, dependencyMap(probe, rows));
    out(`dependency map: ${mapFile}`);
    return true;
  }
  const result = { services, rows, actions, seeds: costSeeds, steps };
  const summary = costSummary(result, readBaseline());
  if (asJson) out(JSON.stringify(result, null, 2));
  else out(summary.text);
  return summary.ok;
}

export const srcOf = (world) => fileURLToPath(world.modules.root);
