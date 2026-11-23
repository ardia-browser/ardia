import { execFileSync, spawnSync } from "node:child_process";

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const ROW = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s+(.*)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseTable(text) {
  return text.split("\n").map((line) => line.match(ROW)).filter(Boolean).map((m) => ({
    pid: +m[1], ppid: +m[2], command: m[9],
    started: new Date(+m[8], MONTHS.indexOf(m[3]), +m[4], +m[5], +m[6], +m[7]).getTime(),
  }));
}

export const processTable = () =>
  parseTable(spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout ?? "");

export function descendants(root, table = processTable()) {
  const children = new Map();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const found = [];
  const queue = [root];
  while (queue.length) for (const child of children.get(queue.shift()) ?? []) found.push(child), queue.push(child.pid);
  return found;
}

export const insideApp = (command, app) => command.startsWith(`${app.replace(/\/+$/, "")}/Contents/`);

const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && a.started === b.started && a.command === b.command;

export function launchedTree(pid, app, table = processTable()) {
  const root = table.find((p) => p.pid === pid);
  return [...(root ? [root] : []), ...descendants(pid, table)].filter((p) => insideApp(p.command, app));
}

export const quitTargets = ({ tracked, confirmed }, app, table = processTable()) => (confirmed ? survivors(tracked, app, table) : []);

export function survivors(tree, app, table = processTable()) {
  const alive = new Map(table.map((p) => [p.pid, p]));
  return tree.filter((p) => sameProcess(alive.get(p.pid), p) && insideApp(p.command, app));
}

export function signalIfSame(entry, signal, table = processTable()) {
  if (!sameProcess(table.find((p) => p.pid === entry.pid), entry)) return false;
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function listenerPid(port) {
  const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout ?? "";
  const pids = [...new Set(out.split("\n").filter(Boolean).map(Number))];
  return pids.length === 1 ? pids[0] : null;
}

export async function stopTree(tree, app, { graceMs = 10_000, pollMs = 100 } = {}) {
  for (const end = Date.now() + graceMs; Date.now() < end && survivors(tree, app).length; ) await sleep(pollMs);
  const table = processTable();
  const left = survivors(tree, app, table);
  for (const entry of left) signalIfSame(entry, "SIGKILL", table);
  return left.map((p) => p.pid);
}

export function processRows() {
  return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: +pid, ppid: +ppid, command }));
}

export function kindOf(command) {
  const type = command.match(/--type=(\S+)/)?.[1];
  if (!type) return /crashpad_handler/.test(command) ? "crashpad" : "browser";
  if (type === "utility") return `utility:${command.match(/--utility-sub-type=([\w.]+)/)?.[1]?.split(".")[0] ?? "?"}`;
  if (type === "renderer" && command.includes("--extension-process")) return "extension";
  return type;
}
