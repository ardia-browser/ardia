#!/usr/bin/env node
// The release perf gate's verdict over interleaved native-bench rounds, read pooled (docs/perf/README.md › Gating a
// release). Each round is one `native-bench --control` run; its out dir holds <label>/results.json for both sides.
//
//   node apps/browser/scripts/perf/gate-verdict.mjs --control <label> --candidate <label> <round dir> [<round dir> …]
//     --launch-runs <n>  launches each side must have per round (default 6)
//     --runs <n>         session runs and windows runs each side must have per round (default 2)
//     --json <file>      also write the verdict as JSON
//
// A row fails when the pooled ranges separate (the candidate's best run is worse than the control's worst), or when the
// candidate is worse in every round (two rounds at least) and its pooled median is worse by more than the control's own
// round-to-round spread of medians. One round can only fail on separated ranges, so a stable gate runs two. The judged
// rows are the ones those gates' pooled tables judged; memory is printed beside them, not judged, as it was then.
// A round is invalid, and nothing is scored, when it isn't complete: each side needs the launch, session and windows
// phases, --launch-runs launches and --runs session and windows runs, every one with all its samples (16 switches,
// 5 new tabs, 3 + 8 new windows, both idle windows), none left out, and every round the same two apps.
// Exit 0: every gate row passes; 1: a row fails; 2: a round is invalid; 64: usage.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { median } from "./median.mjs";
import { summary } from "./native-summary.mjs";

export const GATE_ROWS = [
  ["launch → window shown", "launch → window shown"],
  ["launch → with content", "launch → window shown with its content"],
  ["launch → JS running", "launch → JS running"],
  ["launch → first page painted", "launch → first page painted"],
  ["launch → first frame", "launch → first page's first frame"],
  ["new tab → first paint", "new tab → first paint (median of 5 per run)"],
  ["new tab → first frame", "new tab → its page's first frame (median of 5 per run)"],
  ["tab switch → shown", "tab switch → shown (median of 16 per run)"],
  ["new window → on screen", "new window → on screen (median per run)"],
  ["new window → first paint", "new window → first paint (median per run)"],
  ["new window → first frame", "new window → its page's first frame (median per run)"],
  ...[1, 20].flatMap((n) => [
    [`idle CPU ${n} tab, all`, `idle CPU, ${n} tab(s) (all processes)`],
    [`idle CPU ${n} tab, browser`, `idle CPU, ${n} tab(s) (browser process)`],
    [`idle wakeups ${n} tab, all`, `idle wakeups/s, ${n} tab(s) (all processes)`],
    [`idle wakeups ${n} tab, browser`, `idle wakeups/s, ${n} tab(s) (browser process)`],
  ]),
];

const REPORTED_ROWS = [
  "memory (phys_footprint), 1 tab(s)", "memory (phys_footprint), 10 tab(s)", "memory (phys_footprint), 20 tab(s)",
  "memory (phys_footprint), after closing back to 1 tab", "memory, browser process, 20 tabs", "memory, browser process, after closing",
];

function reportedRows(rounds) {
  const pooled = (side, name) => rounds.flatMap((r) => byName(r[side]).get(name)?.values ?? []);
  return REPORTED_ROWS.map((name) => ({ name, control: median(pooled("control", name)), candidate: median(pooled("candidate", name)) }));
}

const finite = (...xs) => xs.every(Number.isFinite);
const WINDOW_FIELDS = (w) => finite(w?.window, w?.firstPaint, w?.firstFrame);
const IDLE_FIELDS = (i) => finite(i?.total?.cpu, i?.total?.wakeups, i?.kinds?.browser?.cpu, i?.kinds?.browser?.wakeups);

export const SESSION_PARTS = ["idle", "memory", "switch", "newtab", "newwindow"];

