#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `Parity gate: reads a shootout's bench.json and judges the WebUI against React Native.

  node scripts/mac/webui-bench/gate.mjs <bench.json> [--baseline <older bench.json>] [--rules <rules.json>]
      [--regression 10] [--allow-missing] [--allow-fallback-clock] [--markdown <out.md>] [--json]

Integrity comes first and always applies: every planned rep on both sides finished with no errors, both sides restored
the same seeded fixture (profiles, tabs, windows), the multi-window runs reached 2 windows with a Peek open, every swipe
reached the other profile, every WebUI blocked swipe recorded a pager moving → rest interval that overlaps its block,
no New Tab poll failed, and both sides timed launch with the same clock (the app's commit mark or the
on-screen-window fallback; --allow-fallback-clock accepts a mix). A --baseline must pass the same integrity checks,
else the gate exits 64. A rule compared against RN needs an RN value, unless the WebUI meets both the rule's budget
and its cap on its own.

Each rule reads one metric's median (or p95) on both sides. The WebUI passes a rule when its value is at most
RN x ratio + tolerance, or at most the rule's budget (a value that is fine whatever RN does), and never above the
rule's cap. Rules with no RN side (vsRn false) only check budget and cap. With --baseline, a WebUI value more than
--regression percent (default 10) above the baseline's WebUI value is a regression and fails; against a baseline of 0,
any value above 0 is. A metric missing on a side the rule needs, or in the baseline, fails, unless --allow-missing makes
it a skip. Prints a Markdown table; exits 0 on PASS, 1 on FAIL, 64 on bad input (unreadable or non-object JSON, a
report without meta, runs and summary, an empty or malformed rule list).`;

export const RULES = [
  { key: "launch.large", label: "Cold launch, open → first window (ms)", vsRn: true, tolerance: 150, cap: 1500 },
  { key: "memory.small.footprintMb", label: "Memory 3 × 1 tab, phys_footprint (MB)", vsRn: true },
  { key: "memory.small.rssMb", label: "Memory 3 × 1 tab, RSS (MB)", vsRn: true },
  { key: "memory.large.footprintMb", label: "Memory 150 + 15 + 5 tabs, phys_footprint (MB)", vsRn: true },
  { key: "memory.large.rssMb", label: "Memory 150 + 15 + 5 tabs, RSS (MB)", vsRn: true },
  { key: "memory.multi.footprintMb", label: "Memory 2 windows + peek, phys_footprint (MB)", vsRn: true },
  { key: "memory.multi.rssMb", label: "Memory 2 windows + peek, RSS (MB)", vsRn: true },
  { key: "swipe.fwd.p95GapMs", label: "Swipe Personal → Work, frame gap p95 (ms)", vsRn: true },
  { key: "swipe.back.p95GapMs", label: "Swipe Work → Personal, frame gap p95 (ms)", vsRn: true },
  { key: "swipe.fwd.restMs", label: "Swipe Personal → Work, motion → rest (ms)", vsRn: true, tolerance: 100, budget: 500 },
  { key: "swipe.back.restMs", label: "Swipe Work → Personal, motion → rest (ms)", vsRn: true, tolerance: 100, budget: 500 },
  { key: "swipe.back.rowsPaintedMs", label: "Deep selected row arrival after rest (ms)", vsRn: true, budget: 16 },
  { key: "swipe.blocked.maxGapMs", label: "Swipe with a 500 ms UI-thread block, max gap (ms)", vsRn: false, cap: 150 },
  { key: "swipe.blankFrames", label: "Blank sidebar frames during swipes", vsRn: false, cap: 0, stat: "max" },
  { key: "launch.newTabFrames", label: "Lingering New Tab polls after first window", vsRn: false, cap: 0, stat: "max" },
  { key: "scroll.p95GapMs", label: "Sidebar scroll, 150 tabs, frame gap p95 (ms)", vsRn: true, tolerance: 4 },
  { key: "scroll.maxGapMs", label: "Sidebar scroll, 150 tabs, frame gap max (ms)", vsRn: true, tolerance: 17 },
  { key: "typing.p95Ms", label: "Command bar keystroke → frame p95 (ms)", vsRn: true, tolerance: 8, cap: 100 },
  { key: "typing.missed", label: "Keystrokes with no frame within 250 ms", vsRn: false, cap: 0, stat: "max" },
  { key: "drag.p95GapMs", label: "Divider drag, frame gap p95 (ms)", vsRn: true, tolerance: 4 },
  { key: "drag.maxGapMs", label: "Divider drag, frame gap max (ms)", vsRn: true, tolerance: 17 },
  { key: "drag.late120", label: "Divider drag, frames late at 120 Hz", vsRn: true, tolerance: 2 },
  { key: "peek.open.p95GapMs", label: "Peek open, frame gap p95 (ms)", vsRn: true, tolerance: 4 },
  { key: "peek.open.maxGapMs", label: "Peek open, frame gap max (ms)", vsRn: true, tolerance: 17 },
  { key: "peek.open.late120", label: "Peek open, frames late at 120 Hz", vsRn: true, tolerance: 2 },
  { key: "peek.dismiss.p95GapMs", label: "Peek dismiss, frame gap p95 (ms)", vsRn: true, tolerance: 4 },
  { key: "peek.dismiss.maxGapMs", label: "Peek dismiss, frame gap max (ms)", vsRn: true, tolerance: 17 },
  { key: "peek.dismiss.late120", label: "Peek dismiss, frames late at 120 Hz", vsRn: true, tolerance: 2 },
];

const fmt = (v) => (v == null ? "—" : typeof v === "string" ? v : Number.isInteger(v) ? String(v) : v.toFixed(1));

export function valueOf(report, side, key, stat = "median") {
  const entry = report?.summary?.[side]?.[key];
  if (entry == null) return null;
  if (typeof entry === "number") return entry;
  const v = entry[stat];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function limitFor(rule, rn) {
  const parts = [];
  if (rule.vsRn && rn != null) parts.push(rn * (rule.ratio ?? 1) + (rule.tolerance ?? 0));
  if (rule.budget != null) parts.push(rule.budget);
  let limit = parts.length ? Math.max(...parts) : null;
  if (rule.cap != null) limit = limit == null ? rule.cap : Math.min(limit, rule.cap);
  return limit;
}

export function regressed(current, before, pct) {
  if (before === 0) return current > 0;
  return current - before > (Math.abs(before) * pct) / 100 + Number.EPSILON * Math.max(1, Math.abs(before), Math.abs(current));
}

export function judge(rule, report, { baseline = null, regressionPct = 10, allowMissing = false } = {}) {
  const stat = rule.stat ?? "median";
  const rn = valueOf(report, "rn", rule.key, stat);
  const webui = valueOf(report, "webui", rule.key, stat);
  const before = baseline ? valueOf(baseline, "webui", rule.key, stat) : null;
  const limit = limitFor(rule, rn);
  const row = { key: rule.key, label: rule.label, stat, rn, webui, limit, baseline: before, verdict: "PASS", why: "" };
  const standsAlone = rule.budget != null && rule.cap != null && webui != null && webui <= rule.budget && webui <= rule.cap;
  const missing = webui == null ? "WebUI value missing" : rule.vsRn && rn == null && !standsAlone ? "RN value missing" : null;
  if (missing) return { ...row, verdict: allowMissing ? "SKIP" : "FAIL", why: missing };
  if (limit != null && webui > limit) return { ...row, verdict: "FAIL", why: `${fmt(webui)} > ${fmt(limit)}` };
  if (baseline && before == null) return { ...row, verdict: allowMissing ? "SKIP" : "FAIL", why: "baseline value missing" };
  if (before != null && regressed(webui, before, regressionPct))
    return { ...row, verdict: "REGRESSION", why: before === 0 ? `${fmt(webui)} vs baseline 0` : `+${fmt(((webui - before) / Math.abs(before)) * 100)} % vs baseline ${fmt(before)}` };
  return row;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const MAX_REPS = 10000;
export const LAUNCH_CLOCKS = ["commitMark", "fallback"];
export const validReps = (reps) => Number.isSafeInteger(reps) && reps >= 1 && reps <= MAX_REPS;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export const validFixture = (f) => isObject(f) && isCount(f.profiles) && isCount(f.tabs) && isCount(f.windows);

export function fixtureProblem(fixture, { completed = false } = {}) {
  if (fixture == null) return completed ? "is completed but has no fixture" : null;
  if (!isObject(fixture)) return "fixture is not an object";
  for (const side of ["expected", "restored"]) {
    if (fixture[side] == null && !completed) continue;
    if (!validFixture(fixture[side])) return `fixture.${side} needs integer profiles, tabs and windows ≥ 0`;
  }
  return null;
}

export function validateReport(report, name = "report") {
  if (!isObject(report)) return [`${name} is not a JSON object`];
  const problems = [];
  if (!isObject(report.meta)) problems.push(`${name} has no meta object`);
  else {
    if (!validReps(report.meta.reps)) problems.push(`${name} meta.reps is not an integer 1..${MAX_REPS}`);
    if (!Array.isArray(report.meta.phases) || !report.meta.phases.length) problems.push(`${name} meta.phases is not a list`);
    if (!Array.isArray(report.meta.measures)) problems.push(`${name} meta.measures is not a list`);
  }
  if (!Array.isArray(report.runs)) problems.push(`${name} has no runs list`);
  else
    report.runs.forEach((r, i) => {
      if (!isObject(r)) problems.push(`${name} runs[${i}] is not an object`);
      else {
        if (!["rn", "webui"].includes(r.side) || typeof r.phase !== "string" || !Number.isSafeInteger(r.rep) || r.rep < 1) problems.push(`${name} runs[${i}] needs side rn|webui, a phase and a rep ≥ 1`);
        if (r.launchClock != null && !LAUNCH_CLOCKS.includes(r.launchClock)) problems.push(`${name} runs[${i}] launchClock is not ${LAUNCH_CLOCKS.join(" or ")}`);
        const bad = fixtureProblem(r.fixture, { completed: r.status === "ok" });
        if (bad) problems.push(`${name} runs[${i}] ${bad}`);
      }
    });
  if (!isObject(report.summary) || !isObject(report.summary.rn) || !isObject(report.summary.webui)) problems.push(`${name} has no summary.rn and summary.webui`);
  return problems;
}

export function validateRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return ["rules must be a non-empty list"];
  return rules.flatMap((r, i) =>
    !isObject(r) || typeof r.key !== "string" || !r.key || typeof r.label !== "string"
      ? [`rule ${i} needs a key and a label`]
      : [
          ...["tolerance", "budget", "cap", "ratio"].filter((k) => r[k] != null && !Number.isFinite(r[k])).map((k) => `rule ${r.key} ${k} is not a number`),
          ...("vsRn" in r && typeof r.vsRn !== "boolean" ? [`rule ${r.key} vsRn is not true or false`] : []),
          ...("stat" in r && !STATS.includes(r.stat) ? [`rule ${r.key} stat is not one of ${STATS.join(", ")}`] : []),
        ],
  );
}

export const STATS = ["median", "p95", "max"];
const SIDES = ["rn", "webui"];
const SWIPES_BY_SIDE = { rn: ["fwd", "back"], webui: ["fwd", "back", "blocked"] };
const sameFixture = (a, b) => validFixture(a) && validFixture(b) && a.profiles === b.profiles && a.tabs === b.tabs && a.windows === b.windows;

export function integrity(report, { allowFallbackClock = false } = {}) {
  const meta = report?.meta ?? {};
  const runs = Array.isArray(report?.runs) ? report.runs : [];
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  const measures = Array.isArray(meta.measures) ? meta.measures : [];
  const reps = validReps(meta.reps) ? meta.reps : 0;
  const expected = reps * phases.length;
  const per = (fn) => Object.fromEntries(SIDES.map((side) => [side, fn(runs.filter((r) => r.side === side))]));
  const row = (key, label, values, ok, limit, why) => ({ key, label, stat: "integrity", rn: values.rn, webui: values.webui, limit, baseline: null, verdict: ok ? "PASS" : "FAIL", why: ok ? "" : why });
  const rows = [];
  const done = per((mine) => mine.filter((r) => r.status === "ok").length);
  const repProblems = SIDES.flatMap((side) =>
    phases.flatMap((phase) => {
      const got = runs.filter((r) => r.side === side && r.phase === phase && r.status === "ok").map((r) => r.rep);
      const seen = new Set(got);
      const covered = reps > 0 && got.length === reps && seen.size === reps && got.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= reps);
      return covered ? [] : [`${side} ${phase} has reps [${[...got].sort((a, b) => a - b).join(",")}], wants each of 1..${reps || "?"} once`];
    }),
  );
  const strays = runs.filter((r) => !phases.includes(r.phase)).length;
  const repsOk = expected > 0 && SIDES.every((s) => done[s] === expected) && !repProblems.length && !strays;
  rows.push(row("integrity.runs", "Integrity: finished runs (reps × phases)", done, repsOk, expected, repProblems[0] ?? (strays ? `${strays} run(s) in an unplanned phase` : `expected ${expected} on each side`)));
  const errored = per((mine) => mine.filter((r) => r.status !== "ok" || (r.errors ?? []).length > 0).length);
  rows.push(row("integrity.errors", "Integrity: runs with an error", errored, SIDES.every((s) => errored[s] === 0), 0, "a run failed"));
  const mismatched = per((mine) => mine.filter((r) => !sameFixture(r.fixture?.expected, r.fixture?.restored)).length);
  const crossSide = phases.filter((phase) => {
    const inPhase = runs.filter((r) => r.phase === phase);
    const first = inPhase[0]?.fixture?.expected;
    return !inPhase.length || inPhase.some((r) => !sameFixture(r.fixture?.expected, first));
  });
  rows.push(row("integrity.fixture", "Integrity: runs not restoring the seeded fixture", mismatched, SIDES.every((s) => mismatched[s] === 0) && !crossSide.length, 0, crossSide.length ? `runs seeded differently: ${crossSide.join(", ")}` : "a side restored other profiles, tabs or windows"));
  if (phases.includes("multi")) {
    const short = per((mine) => mine.filter((r) => r.phase === "multi" && !(r.windows === 2 && r.peek === true)).length);
    const ran = per((mine) => mine.filter((r) => r.phase === "multi").length);
    rows.push(row("integrity.multi", "Integrity: multi runs without 2 windows + Peek", short, SIDES.every((s) => short[s] === 0 && ran[s] > 0), 0, "a multi run missed its second window or Peek"));
  }
  if (measures.includes("swipe")) {
    const missed = Object.fromEntries(SIDES.map((side) => [side, runs.filter((r) => r.side === side && r.phase === "large").reduce((n, r) => n + SWIPES_BY_SIDE[side].filter((d) => r.swipe?.[d]?.arrived !== true || r.swipe?.[d]?.error).length, 0)]));
    rows.push(row("integrity.arrived", "Integrity: swipes that did not reach the other profile", missed, SIDES.every((s) => missed[s] === 0), 0, "a swipe did not arrive"));
    const unproven = Object.fromEntries(SIDES.map((side) => [side, SWIPES_BY_SIDE[side].includes("blocked") ? runs.filter((r) => r.side === side && r.phase === "large" && blockedProblem(r.swipe?.blocked)).length : null]));
    rows.push(row("integrity.blocked", "Integrity: blocked swipes without a pager interval overlapping the block", unproven, unproven.webui === 0, 0, "a blocked swipe has no valid pager motion overlapping its block"));
  }
  if (measures.includes("memory")) {
    const gaps = per((mine) => mine.filter((r) => r.status === "ok" && !(isCount(r.memory?.rssMb) && r.memory.rssMb > 0 && isCount(r.memory?.footprintMb) && r.memory.footprintMb > 0)).length);
    rows.push(row("integrity.memory", "Integrity: finished runs without an RSS and footprint sample", gaps, SIDES.every((s) => gaps[s] === 0), 0, "a run is missing its RSS or phys_footprint"));
  }
  if (measures.includes("peek")) {
    const missed = per((mine) => mine.filter((r) => r.phase === "large" && !(r.peek?.opened === true && r.peek?.dismissed === true && !r.peek?.error)).length);
    rows.push(row("integrity.peek", "Integrity: Peek runs that did not open and dismiss", missed, SIDES.every((s) => missed[s] === 0), 0, "a Peek did not open or go away"));
  }
  if (measures.includes("launch")) {
    const failedPolls = per((mine) => mine.reduce((n, r) => n + (Number.isInteger(r.newTabPollFailures) ? r.newTabPollFailures : 1), 0));
    rows.push(row("integrity.newTabPolls", "Integrity: New Tab polls that could not read the store", failedPolls, SIDES.every((s) => failedPolls[s] === 0), 0, "polls failed or were not recorded"));
  }
  const clocks = per((mine) => [...new Set(mine.map((r) => r.launchClock ?? "none"))].sort().join("+") || "none");
  const all = new Set(SIDES.flatMap((s) => clocks[s].split("+")));
  const clockOk = !all.has("none") && [...all].every((c) => LAUNCH_CLOCKS.includes(c)) && (all.size === 1 || allowFallbackClock);
  rows.push(row("integrity.clock", "Integrity: launch clock", clocks, clockOk, null, all.has("none") ? "a run has no launch clock" : "the sides used different launch clocks (--allow-fallback-clock to accept)"));
  return rows;
}

export function blockedProblem(blocked) {
  if (!blocked) return "no blocked swipe";
  if (blocked.error) return blocked.error;
  if (blocked.arrived !== true) return "did not arrive";
  const { motion, block } = blocked;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  if (!motion || !finite(motion.start) || !finite(motion.end) || motion.end <= motion.start) return "no pager moving → rest interval";
  if (!block || !finite(block.start) || !finite(block.end) || block.end <= block.start) return "no recorded block interval";
  const overlap = Math.min(block.end, motion.end) - Math.max(block.start, motion.start);
  if (!(overlap > 0)) return "the block did not overlap the pager motion";
  return null;
}

export function baselineProblems(baseline, options = {}) {
  const shape = validateReport(baseline, "baseline");
  if (shape.length) return shape;
  return integrity(baseline, options).filter((r) => r.verdict !== "PASS").map((r) => `baseline ${r.label}: ${r.why}`);
}

export function evaluate(report, options = {}) {
  const rules = options.rules ?? RULES;
  const rows = [...integrity(report, options), ...rules.map((rule) => judge(rule, report, options))];
  if (options.baseline) {
    const problems = baselineProblems(options.baseline, options);
    rows.push({ key: "integrity.baseline", label: "Integrity: baseline report is complete", stat: "integrity", rn: null, webui: problems.length, limit: 0, baseline: null, verdict: problems.length ? "FAIL" : "PASS", why: problems[0] ?? "" });
  }

  const failed = rows.filter((r) => r.verdict === "FAIL" || r.verdict === "REGRESSION");
  return { pass: failed.length === 0, verdict: failed.length ? "FAIL" : "PASS", failed: failed.length, skipped: rows.filter((r) => r.verdict === "SKIP").length, rows };
}

const cell = (s) => String(s).replace(/\|/g, "\\|");

export function markdown(result, { title = "Mac WebUI parity gate", meta = null } = {}) {
  const hasBaseline = result.rows.some((r) => r.baseline != null);
  const head = ["Metric", "RN", "WebUI", "Limit", ...(hasBaseline ? ["Baseline"] : []), "Verdict"];
  const icon = { PASS: "✅ PASS", FAIL: "❌ FAIL", REGRESSION: "📉 REGRESSION", SKIP: "⏭ SKIP" };
  const lines = [
    `## ${title}: ${result.pass ? "✅ PASS" : "❌ FAIL"}`,
    "",
    ...(meta ? [meta, ""] : []),
    `| ${head.join(" | ")} |`,
    `| ${head.map((h, i) => (i === 0 || h === "Verdict" ? "---" : "---:")).join(" | ")} |`,
    ...result.rows.map((r) => {
      const label = r.stat === "median" || r.stat === "integrity" ? r.label : `${r.label} [${r.stat}]`;
      const verdict = r.why ? `${icon[r.verdict]} (${r.why})` : icon[r.verdict];
      return `| ${[label, fmt(r.rn), fmt(r.webui), fmt(r.limit), ...(hasBaseline ? [fmt(r.baseline)] : []), verdict].map(cell).join(" | ")} |`;
    }),
    "",
    `${result.rows.length - result.failed - result.skipped} passed, ${result.failed} failed, ${result.skipped} skipped.`,
  ];
  return lines.join("\n") + "\n";
}

