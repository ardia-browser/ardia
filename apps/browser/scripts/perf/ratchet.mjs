#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHarnessTimer } from "./js-bench.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = process.env.RATCHET_APP_DIR ? resolve(process.env.RATCHET_APP_DIR) : resolve(here, "../..");
const repo = resolve(appDir, "../..");
const ceilingsFile = join(here, "ratchet.json");

export const JOURNEYS = ["startup", "launch", "idle", "typing", "switchTabs", "scroll", "hover", "pageLoad", "openClose", "nodeChurn"];
export const SMALL_JOURNEYS = ["startup", "launch"];
const OPTIONS = '{"seconds":5}';
const DEFAULT_PORT = 47831;
const DEFAULT_CDP_PORT = 9700;
const BASELINE_LANES = 4;

const EXACT_SHARE = 1;
const NOISY_SPREAD = 0.3;
const NOISY_MARGIN = 0.1;
const INSTR_TOLERANCE = 0.04;
const NAMED_ROOM = 2;
const MIN_RUNS = 6;

const COUNTERS = ["renders", "mounts", "storeUpdates", "storeKeys", "listenerCalls", "tasks", "timers", "writes", "writeBytes", "commitTasks"];
const FAN_OUT = ["subNotified", "selectorCalls"];
const SCALARS = ["commits", "hostUpdates"];
const TOTALS = new Set([...COUNTERS, ...SCALARS, ...FAN_OUT, "firstCommitMounts", "nativeNodesLeft"]);

const add = (into, key, value) => {
  into[key] = (into[key] ?? 0) + value;
};

function flattenStats(into, prefix, stats) {
  if (!stats) return;
  for (const k of SCALARS) if (typeof stats[k] === "number") add(into, `${prefix}.${k}`, stats[k]);
  for (const k of COUNTERS) {
    const counter = stats[k];
    if (!counter) continue;
    let total = 0;
    for (const [name, value] of Object.entries(counter)) {
      if (isHarnessTimer(name)) continue;
      add(into, `${prefix}.${k}.${name}`, value);
      total += value;
    }
    add(into, `${prefix}.${k}`, total);
  }
  for (const k of FAN_OUT) {
    const counter = stats[k];
    if (counter) add(into, `${prefix}.${k}`, Object.values(counter).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0));
  }
}

export function flatten(result, prefix = "") {
  const out = {};
  const ran = new Set();
  const one = (scenario, stats) => {
    ran.add(prefix + scenario);
    flattenStats(out, prefix + scenario, stats);
  };
  for (const name of ["launch", "typing", "switchTabs", "scroll", "hover", "storeUpdate", "idle"]) if (result[name]?.stats) one(name, result[name].stats);
  if (result.launch?.firstCommitMounts) {
    let total = 0;
    for (const [name, value] of Object.entries(result.launch.firstCommitMounts)) {
      out[`${prefix}launch.firstCommitMounts.${name}`] = value;
      total += value;
    }
    out[`${prefix}launch.firstCommitMounts`] = total;
  }
  if (prefix) return { counts: out, ran };
  if (result.openClose) {
    ran.add("openClose");
    flattenStats(out, "open", result.openClose.openStats);
    flattenStats(out, "close", result.openClose.closeStats);
  }
  if (typeof result.nodeChurn?.left === "number") {
    ran.add("nodeChurn");
    out["nodeChurn.nativeNodesLeft"] = result.nodeChurn.left;
  }
  if (result.pageLoad?.runs) {
    ran.add("pageLoad");
    for (const run of result.pageLoad.runs) flattenStats(out, "pageLoad", run.stats);
  }
  if (result.profileSwipe?.runs) {
    ran.add("profileSwipe");
    for (const run of result.profileSwipe.runs) flattenStats(out, `profileSwipe.${run.command}`, run.stats);
  }
  return { counts: out, ran };
}

