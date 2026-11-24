#!/usr/bin/env node
const HELP = `Settings › Passwords with a huge vault: what opening the page, searching, scrolling and opening a login's sheets cost
on the JS thread and the main thread, with a fake manager of any size (ARDIA_TEST vaultFakeItems, VaultFakeProvider.swift).

  node apps/browser/scripts/perf/passwords-pane-bench.mjs --app <Debug Ardia.app> --scratch <dir> [--items 50000] [--js host:port] [--port 9470] [--label name]

Each step runs in a fresh hidden instance's Settings window through the dev harness (ac.vaultPerf): the JS thread is
watched by a 4 ms timer (a gap is a long task), the main thread by a DevTools Browser.getVersion ping every 10 ms (it
answers on Chrome's UI thread, which is the main thread), and React commits, renders and mounts are counted. Prints one
JSON line per step. Timing runs one at a time: take the perflab lock (scripts/agent/locked perflab).`;

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
if (args.includes("-h") || args.includes("--help") || !option("app")) {
  console.log(HELP);
  process.exit(args.includes("-h") || args.includes("--help") ? 0 : 1);
}

const root = new URL("../../../../", import.meta.url).pathname;
const ac = join(root, "scripts/agent/ac");
const scratch = option("scratch");
const data = join(scratch, "data");
const port = option("port", "9470");
const items = option("items", "50000");
const label = option("label", "run");
const STEPS = [
  "ac.vaultPerf.openPasswords()",
  "ac.vaultPerf.scrollBy(1100)",
  'ac.vaultPerf.typeQuery("acme")',
  "ac.vaultPerf.clearQuery()",
  "ac.vaultPerf.scrollBy(30000)",
  'ac.vaultPerf.typeQuery("work")',
  "ac.vaultPerf.clearQuery()",
  "ac.vaultPerf.scrollBy(1100)",
  "ac.vaultPerf.openFirstLogin()",
  "ac.vaultPerf.openEdit()",
  'ac.vaultPerf.typeInField("Optional", "sam.edited")',
  "ac.vaultPerf.closeSheet()",
];

rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(data, "Password Managers/bin"), { recursive: true });
const fakeCli = join(data, "Password Managers/bin/bigvault");
writeFileSync(fakeCli, '#!/bin/sh\necho "bigvault 1.0.0"\n');
chmodSync(fakeCli, 0o755);
const js = option("js");
await run(ac, ["launch", option("app"), "--data", data, "--port", port, ...(js ? ["--js", js] : []), "--test", `vaultFakeItems=${items}`, "--test", "keychain=file", "--test", "reauth=granted", "--test", "touchID=granted", "--onboarded"]);
const evaluate = async (body) => (await run(ac, ["eval", data, body, "--timeout", "120000"], { encoding: "utf8" })).stdout.trim();

try {
  await evaluate('return globalThis.expo.modules.ArdiaVaults.signIn("bigvault", "{}").then(() => ac.engine.call("vaults.itemsStatus", {})).then(JSON.stringify)');
  const version = await (await fetch(`http://localhost:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const waiting = new Map();
  socket.addEventListener("message", (event) => waiting.get(JSON.parse(event.data).id)?.());
  let pings = [];
  let pinging = true;
  let id = 0;
  const pinger = (async () => {
    while (pinging) {
      const started = performance.now();
      await new Promise((resolve) => {
        waiting.set(++id, resolve);
        socket.send(JSON.stringify({ id, method: "Browser.getVersion" }));
      });
      pings.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  for (const step of STEPS) {
    pings = [];
    let result = JSON.parse(await evaluate(`return ${step}.then(JSON.stringify)`));
    if (typeof result === "string") result = JSON.parse(result);
    const main = { mainMaxMs: Math.round(Math.max(0, ...pings)), mainOver50: pings.filter((p) => p >= 50).length, mainBlockedMs: Math.round(pings.filter((p) => p > 17).reduce((sum, p) => sum + p, 0)) };
    console.log(JSON.stringify({ label, step: step.replace("ac.vaultPerf.", ""), ...result, ...main }));
  }
  pinging = false;
  await pinger;
  socket.close();
} finally {
  await run(ac, ["quit", data]).catch(() => undefined);
}
