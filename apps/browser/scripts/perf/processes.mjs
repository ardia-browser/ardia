import { spawnSync } from "node:child_process";

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function processTable() {
  const out = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").map((line) => line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], command: m[3] }));
}

export function descendants(root, table = processTable()) {
  const children = new Map();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const found = [];
  const queue = [root];
  while (queue.length) for (const child of children.get(queue.shift()) ?? []) found.push(child), queue.push(child.pid);
  return found;
}

export const insideApp = (command, app) => command.startsWith(`${app.replace(/\/+$/, "")}/Contents/`);

export function launchedTree(pid, app, table = processTable()) {
  const root = table.find((p) => p.pid === pid);
  return [...(root ? [root] : []), ...descendants(pid, table)].filter((p) => insideApp(p.command, app));
}

export function survivors(tree, app, table = processTable()) {
  const alive = new Map(table.map((p) => [p.pid, p.command]));
  return tree.filter((p) => alive.get(p.pid) === p.command && insideApp(p.command, app)).map((p) => p.pid);
}

export async function stopTree(tree, app, { graceMs = 10_000, pollMs = 100 } = {}) {
  for (const end = Date.now() + graceMs; Date.now() < end && survivors(tree, app).length; ) await sleep(pollMs);
  const left = survivors(tree, app);
  for (const pid of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return left;
}