export function parseGateArgs(argv) {
  const out = { report: null, baseline: null, rules: null, regressionPct: 10, allowMissing: false, allowFallbackClock: false, markdownOut: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--baseline") out.baseline = take();
    else if (a === "--rules") out.rules = take();
    else if (a === "--regression") {
      out.regressionPct = Number(take());
      if (!Number.isFinite(out.regressionPct) || out.regressionPct < 0) throw new Error("--regression is a percentage ≥ 0");
    } else if (a === "--allow-missing") out.allowMissing = true;
    else if (a === "--allow-fallback-clock") out.allowFallbackClock = true;
    else if (a === "--markdown") out.markdownOut = take();
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (!out.report) out.report = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseGateArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`gate: ${e.message}\n\n${HELP}`);
    process.exit(64);
  }
  if (args.help || !args.report) {
    console.log(HELP);
    process.exit(args.help ? 0 : 64);
  }
  let report, baseline, rules;
  try {
    report = JSON.parse(readFileSync(args.report, "utf8"));
    baseline = args.baseline ? JSON.parse(readFileSync(args.baseline, "utf8")) : null;
    rules = args.rules ? JSON.parse(readFileSync(args.rules, "utf8")) : RULES;
  } catch (e) {
    console.error(`gate: ${e.message}`);
    process.exit(64);
  }
  const problems = [...validateReport(report, args.report), ...(args.baseline ? baselineProblems(baseline, { allowFallbackClock: args.allowFallbackClock }) : []), ...validateRules(rules)];
  if (problems.length) {
    console.error(`gate: ${problems.join("\ngate: ")}`);
    process.exit(64);
  }
  const result = evaluate(report, { rules, baseline, regressionPct: args.regressionPct, allowMissing: args.allowMissing, allowFallbackClock: args.allowFallbackClock });
  const meta = report.meta ? `${report.meta.host ?? "?"}, ${report.meta.reps ?? "?"} reps (${report.meta.order ?? "?"}), ${report.meta.finishedAt ?? report.meta.startedAt ?? ""}` : null;
  const md = markdown(result, { meta });
  if (args.markdownOut) writeFileSync(args.markdownOut, md);
  console.log(args.json ? JSON.stringify(result, null, 1) : md);
  process.exit(result.pass ? 0 : 1);
}