const scenarioOf = (key) => {
  const [head, second] = key.split(".");
  if (head === "small") return `small.${second}`;
  return head === "open" || head === "close" ? "openClose" : head;
};
const isTotal = (key) => {
  const parts = key.replace(/^small\./, "").split(".");
  return TOTALS.has(parts.at(-1)) && parts.length === (key.includes("profileSwipe.") ? 3 : 2);
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const seedOf = (key) => (key.startsWith("small.") ? "small" : "big");

function collect(reports) {
  const values = {};
  const ran = new Set();
  const runsBySeed = { big: 0, small: 0 };
  for (const seed of ["big", "small"]) {
    const group = reports.filter((r) => (r.seed ?? "big") === seed);
    if (!group.length) continue;
    const prefix = seed === "small" ? "small." : "";
    const flat = group.flatMap((r) => r.results.map((x) => flatten(x, prefix)));
    const sharedRan = new Set(flat[0]?.ran);
    for (const r of flat) for (const s of [...sharedRan]) if (!r.ran.has(s)) sharedRan.delete(s);
    for (const s of sharedRan) ran.add(s);
    for (const key of new Set(flat.flatMap((r) => Object.keys(r.counts)))) values[key] = flat.map((r) => r.counts[key] ?? 0);
    runsBySeed[seed] = flat.length;
  }
  return { values, runs: runsBySeed.big, runsBySeed, ran };
}

export function withRetry(first, retry) {
  const values = { ...first.values };
  const zeros = (c, key) => Array(c.runsBySeed[seedOf(key)]).fill(0);
  for (const key of new Set([...Object.keys(first.values), ...Object.keys(retry.values)])) {
    if (!retry.ran.has(scenarioOf(key)) || !first.ran.has(scenarioOf(key))) continue;
    values[key] = [...(first.values[key] ?? zeros(first, key)), ...(retry.values[key] ?? zeros(retry, key))];
  }
  return { ...first, values };
}

export function retryPlan(rows) {
  const failed = new Set(rows.filter((r) => r.kind === "over" && (r.tier === "exact" || r.tier === "noisy")).map((r) => scenarioOf(r.key)));
  const rerunnable = (s) => s !== "startup" && ![...WORST_RUN].some((key) => scenarioOf(key) === s);
  const last = JOURNEYS.findLastIndex((s) => rerunnable(s) && failed.has(s));
  const small = SMALL_JOURNEYS.some((s) => s !== "startup" && failed.has(`small.${s}`));
  return { big: last > 0 ? JOURNEYS.slice(0, last + 1) : null, small: small ? SMALL_JOURNEYS : null };
}

export function positiveInteger(value, name) {
  if (value === true) throw new Error(`${name} needs a value`);
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number, got ${value}`);
  return n;
}

export function splitRuns(runs, lanes) {
  const n = Math.max(1, Math.min(lanes, runs));
  return Array.from({ length: n }, (_, lane) => Math.floor(runs / n) + (lane < runs % n ? 1 : 0)).filter((count) => count > 0);
}

export const laneLabel = (name, seed) => (seed === "small" ? `${name}-small` : name);

const portOk = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535;

export function portPlan({ port, cdpPort, counts, serialRuns = 0 }) {
  let next = cdpPort;
  const plan = counts.map((capacity, lane) => ({ port: port + lane, cdpPort: (next += capacity) - capacity, capacity }));
  plan.serial = { port, cdpPort, capacity: serialRuns };
  const lastCdp = cdpPort + Math.max(next - cdpPort, serialRuns) - 1;
  const servers = plan.map((p) => p.port);
  const bad = [...servers, cdpPort, lastCdp].find((p) => !portOk(p));
  if (bad !== undefined) throw new Error(`port ${bad} is outside 1024..65535: pick another --port or --cdp-port`);
  const clash = servers.find((p) => p >= cdpPort && p <= lastCdp);
  if (clash !== undefined) throw new Error(`test-server port ${clash} falls in the remote-debugging ports ${cdpPort}..${lastCdp}: pick another --port or --cdp-port`);
  return plan;
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const lowerMedian = (xs) => sorted(xs)[(xs.length - 1) >> 1];
const WORST_RUN = new Set(["nodeChurn.nativeNodesLeft"]);
const judged = (key, xs) => (WORST_RUN.has(key) ? Math.max(...xs) : lowerMedian(xs));

function modeOf(xs) {
  const tally = new Map();
  for (const x of xs) tally.set(x, (tally.get(x) ?? 0) + 1);
  const [value, n] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { value, share: n / xs.length };
}

function readCeilings() {
  if (!existsSync(ceilingsFile)) throw new Error(`no ${ceilingsFile}: run \`ratchet.mjs init\` on js-bench reports of several runs`);
  return readJson(ceilingsFile);
}

