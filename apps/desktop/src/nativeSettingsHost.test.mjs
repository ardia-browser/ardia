import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { desktopMode } from "../desktopModes.ts";

const APP = fileURLToPath(new URL("../", import.meta.url));
const LOADER = fileURLToPath(new URL("../scripts/host-test-loader.mjs", import.meta.url));
const MODE = desktopMode(process.env.ARDIA_DESKTOP_MODE ?? "linux");
const NO_WEBKIT_TWIN = `platformFeatures.${MODE}`;
const MODE_HAS_WEBKIT = !existsSync(new URL(`../../browser/src/lib/${NO_WEBKIT_TWIN}.ts`, import.meta.url));

const platformHook = (twin) => `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  return resolved.url.endsWith("/lib/platformFeatures.ts") ? { ...resolved, url: resolved.url.replace(/platformFeatures\\.ts$/, "${twin}.ts") } : resolved;
} });`;

const LAUNCH = `
const rejected = [];
process.on("unhandledRejection", (reason) => rejected.push(reason instanceof Error ? reason.message : String(reason)));
const routed = new Set(JSON.parse(process.env.ENGINE_ROUTES));
const calls = [];
const host = {
  bootstrap: { windowId: "w1", profileId: "default", capabilities: [] },
  invoke: async (method) => { throw new Error("Unknown host method " + method); },
  call: async (name, profile, args) => {
    calls.push([name, JSON.parse(args)]);
    if (!routed.has(name)) throw Object.assign(new Error("This call is unavailable on Linux"), { code: "ERR_UNKNOWN_CALL" });
    return "null";
  },
  onEvent: () => () => {},
};
const { resolveHostModule } = await import("./src/hostModules.ts");
globalThis.acTestNativeModules = { ArdiaWebKit: { call: resolveHostModule(host, "ArdiaWebKit", "call") } };
const { useBrowser } = await import("../browser/src/state/browser/store.ts");
const { startNativeSettings } = await import("../browser/src/state/settings/nativeSettings.ts");
const stop = startNativeSettings();
useBrowser.getState().updateSettings({ webKitFraudWarnings: true });
await new Promise((resolve) => setImmediate(resolve));
stop();
process.stdout.write(JSON.stringify({ calls: calls.filter(([name]) => name.startsWith("webKit.")), rejected }));
`;

function launch({ twin, routes }) {
  const hooks = twin ? ["--import", `data:text/javascript,${encodeURIComponent(platformHook(twin))}`] : [];
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", LOADER, ...hooks, "--input-type=module", "-e", LAUNCH], {
    cwd: APP,
    encoding: "utf8",
    env: { ...process.env, ARDIA_DESKTOP_MODE: MODE, ENGINE_ROUTES: JSON.stringify(routes) },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("launching where there is no WebKit sends no WebKit call, so the engine has nothing to reject", { skip: MODE_HAS_WEBKIT && `--mode ${MODE} runs on the Mac engine, which has WebKit` }, () => {
  const { calls, rejected } = launch({ twin: NO_WEBKIT_TWIN, routes: [] });
  assert.deepEqual(rejected, []);
  assert.deepEqual(calls, []);
});

test("launching with WebKit still sends the fraud-warning setting at start and when it changes", () => {
  const { calls, rejected } = launch({ routes: ["webKit.setFraudWarnings"] });
  assert.deepEqual(rejected, []);
  assert.deepEqual(calls, [["webKit.setFraudWarnings", { enabled: false }], ["webKit.setFraudWarnings", { enabled: true }]]);
});
