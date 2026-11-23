#!/usr/bin/env node
// Long-session soak: a day's browsing compressed into minutes, on a production (Hermes) bundle in a hidden instance,
// sampled at intervals so growth shows as a curve (#3163). Starts from js-bench's 200-tab seed.
//
//   node soak.mjs run --app <Release Ardia.app> --bundle <main.jsbundle> --label <name> [flags]
//     --rounds <n>         rounds of activity (default 120). One round: --navs navigations spread over the windows'
//                          tabs (60% new URLs, the rest revisits), --opens new tabs (at most 6 kept open: the oldest
//                          closes as each opens), --switches tab switches
//     --navs <n>           navigations per round (default 60)
//     --opens <n>          tabs opened and closed per round (default 20)
//     --switches <n>       tab switches per round (default 40)
//     --sample-every <n>   rounds between samples (default 10); a sample is also taken before the first round
//     --port <n>           test page server port (default 47917); the instance's CDP port is port + 1
//     --out <dir>          default $AC_PERF_OUT or /tmp/ac-perf-soak; writes <out>/<label>.jsonl, one sample a line
//     --data <dir>         reuse this data folder as it is instead of seeding a fresh one
//     --hold 1             leave the instance running at the end (prints its pid and data folder)
//     --history <n>        seed n history entries in Personal and n/2 in Work instead of 5000 and 800
//     --idle-seconds <s>   the idle window of each sample (default 4; 16 holds a whole 15 s sync cycle)
//     --quiet-seconds <s>  after the last round, leave both instances alone for s seconds and sample the first's idle
//                          window alone (no tab actions before it), so it holds no cycle with fresh local or remote changes
//     --sync 1             a second instance (<label>-peer, a third of the activity) paired with the first through a
//                          scratch sync folder, every data type on; both are sampled
//
// Each sample: the JS heap after a forced collection (HermesInternal), store slice sizes, live store listeners,
// module-event listeners, intervals and pending timeouts (the probe's `listeners` option), native views, the browser
// process's resident memory, and per-action JS time: tab switch, open and close (the synchronous store + React
// commit, and all JS work in the settle window after), and idle JS busy ms per second over 4 s.
//
//   node soak.mjs compare <before.jsonl> <after.jsonl>
//     Prints the first and last sample of each, and the growth per 1000 navigations, side by side.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareApp } from "../../../../scripts/lib/app-copy.mjs";
import { evaluate, launch, quit, startServer } from "./js-bench.mjs";
import { writeSeed } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
const positional = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--"));

const rssMb = (pid) => {
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;
  } catch {
    return null;
  }
};

const childCount = (pid) => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const round1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : x);

function line(sample) {
  const t = sample.timing ?? {};
  const live = sample.live ?? {};
  return [
    `navs ${sample.navSeq}`,
    `heap ${round1(sample.heap.allocatedMb)}MB`,
    `rss ${round1(sample.rssMb)}MB`,
    `listeners ${live.listeners ?? "?"}`,
    `modListeners ${live.moduleListeners ?? "?"}`,
    `intervals ${live.intervals ?? "?"}`,
    `timeouts ${live.timeouts ?? "?"}`,
    `switch ${round1(t.switchSyncMs)}/${round1(t.switchBusyMs)}ms`,
    `open ${round1(t.openSyncMs)}/${round1(t.openBusyMs)}ms`,
    `close ${round1(t.closeSyncMs)}/${round1(t.closeBusyMs)}ms`,
    `idle ${round1(t.idleBusyMsPerS)}ms/s lag ${t.idleLag?.lagP95 ?? "?"}/${t.idleLag?.lagMax ?? "?"}ms`,
    `tabs ${sample.store.tabs} closed ${sample.store.closedTabs}`,
  ].join("  ");
}

