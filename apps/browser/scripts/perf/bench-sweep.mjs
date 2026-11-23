#!/usr/bin/env node
// Stops the app instances a gate's jobs launched, found by where their data lives, never by executable or pid alone.
//
//   node apps/browser/scripts/perf/bench-sweep.mjs stop --under <dir> [--under <dir> …] [--quit-secs <n>] [--kill-secs <n>]
//   node apps/browser/scripts/perf/bench-sweep.mjs list --under <dir> [--under <dir> …]
//
// `open` starts an app outside every process group, so no signal to a bench reaches it. Every instance a bench or the
// smoke test launches gets ARDIA_DATA_DIR (or, for carryover, HOME) in its environment, and Chromium's helpers inherit
// the browser's environment. A process is this gate's only when that variable names a path inside one of the --under
// folders (gate.sh passes its own scratch folder and its --out). The owner's Ardia, or any other agent's, never has
// one, so it is never signalled. A --under that is shallower than two folders, a shared temporary folder, or the
// home folder or one above it is refused (exit 64): it could hold someone else's instances. The environment is read again just before every signal (SIGTERM, then SIGKILL after
// --quit-secs, default 15), and this process and its ancestors are never candidates. Exit 0 once none is left, 1 when
// some are still there after --kill-secs (default 5) more, listed on stdout.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MARKER_VARIABLES = ["ARDIA_DATA_DIR", "HOME"];

const real = (dir) => {
  try {
    return realpathSync(dir).replace(/\/+$/, "");
  } catch {
    return dir.replace(/\/+$/, "");
  }
};

export function markerProblem(dir, { home = homedir(), temps = ["/tmp", "/private/tmp", "/var/tmp", tmpdir()] } = {}) {
  const d = real(resolve(dir));
  const h = real(home);
  if (d.split("/").filter(Boolean).length < 2) return `${dir} is too shallow to be a gate's own folder`;
  if (h === d || h.startsWith(`${d}/`)) return `${dir} holds the home folder`;
  if (temps.map(real).includes(d)) return `${dir} is a shared temporary folder`;
  return null;
}

const forms = (dir) => {
  const problem = markerProblem(dir);
  if (problem) throw new Error(`bench-sweep: refusing --under ${problem}`);
  return [...new Set([resolve(dir).replace(/\/+$/, ""), real(resolve(dir))])];
};

export const insideAny = (value, dirs) => dirs.some((d) => value === d || value.startsWith(`${d}/`));

export function canonical(path) {
  const rest = [];
  let dir = resolve(path);
  for (let i = 0; i < 256; i++) {
    try {
      return [realpathSync(dir), ...rest].join("/").replace(/\/+$/, "") || "/";
    } catch {
      const up = dirname(dir);
      if (up === dir) return resolve(path);
      rest.unshift(basename(dir));
      dir = up;
    }
  }
  return resolve(path);
}

export function markedBy(env, dirs) {
  return MARKER_VARIABLES.some((name) => typeof env[name] === "string" && env[name].startsWith("/") && (insideAny(env[name], dirs) || insideAny(canonical(env[name]), dirs)));
}

function parsePsEnvironment(line) {
  const env = {};
  for (const m of line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) env[m[1]] = m[2];
  return env;
}

export function environmentOf(pid) {
  if (process.platform === "linux") {
    try {
      return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    } catch {
      return null;
    }
  }
  try {
    const line = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return line.trim() ? parsePsEnvironment(line) : null;
  } catch {
    return null;
  }
}

function environments() {
  if (process.platform === "linux") return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map((n) => [+n, environmentOf(+n)]);
  const out = execFileSync("ps", ["-axE", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] });
  return out.split("\n").map((l) => l.match(/^\s*(\d+)\s(.*)$/)).filter(Boolean).map(([, pid, rest]) => [+pid, parsePsEnvironment(rest)]);
}

export function parentOf(pid) {
  try {
    if (process.platform === "linux") return +readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().split(" ")[1];
    return +execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return NaN;
  }
}

function ancestors() {
  const mine = new Set([process.pid]);
  let pid = process.ppid;
  for (let i = 0; i < 64 && pid > 1 && !mine.has(pid); i++) {
    mine.add(pid);
    pid = parentOf(pid);
  }
  return mine;
}

export function findMarked(dirs, { exclude = ancestors() } = {}) {
  const all = dirs.flatMap(forms);
  return environments().filter(([pid, env]) => !exclude.has(pid) && env && markedBy(env, all)).map(([pid]) => pid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function exited(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().startsWith("Z");
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z");
  } catch {
    return true;
  }
}

export async function stopMarked(dirs, { quitSecs = 15, killSecs = 5 } = {}) {
  const all = dirs.flatMap(forms);
  const exclude = ancestors();
  const stillMarked = (pid) => {
    const env = environmentOf(pid);
    return !!env && markedBy(env, all);
  };
  const signal = (pid, sig) => {
    if (!stillMarked(pid)) return false;
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  const found = findMarked(dirs, { exclude });
  for (const pid of found) signal(pid, "SIGTERM");
  const stillThere = (pid) => {
    if (exited(pid)) return false;
    const env = environmentOf(pid);
    return !env || !Object.keys(env).length || markedBy(env, all);
  };
  const left = () => [...new Set([...found.filter(stillThere), ...findMarked(dirs, { exclude })])];
  for (const end = Date.now() + quitSecs * 1000; left().length && Date.now() < end; ) await sleep(250);
  for (const pid of left()) signal(pid, "SIGKILL");
  let remaining = left();
  for (const end = Date.now() + killSecs * 1000; remaining.length && Date.now() < end; remaining = left()) await sleep(100);
  return { found, left: remaining };
}

async function main() {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { under: { type: "string", multiple: true, default: [] }, "quit-secs": { type: "string", default: "15" }, "kill-secs": { type: "string", default: "5" }, help: { type: "boolean", short: "h" } } });
  if (opt.help || !["stop", "list"].includes(positionals[0]) || !opt.under.length) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opt.help ? 0 : 64);
  }
  if (positionals[0] === "list") {
    for (const pid of findMarked(opt.under)) console.log(pid);
    return;
  }
  for (const dir of opt.under) {
    const problem = markerProblem(dir);
    if (problem) {
      console.log(`bench-sweep: refusing --under ${problem}`);
      process.exit(64);
    }
  }
  const { found, left } = await stopMarked(opt.under, { quitSecs: +opt["quit-secs"], killSecs: +opt["kill-secs"] });
  if (found.length) console.log(`bench-sweep: stopped ${found.join(", ")}`);
  if (left.length) console.log(`bench-sweep: still running: ${left.join(", ")}`);
  process.exit(left.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