function reportRevisions(reports) {
  const probe = new Set();
  let bench = "?";
  for (const r of reports) {
    for (const x of r.results) probe.add(x.probeRevision ?? "?");
    bench = r.benchRevision ?? "?";
  }
  return { probe: [...probe].join("+"), bench: String(bench) };
}

function judge(tier, ceilings, counts, ran) {
  const rows = [];
  for (const [key, ceiling] of Object.entries(ceilings)) {
    if (ran && !ran.has(scenarioOf(key))) continue;
    const value = counts[key] ?? 0;
    const limit = tier === "instr" ? Math.floor(ceiling * (1 + INSTR_TOLERANCE)) : tier === "exact" && !isTotal(key) ? ceiling + Math.max(NAMED_ROOM, Math.ceil(ceiling * 0.05)) : ceiling;
    rows.push({ tier, key, ceiling, value, kind: value > limit ? "over" : value < ceiling ? "under" : "same" });
  }
  return rows;
}

function table(rows) {
  const name = (r) => `${r.tier}: ${r.key}`;
  const w = Math.max(...rows.map((r) => name(r).length), 5);
  const line = (a, b, c, d) => `${a.padEnd(w)}  ${String(b).padStart(11)}  ${String(c).padStart(11)}  ${d}`;
  return [line("count", "ceiling", "now", ""), ...rows.map((r) => line(name(r), r.ceiling, r.value, `${r.value > r.ceiling ? "+" : ""}${r.value - r.ceiling}`))].join("\n");
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const multi = new Set(["micro", "retry"]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const name = argv[i].slice(2);
      const value = argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i];
      if (multi.has(name)) (flags[name] ??= []).push(value);
      else flags[name] = value;
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

export function evaluate(ceilings, { files = [], retryFiles = [], micro = null, instr = null }) {
  const rows = [];
  const notes = [];
  let ran = null;
  let counts = null;
  let runs = 0;
  if (files.length) {
    const reports = files.map(readJson);
    const rev = reportRevisions(reports);
    if (String(ceilings.revisions.probe) !== rev.probe || String(ceilings.revisions.bench) !== rev.bench)
      notes.push(`WARNING: ratchet.json is for probe revision ${ceilings.revisions.probe}, bench revision ${ceilings.revisions.bench}; this report has probe ${rev.probe}, bench ${rev.bench}. If a counter was redefined (not just added), the ceilings mean something else now: rebuild them with \`ratchet.mjs init\` on a fresh census.`);
    const c = retryFiles.length ? withRetry(collect(reports), collect(retryFiles.map(readJson))) : collect(reports);
    ran = c.ran;
    runs = c.runs;
    counts = Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, judged(k, v)]));
    rows.push(...judge("exact", ceilings.exact, counts, ran), ...judge("noisy", ceilings.noisy, counts, ran));
  }
  if (micro) rows.push(...judge("micro", ceilings.micro, micro, null));
  if (instr !== null) rows.push(...judge("instr", ceilings.instr, { "micro.instrPerRound": instr }, null));
  return { rows, notes, ran, counts, runs };
}