async function soak() {
  const { app, bundle, label } = flags;
  if (!app || !bundle || !label) throw new Error("soak needs --app, --bundle and --label");
  const out = flags.out ?? process.env.AC_PERF_OUT ?? "/tmp/ac-perf-soak";
  const port = Number(flags.port ?? 47917);
  const rounds = Number(flags.rounds ?? 120);
  const every = Number(flags["sample-every"] ?? 10);
  const roundOptions = { navigations: Number(flags.navs ?? 60), opens: Number(flags.opens ?? 20), switches: Number(flags.switches ?? 40) };
  mkdirSync(out, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const server = await startServer(port);
  const instances = [];
  const start = async (name, cdpPort) => {
    const clone = prepareApp(app, join(out, "apps", name), { bundle });
    const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleShortVersionString", join(clone, "Contents/Info.plist")], { encoding: "utf8" }).trim();
    const dataDir = (name === label && flags.data) || join(out, "data", name);
    if (!(name === label && flags.data)) {
      rmSync(dataDir, { recursive: true, force: true });
      writeSeed(dataDir, origin, version, { tabsOrigin: `http://[::1]:${port}` });
      if (flags.history) writeFileSync(join(dataDir, "history.json"), JSON.stringify(bigHistory(Number(flags.history))));
    }
    writeFileSync(join(dataDir, "perf-probe"), "listeners");
    const { pid } = await launch(clone, dataDir, cdpPort, flags.sync ? { ARDIA_TEST: "reauth=granted" } : {});
    const instance = { name, pid, dataDir, file: join(out, `${name}.jsonl`), eval: (body, ms) => evaluate(dataDir, pid, body, ms) };
    instances.push(instance);
    writeFileSync(instance.file, "");
    console.log(`${name}: pid ${pid} data ${dataDir}`);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) ready = await instance.eval("return 1;", 2000).then(() => true, (e) => (String(e).includes("exited") ? Promise.reject(e) : false));
    if (!ready) throw new Error(`${name}: dev harness never answered`);
    await instance.eval(readFileSync(join(here, "soak-app.js"), "utf8"), 60_000);
    return instance;
  };
  try {
    const main = await start(label, port + 1);
    const peer = flags.sync ? await start(`${label}-peer`, port + 2) : null;
    if (peer) await pair(main, peer, join(out, "data", `${label}-folder`));
    await main.eval("return new Promise((r) => setTimeout(() => r(1), 8000));", 20_000);
    const takeSample = async (instance, roundsDone, roundStats, actions, idleOnly = false) => {
      const sample = await instance.eval(`return acSoak.sample(${JSON.stringify({ origin, actions, idleOnly, idleMs: Number(flags["idle-seconds"] ?? 4) * 1000 })});`, 180_000);
      Object.assign(sample, { rounds: roundsDone, rssMb: rssMb(instance.pid), children: childCount(instance.pid), round: roundStats });
      appendFileSync(instance.file, `${JSON.stringify(sample)}\n`);
      console.log(`[${instance.name} ${roundsDone}] ${line(sample)}${sample.round ? `  round lag p95 ${sample.round.lagP95} max ${sample.round.lagMax} gc ${sample.round.gcs}/${round1(sample.round.gcMs)}ms` : ""}${sample.sync?.enabled ? `  sync ${sample.sync.status} pending ${sample.sync.pending}` : ""}`);
    };
    const sampleAll = async (r, stats, idleOnly = false) => {
      await takeSample(main, r, stats[0], true, idleOnly);
      if (peer) await takeSample(peer, r, stats[1], false);
    };
    await sampleAll(0, []);
    let last = [];
    const peerOptions = { ...roundOptions, navigations: Math.ceil(roundOptions.navigations / 3), opens: Math.ceil(roundOptions.opens / 3), switches: Math.ceil(roundOptions.switches / 3) };
    for (let r = 1; r <= rounds; r++) {
      last = await Promise.all([
        main.eval(`return acSoak.round(${JSON.stringify({ origin, ...roundOptions })});`, 300_000),
        ...(peer ? [peer.eval(`return acSoak.round(${JSON.stringify({ origin, ...peerOptions })});`, 300_000)] : []),
      ]);
      if (r % every === 0 || r === rounds) {
        await Promise.all(instances.map((i) => i.eval("return acSoak.closeMade();", 30_000)));
        await sampleAll(r, last);
      }
    }
    if (flags["quiet-seconds"]) {
      await new Promise((resolve) => setTimeout(resolve, Number(flags["quiet-seconds"]) * 1000));
      await sampleAll(`${rounds}+quiet`, [], true);
    }
  } finally {
    server.close();
    for (const instance of instances) {
      if (flags.hold) console.log(`holding ${instance.name} pid ${instance.pid} data ${instance.dataDir}`);
      else await quit(instance.pid);
    }
  }
  console.log(`wrote ${instances.map((i) => i.file).join(", ")}`);
}