export function roundProblems(results, { launchRuns = 6, runs = 2 } = {}) {
  const problems = [];
  if (!results || typeof results !== "object" || Array.isArray(results)) return ["its results aren't an object"];
  const list = (name) => {
    const xs = results[name];
    if (xs === undefined) return [];
    if (!Array.isArray(xs)) {
      problems.push(`its ${name} isn't a list`);
      return [];
    }
    const bad = xs.filter((x) => !x || typeof x !== "object" || Array.isArray(x)).length;
    if (bad) problems.push(`${bad} of its ${name} entries aren't runs`);
    return xs.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {}));
  };
  const only = Array.isArray(results.meta?.only) ? results.meta.only : [];
  for (const phase of ["launch", "windows"]) if (!only.includes(phase)) problems.push(`it didn't run the ${phase} phase`);
  if (!only.includes("session") && !SESSION_PARTS.every((p) => only.includes(p))) problems.push("it didn't run the session phase (or all five of its parts)");
  const launch = list("launch"), session = list("session"), windows = list("windows");
  if (session.some((r) => r.parts)) problems.push("its session runs measured only some parts");
  const source = results?.meta?.source;
  const missing = ["version", "build", "cdhash"].filter((k) => typeof source?.[k] !== "string" || !source[k]);
  if (missing.length) problems.push(`its build identity has no ${missing.join(", ")} to compare rounds by`);
  if (typeof results.meta?.bundleSha !== "string" || !results.meta.bundleSha) problems.push("it has no bench bundle hash to compare rounds by");
  const count = (what, have, want) => have !== want && problems.push(`${have} ${what}, wanted ${want}`);
  count("launches", launch.length, launchRuns);
  launch.forEach((l, i) => !finite(l?.window, l?.withContent, l?.js, l?.firstPaint, l?.firstFrame) && problems.push(`launch ${i} is missing a time`));
  count("session runs", session.length, runs);
  session.forEach((r, i) => {
    const short = (name, xs, want, ok = Number.isFinite) => {
      const good = Array.isArray(xs) ? xs.filter(ok).length : 0;
      if (good !== want) problems.push(`session ${i}: ${good} of ${want} ${name}`);
    };
    short("tab switches", r.tabSwitch, 16);
    short("new tabs painted", r.newTab, 5);
    short("new tabs' first frames", r.newTabFrame, 5);
    short("new windows", r.newWindow, 3, WINDOW_FIELDS);
    for (const t of ["tabs1", "tabs20"]) if (!IDLE_FIELDS(r?.idle?.[t])) problems.push(`session ${i}: no ${t} idle window`);
    for (const m of ["tabs1", "tabs10", "tabs20", "closed"]) if (!finite(r?.memory?.[m]?.totalMB, r?.memory?.[m]?.kinds?.browser)) problems.push(`session ${i}: no ${m} memory reading`);
    const left = (r?.throttled?.tabSwitch ?? 0) + (r?.throttled?.newTab ?? 0);
    if (left) problems.push(`session ${i}: ${left} samples left out because a page couldn't paint (screen locked or display asleep)`);
  });
  count("windows runs", windows.length, runs);
  windows.forEach((r, i) => {
    const good = Array.isArray(r?.newWindow) ? r.newWindow.filter(WINDOW_FIELDS).length : 0;
    if (good !== 8) problems.push(`windows ${i}: ${good} of 8 new windows`);
  });
  return problems;
}

export function roundsProblems(rounds, expected) {
  const problems = [];
  rounds.forEach((round, i) => {
    for (const side of ["control", "candidate"]) for (const p of roundProblems(round[side], expected)) problems.push(`round ${i + 1}, ${side}: ${p}`);
  });
  for (const side of ["control", "candidate"]) {
    const apps = new Set(rounds.map((r) => r[side]?.meta?.preparedFrom?.app ?? r[side]?.meta?.app));
    if (apps.size > 1) problems.push(`the ${side}'s app differs between rounds (${[...apps].join(", ")})`);
    const builds = new Set(rounds.map((r) => { const s = r[side]?.meta?.source; return s ? `${s.version} (${s.build}) ${s.cdhash}` : "unknown"; }));
    if (builds.size > 1) problems.push(`the ${side}'s build differs between rounds (${[...builds].join(", ")})`);
    const bundles = new Set(rounds.map((r) => r[side]?.meta?.bundleSha ?? "unknown"));
    if (bundles.size > 1) problems.push(`the ${side}'s bench bundle differs between rounds (${[...bundles].map((b) => b.slice(0, 12)).join(", ")})`);
  }
  return problems;
}

const VALIDITY_ROWS = ["samples left out: page couldn't paint (switch + new tab, per run)"];

const byName = (rows) => new Map(rows.map((r) => [r.name, r]));

export function rowVerdict(rounds) {
  const control = rounds.flatMap((r) => r.control.values);
  const candidate = rounds.flatMap((r) => r.candidate.values);
  const deltas = rounds.map((r) => median(r.candidate.values) - median(r.control.values));
  const controlMedians = rounds.map((r) => median(r.control.values));
  const spread = Math.max(...controlMedians) - Math.min(...controlMedians);
  const delta = median(candidate) - median(control);
  const separate = Math.min(...candidate) > Math.max(...control);
  const worseEveryRound = rounds.length >= 2 && deltas.every((d) => d > 0);
  const fail = separate || (worseEveryRound && delta > spread);
  const why = separate ? "ranges separate" : worseEveryRound ? (delta > spread ? `worse ×${rounds.length}, Δ > spread` : `worse ×${rounds.length} but Δ ≤ spread`) : "";
  const stat = (xs) => ({ min: Math.min(...xs), median: median(xs), max: Math.max(...xs), n: xs.length });
  return { control: stat(control), candidate: stat(candidate), delta, deltas, spread, separate, worseEveryRound, fail, why };
}