function printCheck({ rows, notes, ran, counts, runs }, ceilings, { quiet = false } = {}) {
  const lines = [...notes];
  const over = rows.filter((r) => r.kind === "over");
  const under = rows.filter((r) => r.kind === "under");
  const tiers = ["exact", "noisy", "micro", "instr"].map((t) => [t, rows.filter((r) => r.tier === t)]).filter(([, rs]) => rs.length);
  lines.push(`checked ${tiers.map(([t, rs]) => `${rs.length} ${t}`).join(", ")}${ran ? ` (${[...ran].join(", ")}; ${runs} run${runs === 1 ? "" : "s"})` : ""}: ${over.length} over, ${under.length} below their ceiling`);
  if (over.length) lines.push("", "OVER THE CEILING", table(over));
  if (under.length && !quiet) lines.push("", "below the ceiling (`ratchet.mjs lower` locks the exact ones in)", table(under.slice(0, 30)), under.length > 30 ? `… and ${under.length - 30} more` : "");
  if (counts && !quiet) {
    const known = new Set([...Object.keys(ceilings.exact), ...Object.keys(ceilings.noisy)]);
    const fresh = Object.entries(counts).filter(([k, v]) => !known.has(k) && v > 0 && ran.has(scenarioOf(k)) && !isTotal(k));
    const named = fresh.filter(([k]) => !/\.(storeKeys|listenerCalls)\./.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (named.length) lines.push("", `${fresh.length} counts have no ceiling (a new component, task or timer, or one that wobbles); the biggest:`, ...named.map(([k, v]) => `  ${k}  ${v}`));
  }
  const failed = over.length > 0;
  lines.push("", failed ? "ratchet: FAIL" : "ratchet: ok");
  console.log(lines.join("\n"));
  return !failed;
}

function check(files, micro, instr, retryFiles = []) {
  const ceilings = readCeilings();
  return printCheck(evaluate(ceilings, { files, retryFiles, micro, instr }), ceilings);
}

export const collectWithRetry = (files, retryFiles = []) => (retryFiles.length ? withRetry(collect(files.map(readJson)), collect(retryFiles.map(readJson))) : collect(files.map(readJson)));

const serialize = (c) => {
  const section = (o) => (Object.keys(o).length ? `{\n${Object.keys(o).sort().map((k) => `    ${JSON.stringify(k)}: ${o[k]}`).join(",\n")}\n  }` : "{}");
  return `{\n  "about": ${JSON.stringify(c.about)},\n  "baseline": ${JSON.stringify(c.baseline)},\n  "revisions": ${JSON.stringify(c.revisions)},\n  "exact": ${section(c.exact)},\n  "noisy": ${section(c.noisy)},\n  "micro": ${section(c.micro)},\n  "instr": ${section(c.instr)}\n}`;
};

function lower(files, micro, instr, retryFiles = []) {
  const ceilings = readCeilings();
  const diff = [];
  const set = (tier, key, ceiling, value) => {
    ceilings[tier][key] = value;
    diff.push({ tier, key, ceiling, value });
  };
  if (files.length) {
    const { values, ran } = collectWithRetry(files, retryFiles);
    for (const [key, ceiling] of Object.entries(ceilings.exact)) {
      if (!ran.has(scenarioOf(key))) continue;
      const worst = Math.max(...(values[key] ?? [0]));
      if (worst < ceiling) set("exact", key, ceiling, worst);
    }
  }
  if (micro) for (const [key, ceiling] of Object.entries(ceilings.micro)) if ((micro[key] ?? 0) < ceiling) set("micro", key, ceiling, micro[key] ?? 0);
  if (instr !== null) for (const [key, ceiling] of Object.entries(ceilings.instr)) if (instr < ceiling * (1 - INSTR_TOLERANCE)) set("instr", key, ceiling, instr);
  if (!diff.length) return console.log("nothing to lower");
  writeFileSync(ceilingsFile, `${serialize(ceilings)}\n`);
  console.log(table(diff));
  console.log(`\nlowered ${diff.length} ceilings in ${ceilingsFile}`);
}

export function ceilingsFrom(values) {
  const exact = {};
  const noisy = {};
  const dropped = [];
  for (const [key, v] of Object.entries(values)) {
    const max = Math.max(...v);
    if (max === 0 && !isTotal(key)) continue;
    const mode = modeOf(v);
    if (mode.share >= EXACT_SHARE) {
      if (mode.value > 0 || isTotal(key)) exact[key] = mode.value;
    } else if (isTotal(key) && (max - lowerMedian(v)) / max <= NOISY_SPREAD) noisy[key] = Math.ceil(max * (1 + NOISY_MARGIN));
    else if (isTotal(key)) dropped.push({ key, v });
  }
  return { exact, noisy, dropped };
}

function init(files, microRuns, instr, { adopt = false } = {}) {
  const reports = files.map(readJson);
  const { values, runs, ran } = collect(reports);
  if (runs < MIN_RUNS) throw new Error(`init needs at least ${MIN_RUNS} runs to tell a steady count from a wobbling one; got ${runs}`);
  const rev = reportRevisions(reports);
  const { exact, noisy, dropped } = ceilingsFrom(values);
  const micro = {};
  if (microRuns.length) {
    const runsM = microRuns;
    for (const key of Object.keys(runsM[0])) {
      const vs = runsM.map((r) => r[key]);
      if (new Set(vs).size === 1) micro[key] = vs[0];
      else dropped.push({ key: `micro:${key}`, v: vs });
    }
  }
  const commit = spawnSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const ceilings = {
    about: "Ceilings for apps/browser/scripts/perf/ratchet.mjs (policy in its header and docs/perf/README.md). Lower them with `ratchet.mjs lower`; raise one only by hand, with the reason in the commit.",
    baseline: { commit, runs, scenarios: [...ran].sort(), when: new Date().toISOString().slice(0, 10) },
    revisions: { probe: rev.probe, bench: rev.bench },
    exact,
    noisy,
    micro,
    instr: instr === null ? {} : { "micro.instrPerRound": instr },
  };
  if (adopt) return adoptCeilings(ceilings, dropped);
  writeFileSync(ceilingsFile, `${serialize(ceilings)}\n`);
  console.log(`wrote ${ceilingsFile}: ${Object.keys(exact).length} exact, ${Object.keys(noisy).length} noisy, ${Object.keys(micro).length} micro, ${Object.keys(ceilings.instr).length} instr, over ${runs} runs`);
  if (dropped.length) console.log(`not gated (totals whose median is more than ${NOISY_SPREAD * 100}% below their largest value):\n${dropped.map((d) => `  ${d.key}  [${d.v.join(", ")}]`).join("\n")}`);
}

function adoptCeilings(next, dropped) {
  const old = readCeilings();
  const merged = { ...next, exact: {}, noisy: {}, micro: {}, instr: {} };
  const report = { added: [], lowered: [], higher: [] };
  for (const tier of ["exact", "noisy", "micro", "instr"]) {
    for (const key of new Set([...Object.keys(old[tier]), ...Object.keys(next[tier])])) {
      const was = old[tier][key];
      const now = next[tier][key];
      if (was === undefined) {
        merged[tier][key] = now;
        report.added.push({ tier, key, ceiling: null, value: now });
      } else if (now === undefined || now >= was) {
        merged[tier][key] = was;
        if (now !== undefined && now > was) report.higher.push({ tier, key, ceiling: was, value: now });
      } else {
        merged[tier][key] = now;
        report.lowered.push({ tier, key, ceiling: was, value: now });
      }
    }
  }
  for (const key of Object.keys(merged.exact)) delete merged.noisy[key];
  writeFileSync(ceilingsFile, `${serialize(merged)}\n`);
  const counts = (tier, rows) => rows.filter((r) => r.tier === tier).length;
  console.log(`adopted into ${ceilingsFile}: ${report.added.length} added (${["exact", "noisy", "micro", "instr"].map((t) => `${counts(t, report.added)} ${t}`).join(", ")}), ${report.lowered.length} lowered, ${report.higher.length} kept above what the baseline measured`);
  if (report.lowered.length) console.log(`\nLOWERED\n${table(report.lowered)}`);
  if (report.higher.length) console.log(`\nHIGHER IN THE BASELINE (ceiling kept; a regression or a change to accept by hand)\n${table(report.higher.map((r) => ({ ...r })))}`);
}

function census(files) {
  const { values, runs, ran } = collect(files.map(readJson));
  console.log(`${runs} runs; scenarios ${[...ran].join(", ")}`);
  const rows = Object.entries(values).map(([key, v]) => ({ key, v, min: Math.min(...v), max: Math.max(...v), mode: modeOf(v) }));
  const steady = rows.filter((r) => r.mode.share >= EXACT_SHARE && r.max > 0);
  const wobbly = rows.filter((r) => r.mode.share < EXACT_SHARE);
  const identical = steady.filter((r) => r.min === r.max).length;
  console.log(`${steady.length} steady counts (${identical} identical in every run), ${wobbly.length} wobbling\n`);
  const line = (r) => `  ${r.key.padEnd(58)} ${String(r.min).padStart(9)} – ${String(r.max).padEnd(9)} [${r.v.join(", ")}]`;
  console.log("GROUP TOTALS");
  for (const r of rows.filter((r) => isTotal(r.key)).sort((a, b) => a.key.localeCompare(b.key))) console.log(`${line(r)}${r.mode.share >= EXACT_SHARE ? "" : "   wobbles"}`);
  console.log("\nWOBBLING NAMED COUNTS");
  for (const r of wobbly.filter((r) => !isTotal(r.key)).sort((a, b) => a.key.localeCompare(b.key))) console.log(line(r));
}

const children = new Map();
const LANE_STOP_DEADLINE_MS = 20_000;

export function spawnAsync(cmd, args, { cwd, env, capture = false, captureErr = false, lane = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", capture ? "pipe" : "ignore", captureErr ? "pipe" : "inherit"] });
    const closed = new Promise((done) => child.once("close", done));
    children.set(child, { closed, lane });
    let out = "";
    let err = "";
    if (capture) child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    if (captureErr) child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      if (code === 0) resolve(captureErr ? { out, err } : out);
      else reject(new Error(`${basename(args[0] ?? cmd)} ${args.slice(1, 3).join(" ")} exited with ${code ?? signal}`));
    });
  });
}

