import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seed } from "../linux/ubo-seed.mjs";
import { windowsLaunchPlan } from "./ubo-seed.mjs";

async function scratchFolder(t) {
  const folder = await mkdtemp(join(tmpdir(), "ardia-windows-seed-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function app(t, files) {
  const folder = await scratchFolder(t);
  for (const name of files) await writeFile(join(folder, name), "");
  return folder;
}

test("the Windows seed starts the assembled WebUI build as a hidden test instance on its own data folder", async (t) => {
  const folder = await app(t, ["Ardia.exe", "chrome.dll", "Ardia.test-build"]);
  const plan = windowsLaunchPlan({ app: folder, scratch: "C:\\scratch\\seed", blocker: "C:\\out\\extensions\\ublock" });
  assert.equal(plan.executable, join(folder, "Ardia.exe"));
  for (const arg of ["--ardia-shell=webui", "--ardia-content-blocker-dir=C:\\out\\extensions\\ublock", "--lang=en-US", "--no-first-run"]) {
    assert.ok(plan.args.includes(arg), `the seed passes ${arg}`);
  }
  assert.equal(plan.env.ARDIA_DATA_DIR, "C:\\scratch\\seed");
  assert.equal(plan.env.ARDIA_REMOTE_DEBUGGING_PORT, "0");
  assert.equal(plan.env.ARDIA_BACKGROUND, "1");
  assert.equal(plan.portFile, join("C:\\scratch\\seed", "Chromium", "DevToolsActivePort"));
});

test("the Windows seed starts chrome.exe when the build is not renamed yet", async (t) => {
  const folder = await app(t, ["chrome.exe", "chrome.dll", "Ardia.test-build"]);
  assert.equal(windowsLaunchPlan({ app: folder, scratch: "C:\\s", blocker: "C:\\b" }).executable, join(folder, "chrome.exe"));
});

test("the Windows seed refuses a build the engine would not treat as a test instance, or one with no launcher", async (t) => {
  const unmarked = await app(t, ["Ardia.exe", "chrome.dll"]);
  assert.throws(() => windowsLaunchPlan({ app: unmarked, scratch: "C:\\s", blocker: "C:\\b" }), /Ardia\.test-build/);
  const empty = await app(t, ["Ardia.test-build"]);
  assert.throws(() => windowsLaunchPlan({ app: empty, scratch: "C:\\s", blocker: "C:\\b" }), /no chrome\.exe or Ardia\.exe/);
});

test("the shared seed runs on the launcher its platform hands it", async (t) => {
  const blocker = await scratchFolder(t);
  await mkdir(join(blocker, "js"), { recursive: true });
  await mkdir(join(blocker, "assets"), { recursive: true });
  await writeFile(join(blocker, "js", "start.js"), "µb.isReadyPromise = (async function start() {\n    try {\n        go();\n");
  await writeFile(join(blocker, "js", "storage.js"), ["Main", "NetFilteringEngine", "ExtFilteringEngine"].map((part) => `io.toCache('selfie/staticArdia2${part}',`).join("\n"));
  await writeFile(join(blocker, "assets", "assets.json"), "{}");
  let handed = null;
  await assert.rejects(seed({ blocker, timeoutMs: 1000, log: () => {}, launch: async (options) => { handed = options; throw new Error("the Windows launcher ran"); } }), /the Windows launcher ran/);
  assert.ok(handed.scratch, "the launcher gets the seed's scratch folder");
  assert.ok(handed.extraArgs.includes(`--ardia-content-blocker-dir=${blocker}`), "the launcher gets the same options the Linux launch does");
  assert.match(await readFile(join(blocker, "js", "start.js"), "utf8"), /ardiaSeedFromPackage/);
});