export function gateVerdict(rounds) {
  const problems = [];
  const rows = GATE_ROWS.map(([label, name]) => {
    const perRound = rounds.map((round, i) => {
      const c = byName(round.control).get(name), k = byName(round.candidate).get(name);
      if (!c?.values?.length || !k?.values?.length) problems.push(`round ${i + 1}: no samples for "${name}"`);
      return { control: c ?? { values: [] }, candidate: k ?? { values: [] } };
    });
    if (perRound.some((r) => !r.control.values.length || !r.candidate.values.length)) return { label, name, missing: true, fail: false };
    return { label, name, ...rowVerdict(perRound) };
  });
  rounds.forEach((round, i) => {
    for (const side of ["control", "candidate"])
      for (const name of VALIDITY_ROWS) {
        const left = (byName(round[side]).get(name)?.values ?? []).reduce((a, b) => a + b, 0);
        if (left > 0) problems.push(`round ${i + 1}, ${side}: ${left} samples left out because a page couldn't paint (screen locked or display asleep): rerun that round`);
      }
  });
  return { rounds: rounds.length, rows, reported: reportedRows(rounds), problems, fails: rows.filter((r) => r.fail).map((r) => r.label) };
}

const fmt = (x) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));
const signed = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${fmt(Math.abs(x))}`;

function verdictTable(v, names) {
  const lines = [`| row | ${names[0]} pooled min / med / max (n) | ${names[1]} pooled min / med / max (n) | Δ med | per-round Δ med | ${names[0]} round spread | verdict |`, "|---|---|---|---|---|---|---|"];
  for (const r of v.rows) {
    if (r.missing) {
      lines.push(`| ${r.label} | — | — | — | — | — | missing |`);
      continue;
    }
    const s = (x) => `${fmt(x.min)} / ${fmt(x.median)} / ${fmt(x.max)} (${x.n})`;
    lines.push(`| ${r.label} | ${s(r.control)} | ${s(r.candidate)} | ${signed(r.delta)} | ${r.deltas.map(signed).join(" ")} | ${fmt(r.spread)} | ${r.fail ? "FAIL" : "pass"}${r.why ? ` (${r.why})` : ""} |`);
  }
  if (v.reported?.length) {
    lines.push("", `Reported, not judged (the 0.2.47 and 0.2.48 gates judged the rows above only): pooled medians, ${names[0]} → ${names[1]}`, "");
    for (const r of v.reported) lines.push(`- ${r.name}: ${fmt(r.control)} → ${fmt(r.candidate)} MB`);
  }
  return lines.join("\n");
}

function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { control: { type: "string" }, candidate: { type: "string" }, json: { type: "string" },
    "launch-runs": { type: "string", default: "6" }, runs: { type: "string", default: "2" }, help: { type: "boolean", short: "h" } } });
  if (opt.help || !opt.control || !opt.candidate || !positionals.length) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opt.help ? 0 : 64);
  }
  const read = (dir, label) => {
    try {
      return JSON.parse(readFileSync(join(dir, label, "results.json"), "utf8"));
    } catch (error) {
      return { error: `${join(dir, label, "results.json")}: ${error.code ?? error.message}` };
    }
  };
  const raw = positionals.map((dir) => ({ control: read(dir, opt.control), candidate: read(dir, opt.candidate) }));
  const unreadable = raw.flatMap((r) => [r.control?.error, r.candidate?.error].filter(Boolean));
  if (unreadable.length) {
    for (const e of unreadable) console.log(`invalid: ${e}`);
    console.log("gate: INVALID");
    process.exit(2);
  }
  let incomplete;
  try {
    incomplete = roundsProblems(raw, { launchRuns: +opt["launch-runs"], runs: +opt.runs });
  } catch (error) {
    incomplete = [`a round's results can't be checked (${error.message})`];
  }
  if (incomplete.length) {
    for (const p of incomplete) console.log(`invalid: ${p}`);
    console.log("gate: INVALID");
    process.exit(2);
  }
  let summarised;
  try {
    summarised = raw.map((r) => ({ control: summary(r.control), candidate: summary(r.candidate) }));
  } catch (error) {
    console.log(`invalid: a round's results can't be read as native-bench results (${error.message})`);
    console.log("gate: INVALID");
    process.exit(2);
  }
  const v = gateVerdict(summarised);
  console.log(verdictTable(v, [opt.control, opt.candidate]));
  for (const p of v.problems) console.log(`invalid: ${p}`);
  console.log(v.problems.length ? "gate: INVALID" : v.fails.length ? `gate: FAIL (${v.fails.join(", ")})` : `gate: pass (${v.rounds} round${v.rounds > 1 ? "s" : ""})`);
  if (opt.json) writeFileSync(opt.json, JSON.stringify(v, null, 1));
  process.exit(v.problems.length ? 2 : v.fails.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