const killGroup = (child) => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
};

let stopping = false;

export function finish(code) {
  if (!stopping) process.exit(code);
}

export function stopOnSignals({ deadlineMs = LANE_STOP_DEADLINE_MS } = {}) {
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]])
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      const lanes = [...children].filter(([, c]) => c.lane);
      for (const [child, c] of children) if (!c.lane) killGroup(child);
      for (const [child] of lanes) child.kill(sig);
      let timer;
      await Promise.race([Promise.all(lanes.map(([, c]) => c.closed)), new Promise((r) => (timer = setTimeout(r, deadlineMs)))]);
      clearTimeout(timer);
      for (const [child] of lanes) if (children.has(child)) killGroup(child);
      process.exit(code);
    });
}

export async function allFinished(tasks) {
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => s.value);
}

function newestApp() {
  const dist = join(repo, "dist");
  const versions = readdirSync(dist)
    .filter((d) => /^\d+\.\d+\.\d+(-rc)?$/.test(d))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const app = join(dist, v, "export/Ardia.app");
    if (existsSync(app)) return app;
  }
  throw new Error("no dist/<version>/export/Ardia.app: pass --app");
}

async function jsSetup(flags, out, mark, { counts, serialRuns = 0 }) {
  const app = flags.app ? resolve(flags.app) : newestApp();
  let jsbundle = flags.bundle ? resolve(flags.bundle) : join(app, "Contents/Resources/main.jsbundle");
  if (!flags.own && !flags.bundle) {
    const bundle = join(out, "bundle");
    mark("bundling the tree");
    await spawnAsync(process.execPath, [join(here, "js-bench.mjs"), "bundle", bundle]);
    jsbundle = join(bundle, "main.jsbundle");
  }
  const libs = [flags.lib ? resolve(flags.lib) : join(here, "bench-app.js"), join(here, "ratchet-app.js")].join(",");
  const label = flags.label ?? "ratchet";
  const ports = portPlan({ port: Number(flags.port ?? DEFAULT_PORT), cdpPort: Number(flags["cdp-port"] ?? DEFAULT_CDP_PORT), counts, serialRuns });
  const lane = ({ seed = "big", runs = 1, scenarios = seed === "small" ? SMALL_JOURNEYS : JOURNEYS, name = label, slot = 0 }) => {
    const labelled = laneLabel(name, seed);
    const { port, cdpPort, capacity } = slot === "serial" ? ports.serial : ports[slot];
    if (runs > capacity) throw new Error(`lane ${slot} has ${runs} runs, more than the ${capacity} remote-debugging ports it was given`);
    const args = [join(here, "js-bench.mjs"), "run", "--app", app, "--bundle", jsbundle, "--label", labelled, "--runs", String(runs), "--port", String(port), "--cdp-port", String(cdpPort), "--out", out, "--scenarios", scenarios.join(","), "--options", OPTIONS];
    args.push(...(seed === "small" ? ["--seed", "small"] : ["--probe", "selectors"]), "--lib", libs);
    return { report: join(out, `${labelled}.json`), run: () => spawnAsync(process.execPath, args, { lane: true }) };
  };
  return { app, lane };
}

