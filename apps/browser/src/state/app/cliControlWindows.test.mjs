import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const setTimeoutHoldingExit = globalThis.setTimeout;
let upgradeTimer;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms === 8000) {
    upgradeTimer = callback;
    return 0;
  }
  const timer = setTimeoutHoldingExit(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};

globalThis.__DEV__ = false;
const windowsModules = new URL("../../../../../packages/expo-windows/src/modules.ts", import.meta.url).href;
const fakeModules = new URL("../../test-native/expo.ts", import.meta.url).href;
const cliOnWindows = new URL("./cliOnWindows.virtual.mjs", import.meta.url).href;
const cliOnWindowsSource = `
import { requireNativeModule as onWindows } from ${JSON.stringify(windowsModules)};
import { requireNativeModule as fake } from ${JSON.stringify(fakeModules)};
export const requireNativeModule = (name) => (name === "ArdiaCli" ? onWindows(name) : fake(name));
`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "expo-modules-core" && context.parentURL?.endsWith("/packages/shell/src/nativeModules.ts")) return { url: cliOnWindows, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === cliOnWindows) return { format: "module", source: cliOnWindowsSource, shortCircuit: true };
    if (url.includes("/packages/expo-windows/") && url.endsWith(".json")) return next(url, { ...context, format: "json", importAttributes: { type: "json" } });
    return next(url, context);
  },
});

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
PLATFORM_FEATURES.plugins = false;
const { readDocument } = await import("../../platform/documents.ts");
const { firstWindowCommitted } = await import("../../lib/afterFirstWindow.ts");
const cli = await import("./cliControl.ts");
const settle = () => new Promise((resolve) => setImmediate(resolve));

cli.startCliControl();
firstWindowCommitted();
await new Promise((resolve) => setTimeoutHoldingExit(resolve, 5));
globalThis.setTimeout = setTimeoutHoldingExit;
assert.equal(typeof upgradeTimer, "function", "startCliControl schedules the first install 8 s after the first window");

const savedRecord = () => {
  const text = readDocument("ardia-cli.json");
  return text ? JSON.parse(text) : {};
};

test("8 s after launch on Windows no install is tried, so nothing rejects and no try is counted", async () => {
  upgradeTimer();
  await settle();
  await settle();
  assert.deepEqual(unhandled, []);
  assert.equal(savedRecord().autoInstallTries, undefined);
  assert.equal(cli.useCli.getState().installing, null);
});

test("Install in Settings says the ardia command isn't offered on Windows and doesn't stick on Installing", async () => {
  const result = await cli.installCliInBackground("settings");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /isn't offered on Windows/);
  const state = cli.useCli.getState();
  assert.equal(state.installing, null);
  assert.match(state.error ?? "", /isn't offered on Windows/);
  assert.deepEqual(unhandled, []);
});
