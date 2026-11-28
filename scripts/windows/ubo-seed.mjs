#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ArdiaApp } from "../../apps/desktop/scripts/acceptance/lib/ardia.mjs";
import { until } from "../../apps/desktop/scripts/acceptance/lib/util.mjs";
import { seed } from "../linux/ubo-seed.mjs";
import { UBO_SEED, uboSeedProblems } from "../linux/smoke.mjs";

const USAGE = `usage: node scripts/windows/ubo-seed.mjs --app DIR [--check] [--timeout-ms N]

Seeds the uBlock Origin an assembled WebUI build carries in DIR\\extensions\\ublock,
so a new profile filters from its first page: scripts/linux/ubo-seed.mjs's seed,
run on DIR's chrome.exe (or Ardia.exe) as a hidden test instance on a scratch
data folder. DIR must carry the Ardia.test-build marker while it runs;
assemble-webui.ps1 adds it for the seed and takes it away after. --check only
reports what the Linux smoke test would find wrong with DIR's seed.

  --app DIR         the assembled WebUI build
  --check           check DIR's seed instead of making one
  --timeout-ms N    deadline for uBlock Origin to save its engine (default 240000)`;

const TEST_MARKER = "Ardia.test-build";
const LAUNCHERS = ["chrome.exe", "Ardia.exe"];

function testInstanceLauncher(app) {
  const executable = LAUNCHERS.map((name) => join(app, name)).find((path) => existsSync(path));
  if (!executable) throw new Error(`${app} has no ${LAUNCHERS.join(" or ")} to seed with`);
  if (!existsSync(join(app, TEST_MARKER))) throw new Error(`${app} needs the ${TEST_MARKER} marker for the engine to start it as a test instance`);
  return executable;
}

export function windowsLaunchPlan({ app, scratch, blocker }) {
  const executable = testInstanceLauncher(app);
  const env = { ...process.env, ARDIA_DATA_DIR: scratch, ARDIA_REMOTE_DEBUGGING_PORT: "0", ARDIA_BACKGROUND: "1" };
  delete env.ARDIA_TRACE;
  return {
    executable,
    args: ["--ardia-shell=webui", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--lang=en-US", `--ardia-content-blocker-dir=${blocker}`],
    env,
    portFile: join(scratch, "Chromium", "DevToolsActivePort"),
  };
}

class WindowsArdiaApp extends ArdiaApp {
  async close({ timeout = 10000 } = {}) {
    if (!this.exited) spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await Promise.race([this.whenExited, new Promise((done) => setTimeout(done, timeout))]);
    return this.exited;
  }
}

function windowsLauncher(app, blocker) {
  return async ({ scratch }) => {
    const plan = windowsLaunchPlan({ app, scratch, blocker });
    await rm(plan.portFile, { force: true });
    const logPath = join(scratch, `ubo-seed-${Date.now()}.log`);
    const log = openSync(logPath, "w");
    const child = spawn(plan.executable, plan.args, { stdio: ["ignore", log, log], env: plan.env, windowsHide: true });
    closeSync(log);
    const instance = new WindowsArdiaApp({ child, scratch, logPath, label: "ubo-seed" });
    try {
      const active = await until(() => readFile(plan.portFile, "utf8").then((text) => text.includes("\n") && text), { timeout: 60000, label: "DevToolsActivePort", abort: () => instance.exitReason() });
      instance.port = Number(active.trim().split("\n")[0]);
      return instance;
    } catch (error) {
      await instance.close();
      throw new Error(`${error.message}; log: ${logPath}`);
    }
  };
}

export async function seededProblems(blocker) {
  const read = (path) => readFile(join(blocker, path), "utf8").catch(() => null);
  const [seedText, start, storage] = await Promise.all([read(UBO_SEED), read("js/start.js"), read("js/storage.js")]);
  return uboSeedProblems(seedText, start ?? "", storage ?? "");
}

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "-h" || name === "--help") return { help: true };
    if (name === "--check") { options.check = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--app") options.app = resolve(value);
    else if (name === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new Error(`unknown option ${name}`);
  }
  if (!options.app) throw new Error("--app is required");
  if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) throw new Error("--timeout-ms must be a positive number");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(64);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const blocker = join(options.app, "extensions", "ublock");
  try {
    if (options.check) {
      const problems = await seededProblems(blocker);
      console.log(problems.length ? problems.join("; ") : "seeded");
      process.exit(problems.length ? 1 : 0);
    }
    testInstanceLauncher(options.app);
    console.log(await seed({ blocker, timeoutMs: options.timeoutMs, launch: windowsLauncher(options.app, blocker) }));
    process.exit(0);
  } catch (error) {
    console.error(`ubo-seed: ${error.message}`);
    process.exit(1);
  }
}