async function run(flags) {
  const started = Date.now();
  const out = resolve(flags.out ?? join(process.env.TMPDIR ?? "/tmp", "ac-ratchet"));
  mkdirSync(out, { recursive: true });
  const mark = (what) => console.error(`[ratchet +${((Date.now() - started) / 1000).toFixed(0)}s] ${what}`);
  const ceilings = readCeilings();
  const setup = flags["skip-js"] ? null : await jsSetup(flags, out, mark, { counts: [1, 1] });
  const big = setup?.lane({ seed: "big", slot: 0 });
  const small = setup?.lane({ seed: "small", slot: 1 });
  if (setup) mark(`running ${JOURNEYS.join(",")} and the one-tab launch side by side on ${setup.app}`);
  if (!flags["skip-micro"]) mark("counting the Node hot paths alongside");
  const [, , micro] = await allFinished([big?.run(), small?.run(), flags["skip-micro"] ? null : microCountsAsync()]);
  const instr = !flags["skip-micro"] && flags.instr ? Math.max(await instrPerRound(), await instrPerRound()) : null;
  mark("checking");
  const files = setup ? [big.report, small.report] : [];
  const microFile = micro ? join(out, `${flags.label ?? "ratchet"}-micro.json`) : null;
  if (microFile) writeFileSync(microFile, `${JSON.stringify(micro)}\n`);
  let retryFiles = [];
  let result = evaluate(ceilings, { files, micro, instr });
  const again = setup ? retryPlan(result.rows) : { big: null, small: null };
  if (again.big || again.small) {
    mark(`some counts are over: running ${[again.big && `the journeys up to ${again.big.at(-1)}`, again.small && "the one-tab launch"].filter(Boolean).join(" and ")} once more (only a count over in both runs fails)`);
    const name = `${flags.label ?? "ratchet"}-again`;
    const retry = [
      again.big && setup.lane({ seed: "big", scenarios: again.big, name, slot: 0 }),
      again.small && setup.lane({ seed: "small", scenarios: again.small, name, slot: 1 }),
    ].filter(Boolean);
    await allFinished(retry.map((l) => l.run()));
    retryFiles = retry.map((l) => l.report);
    result = evaluate(ceilings, { files, retryFiles, micro, instr });
  }
  console.error(`[ratchet] the same verdict from the saved reports: node ${shellQuote(join(here, "ratchet.mjs"))} check ${replayArgs({ files, retryFiles, microFile, instr }).map(shellQuote).join(" ")}`);
  const ok = printCheck(result, ceilings, { quiet: true });
  console.error(`[ratchet] ${((Date.now() - started) / 1000).toFixed(0)}s`);
  finish(ok ? 0 : 1);
}

