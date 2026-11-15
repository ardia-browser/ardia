#!/usr/bin/env node
const HELP = `Usage: node scripts/dev-engine.mjs [--engine DIR] [--name NAME] [--port N] [--display N]
Builds the engine UI bundle with vite build --watch into a scratch ARDIA_UI_DIR, runs an engine test instance on it
(scripts/linux/test-instance --engine, under xfwm4) and reloads the UI after each rebuild (ArdiaDev.reloadUi when the
engine has it, which closes the app windows first; a plain reload of the host otherwise). Ctrl+C stops both.
--engine defaults to $ARDIA_ENGINE or the Linux tree's out/Release_GN_linux_x64.`;

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const linux = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repo = resolve(linux, "../../..");
const engine = resolve(option("--engine", process.env.ARDIA_ENGINE ?? join(homedir(), "chromium-build-linux/chromium_git/chromium/src/out/Release_GN_linux_x64")));
const name = option("--name", "dev-engine");
const port = option("--port", "9333");
const display = option("--display", "133");
const ui = join(tmpdir(), `ardia-${name}`, "ui");
mkdirSync(ui, { recursive: true });

const vite = spawn("npx", ["vite", "build", "--watch", "--config", "renderer/vite.chromium.config.ts"], { cwd: linux, env: { ...process.env, ARDIA_UI_OUT: ui, ARDIA_LINUX_DEV: "1" }, stdio: ["ignore", "pipe", "inherit"] });
let instance = false;
let builds = 0;

const stopInstance = () => instance && spawnSync(join(repo, "scripts/linux/test-instance"), [name, "--stop"], { stdio: "inherit" });
const stop = () => {
  stopInstance();
  vite.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function reloadUi() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const host = targets.find((target) => target.url.startsWith("chrome://ardia-app/"));
  if (!host) return console.warn("dev-engine: no UI host to reload");
  const socket = new WebSocket(host.webSocketDebuggerUrl);
  await new Promise((done, fail) => (socket.addEventListener("open", done, { once: true }), socket.addEventListener("error", fail, { once: true })));
  const expression = `(() => { const linux = window.ardiaLinux; if (linux?.modules().ArdiaDev?.async.includes("reloadUi")) { void linux.call("ArdiaDev", "reloadUi", []); return "reloadUi"; } location.reload(); return "reload"; })()`;
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  await new Promise((done) => socket.addEventListener("message", done, { once: true }));
  socket.close();
}

vite.stdout.on("data", async (chunk) => {
  process.stdout.write(chunk);
  if (!/built in/.test(String(chunk)) || !existsSync(join(ui, "index.html"))) return;
  builds += 1;
  if (builds === 1) {
    const started = spawnSync(join(repo, "scripts/linux/test-instance"), [name, "--engine", engine, "--ui", ui, "--wm", "--port", port, "--display", display], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
    if (started.status !== 0) {
      console.error("dev-engine: the engine instance didn't start");
      return stop();
    }
    instance = true;
    console.log(`dev-engine: instance ${started.stdout.trim()} on :${display}, debugging port ${port}`);
    return;
  }
  await reloadUi().catch((error) => console.warn(`dev-engine: reload failed: ${error.message}`));
});
vite.on("exit", (code) => {
  stopInstance();
  process.exit(code ?? 0);
});
