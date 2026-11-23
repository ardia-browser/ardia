#!/usr/bin/env node
const HELP = `Store simulator: seeded random action sequences against the real browser store, under node.

  pnpm -C apps/browser sim                     the CI seed set, every mode (deterministic)
  node scripts/sim/run.mjs [options]

  --mode <correctness|cost|leak|map|all>   what to run (default all)
  --seeds <a-b|a,b,c>                      seeds (default the CI set)
  --steps <n>                              steps per seed (default 120)
  --soak <seconds>                         keep drawing new seeds until the time is up
  --replay '<json>'                        replay one sequence ([["kind", picks…], …]) and print each step
  --src <dir>                              another apps/browser/src to drive (an older commit's export)
  --map <file>                             where the dependency map goes (default sim-out/dependency-map.md)
  --shrink-budget <n>                      replays the shrinker may spend per failure (default 600)
  --json                                   print the result as JSON
  --help                                   this text
`;
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
if (args.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const CI_SEEDS = "1-40";
const CI_STEPS = 120;
const REACH_FLOOR_SEEDS = 20;
const MODES = ["correctness", "cost", "leak", "map"];

const parseSeeds = (text) =>
  text.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });

const mode = flag("replay") ? "correctness" : flag("mode", "all");
const src = flag("src", undefined);
const here = dirname(fileURLToPath(import.meta.url));

const loaded = process.execArgv.some((a) => a.includes("test-loader.mjs"));
if (mode !== "all" && !loaded) {
  const loader = resolve(src ?? resolve(here, "../../src"), "test-loader.mjs");
  const child = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", "--import", loader, fileURLToPath(import.meta.url), ...args], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}

if (mode === "all") {
  const loader = resolve(src ?? resolve(here, "../../src"), "test-loader.mjs");
  let failed = false;
  const began = performance.now();
  for (const m of MODES) {
    const child = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", "--import", loader, fileURLToPath(import.meta.url), ...args.filter((a, i) => a !== "--mode" && args[i - 1] !== "--mode"), "--mode", m], { stdio: "inherit" });
    if (child.status !== 0) failed = true;
  }
  process.stderr.write(`store simulator: ${Math.round(performance.now() - began)} ms\n`);
  process.exit(failed ? 1 : 0);
}

const { boot } = await import("./boot.mjs");
const ACTION_KINDS = Object.keys((await import("./world.mjs")).ACTION_WEIGHTS);
const { describeFailure, exploreSeed, replay } = await import("./explore.mjs");
const { reachOf, REQUIRED_REACH } = await import("./reach.mjs");
const { checkKnown } = await import("./known.mjs");

const steps = Number(flag("steps", CI_STEPS));
const CI_SEED_LIST = parseSeeds(CI_SEEDS);
const seeds = flag("seeds") ? parseSeeds(flag("seeds")) : CI_SEED_LIST;
const soak = Number(flag("soak", 0));
const asJson = args.includes("--json");

const world = await boot({ src });
const out = (...a) => world.console.log(...a);

async function correctness() {
  const started = performance.now();
  const failures = [];
  let ran = 0;
  const reach = {};
  const countReach = (step, outcome) => {
    for (const key of reachOf(world, step, outcome)) reach[key] = (reach[key] ?? 0) + 1;
  };
  const queue = [...seeds];
  let next = Math.max(...seeds) + 1;
  while (queue.length || (soak && performance.now() - started < soak * 1000)) {
    const seed = queue.shift() ?? next++;
    const result = await exploreSeed(world, seed, { steps, onStep: countReach, shrinkBudget: Number(flag("shrink-budget", 600)) });
    ran++;
    if (!result.ok) failures.push(result);
  }
  const ms = Math.round(performance.now() - started);
  const unreached = ran >= REACH_FLOOR_SEEDS ? [...REQUIRED_REACH, ...ACTION_KINDS].filter((k) => !reach[k]) : [];
  if (asJson) out(JSON.stringify({ mode: "correctness", ran, steps, failures, reach, unreached }, null, 2));
  else {
    out(`correctness: ${ran} seeds × ${steps} steps, ${failures.length} failing${soak ? ` (soak of ${soak} s)` : ""}`);
    process.stderr.write(`correctness: ${ms} ms\n`);
    for (const f of failures) out(describeFailure(f));
    out(`reach: ${Object.entries(reach).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (unreached.length) out(`✗ never reached, so the rules that need it passed without being tested: ${unreached.join(", ")}`);
  }
  const known = seeds === CI_SEED_LIST || soak ? await checkKnown(world) : [];
  if (!asJson) for (const k of known) out(k.line);
  return failures.length === 0 && unreached.length === 0 && known.every((k) => k.ok);
}

async function replayOne(json) {
  const sequence = JSON.parse(json).map(([kind, ...picks]) => ({ kind, picks }));
  const result = await replay(world, sequence, { onStep: (step, outcome) => out(`  ${outcome.detail}`) });
  if (result.failure) for (const p of result.failure.problems) out(`  ✗ [${p.rule}] ${p.message}`);
  else out("  ✓ every rule held");
  return !result.failure;
}

let ok;
if (flag("replay")) ok = await replayOne(flag("replay"));
else if (mode === "correctness") ok = await correctness();
else {
  const cost = await import("./cost.mjs");
  const mapFile = flag("map", resolve(here, "../../sim-out/dependency-map.md"));
  const write = (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  ok = await cost.runMode(world, mode, { seeds, steps, out, asJson, mapFile, write });
}
process.exit(ok ? 0 : 1);