async function baseline(flags) {
  const started = Date.now();
  const out = resolve(flags.out ?? join(process.env.TMPDIR ?? "/tmp", "ac-ratchet-baseline"));
  mkdirSync(out, { recursive: true });
  const mark = (what) => console.error(`[ratchet baseline +${((Date.now() - started) / 1000).toFixed(0)}s] ${what}`);
  const runs = positiveInteger(flags.runs ?? 8, "--runs");
  const split = splitRuns(runs, positiveInteger(flags.lanes ?? BASELINE_LANES, "--lanes"));
  const setup = await jsSetup(flags, out, mark, { counts: split, serialRuns: runs });
  const name = flags.label ?? "ratchet";
  const lanes = split.map((count, slot) => setup.lane({ seed: "big", runs: count, name: `${name}-${slot}`, slot }));
  const small = setup.lane({ seed: "small", runs, name, slot: "serial" });
  mark(`running ${JOURNEYS.join(",")} ${runs} times on ${setup.app}, ${lanes.length} instances at once`);
  const counting = flags["measure-only"] ? null : allFinished([microCountsAsync(), microCountsAsync()]);
  await allFinished([...lanes.map((l) => l.run()), counting]);
  mark(`running the one-tab launch ${runs} times, one at a time`);
  await small.run();
  const reports = [...lanes.map((l) => l.report), small.report];
  if (flags["measure-only"]) return console.log(reports.join(" "));
  mark("counting instructions");
  init(reports, await counting, Math.max(await instrPerRound(), await instrPerRound(), await instrPerRound()));
}