function bigHistory(n) {
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < n; i++) {
    const visits = 1 + (i % 4);
    const lastVisit = now - Math.floor((i / n) * 85 * 86_400_000) - (i % 977);
    entries.push({ url: `https://site${i % 991}.example/${i % 7 ? "page" : "doc"}/${i}`, title: `Seeded page ${i}`, favicon: null, visits, lastVisit, visitTimes: Array.from({ length: visits }, (_, k) => lastVisit - k * 3_600_000).reverse() });
  }
  return { version: 2, history: { default: entries, work: entries.slice(0, Math.floor(n / 2)) } };
}

async function historyLoaded(instance, at) {
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    const n = await instance.eval("return Math.max(0, ...Object.values(ac.store.getState().history).map((v) => (v.ready ? v.list.length : 0)));", 30_000);
    if (n >= at) return n;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${instance.name}: history never reached ${at} entries`);
}

async function pair(main, peer, folder) {
  const seeded = flags.history ? Math.floor(Number(flags.history) * 0.9) : 1;
  console.log(`history loaded: ${await historyLoaded(main, seeded)} and ${await historyLoaded(peer, seeded)}`);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const on = await main.eval(`return ac.sync.turnOnSync(${JSON.stringify(folder)});`, 60_000);
  if (!on?.ok) throw new Error(`sync didn't turn on: ${JSON.stringify(on)}`);
  await main.eval("return ac.sync.syncNow();", 900_000);
  const words = (await main.eval("return ac.sync.native.recoveryWords();", 30_000)).join(" ");
  const joined = await peer.eval(`return ac.sync.enterRecoveryPhrase(${JSON.stringify(folder)}, ${JSON.stringify(words)});`, 60_000);
  if (!joined?.ok) throw new Error(`the peer didn't join: ${JSON.stringify(joined)}`);
  for (let i = 0; i < 3; i++) {
    await peer.eval("return ac.sync.syncNow();", 900_000);
    await main.eval("return ac.sync.syncNow();", 900_000);
  }
  console.log(`paired through ${folder}: ${JSON.stringify(await main.eval("return ac.sync.useSync.getState().status;"))}`);
}

function compare([a, b]) {
  const read = (f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const f of [a, b]) {
    const samples = read(f);
    const first = samples[0];
    const lastSample = samples[samples.length - 1];
    const per1k = (get) => {
      const navs = lastSample.navSeq - first.navSeq;
      return navs ? round1(((get(lastSample) - get(first)) * 1000) / navs) : null;
    };
    console.log(`\n${f}`);
    console.log(`  first ${line(first)}`);
    console.log(`  last  ${line(lastSample)}`);
    console.log(`  per 1000 navigations: heap ${per1k((s) => s.heap.allocatedMb)}MB, rss ${per1k((s) => s.rssMb)}MB, listeners ${per1k((s) => s.live?.listeners ?? 0)}, timeouts ${per1k((s) => s.live?.timeouts ?? 0)}, idle ${per1k((s) => s.timing?.idleBusyMsPerS ?? 0)}ms/s`);
  }
}

if (command === "compare") compare(positional);
else if (command === "--help" || command === "-h" || !command) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
} else if (command === "run") await soak();
else throw new Error(`unknown command ${command}: run, compare or --help`);
