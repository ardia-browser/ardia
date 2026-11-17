import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const ts = createRequire(import.meta.url)("typescript");
const source = readFileSync(new URL("../../../../packages/expo-windows/src/index.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function boot(selfCheck) {
  const loaded = [];
  const initialized = [];
  const scheduled = [];
  let checks = 0;
  let closes = 0;
  const component = (name) => () => initialized.push(name);
  const modules = {
    "react-native": { TurboModuleRegistry: { getEnforcing: () => ({ getConstants: () => ({ selfCheck }) }) } },
    "./animation": { installAnimation: component("animation") },
    "./engine/relaunch": { watchRelaunches: component("relaunch") },
    "./launchLinks": { openLaunchLinks: component("links") },
    "./modules": { requireNativeModule: () => ({}), requireOptionalNativeModule: () => null },
    "./textFocus": { installTextFocusReport: component("focus") },
    "./updater": { startUpdateChecks: component("updates") },
    "./views/registry": { viewNamed: () => null },
    "./windowRoot": { installWindowRoot: component("windows") },
    "./events": { emitNativeEvent: () => {} },
    "./missing": { missingOnWindows: () => {} },
    "./selfCheck": { runSelfCheck: async () => { checks++; } },
    "./selfCheck/lastWindow": { endByClosingTheLastWindow: () => { closes++; } },
  };
  new Function("require", "exports", "setTimeout", javascript)((name) => {
    loaded.push(name);
    assert.ok(name in modules, name);
    return modules[name];
  }, {}, (run, ms) => scheduled.push({ run, ms }));
  return { loaded, initialized, scheduled, counts: () => ({ checks, closes }) };
}

test("normal Windows startup initializes the app without loading self-check suites", () => {
  const app = boot(false);
  assert.deepEqual(app.initialized, ["animation", "windows", "focus", "relaunch", "links", "updates"]);
  assert.ok(!app.loaded.some((name) => name.startsWith("./selfCheck")));
  assert.deepEqual(app.scheduled, []);
});

test("an explicit self-check launch defers suites then runs checks and closes its last window", async () => {
  const app = boot(true);
  assert.ok(!app.loaded.some((name) => name.startsWith("./selfCheck")));
  assert.equal(app.scheduled.length, 1);
  assert.equal(app.scheduled[0].ms, 4000);
  app.scheduled[0].run();
  await Promise.resolve();
  assert.deepEqual(app.counts(), { checks: 1, closes: 1 });
  assert.deepEqual(app.loaded.filter((name) => name.startsWith("./selfCheck")), ["./selfCheck", "./selfCheck/lastWindow"]);
});