const MICRO_ARGS = ["--no-warnings", "--import", "./src/test-loader.mjs", "scripts/perf/micro-bench.mjs", "counts"];

function parseMicro(text) {
  const line = text.split("\n").find((l) => l.startsWith("COUNTS "));
  if (!line) throw new Error("micro-bench counts printed no COUNTS line");
  return JSON.parse(line.slice("COUNTS ".length));
}

const microCountsAsync = () => spawnAsync(process.execPath, MICRO_ARGS, { cwd: appDir, capture: true }).then(parseMicro);

const INSTR_ARGS = ["-l", process.execPath, "--no-warnings", "--predictable", "--import", "./src/test-loader.mjs", "scripts/perf/micro-bench.mjs", "instr"];

function retiredFrom(stderr) {
  const m = /(\d+)\s+instructions retired/.exec(stderr);
  if (!m) throw new Error(`/usr/bin/time -l printed no "instructions retired": ${stderr.slice(-300)}`);
  return Number(m[1]);
}

export async function instrPerRound(rounds = 10) {
  const retired = async (n) => retiredFrom((await spawnAsync("/usr/bin/time", INSTR_ARGS, { cwd: appDir, env: { ...process.env, INSTR_ROUNDS: String(n) }, captureErr: true })).err);
  return Math.round(((await retired(rounds)) - (await retired(0))) / rounds);
}

export const shellQuote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, "'\\''")}'`);

export function replayArgs({ files, retryFiles = [], microFile = null, instr = null }) {
  return [...files, ...retryFiles.flatMap((f) => ["--retry", f]), ...(microFile ? ["--micro", microFile] : []), ...(instr !== null ? ["--instr", String(instr)] : [])];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  try {
    const micro = command !== "init" && flags.micro?.length ? readJson(flags.micro[0]) : null;
    if (command !== "run" && flags.instr === true) throw new Error("--instr needs a value outside run");
    const instr = flags.instr !== undefined && command !== "run" ? Number(flags.instr) : null;
    if (command === "run" || command === "baseline" || command === "init") stopOnSignals();
    if (command === "run") await run(flags);
    else if (command === "baseline") await baseline(flags);
    else if (command === "check") process.exit(check(positional, micro, instr, flags.retry ?? []) ? 0 : 1);
    else if (command === "lower") lower(positional, micro, instr, flags.retry ?? []);
    else if (command === "init") {
      const microRuns = flags.micro ? flags.micro.map(readJson) : await allFinished([microCountsAsync(), microCountsAsync()]);
      init(positional, microRuns, flags["no-instr"] ? null : Math.max(await instrPerRound(), await instrPerRound(), await instrPerRound()), { adopt: !!flags.adopt });
    }
    else if (command === "census") census(positional);
    else {
      console.error("usage: ratchet.mjs run | baseline | check <report.json…> [--retry <report.json>]… | lower <report.json…> [--retry <report.json>]… | init <report.json…> | census <report.json…>  (see the header)");
      process.exit(64);
    }
  } catch (error) {
    if (!stopping) {
      console.error(String(error?.message ?? error));
      process.exit(2);
    }
  }
}
