import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../../../", import.meta.url));

const featuresOf = (platform) => `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  return resolved.url.endsWith("/lib/platformFeatures.ts") ? { ...resolved, url: resolved.url.replace(/platformFeatures\\.ts$/, "platformFeatures.${platform}.ts") } : resolved;
} });`;

const IN_THE_WEB_DEMO = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  return resolved.url.endsWith("/platform/webDemo.ts") ? { ...resolved, url: "data:text/javascript," + encodeURIComponent("export const isWebDemo = true; export const requestAppDownload = () => {};") } : resolved;
} });`;

const ENTRY_POINTS = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { UNAVAILABLE_COMMANDS } = await import("./src/state/commands/commandCatalog.ts");
const { barActions } = await import("./src/state/omnibox/barActions.ts");
const { automationCommands } = await import("./src/state/automation/automationCommands.ts");
const { menuState } = await import("./src/state/commands/menuState.ts");
const { resolvedShortcuts, setMenuBarShortcuts } = await import("./src/state/commands/commandShortcuts.ts");
const { runCaptureCommand, useCapture } = await import("./src/state/capture/capture.ts");
const S = () => useBrowser.getState();
S().hydrate({});
const w = S().createWindow({ url: "https://a.example/" });
S().updateTab(S().windows[w].tabIds[0], { url: "https://a.example/" });
setMenuBarShortcuts([{ id: "capture", key: "2", modifiers: ["shift", "command"], remappable: true }]);
runCaptureCommand("capture", w);
console.log(JSON.stringify({
  unavailable: UNAVAILABLE_COMMANDS.has("capture"),
  bar: barActions(S(), w).some((a) => a.id === "capture"),
  cli: automationCommands().some((c) => c.id === "capture"),
  menuDisabled: menuState(S()).disabled.includes("capture"),
  shortcut: resolvedShortcuts(S()).bindings.has("capture"),
  starts: useCapture.getState().windowId === w,
}));
`;

function entryPoints(...hooks) {
  const imports = hooks.flatMap((hook) => ["--import", `data:text/javascript,${encodeURIComponent(hook)}`]);
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", ...imports, "--input-type=module", "-e", ENTRY_POINTS], { cwd: APP, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
}

const OFFERED = { unavailable: false, bar: true, cli: true, menuDisabled: false, shortcut: true, starts: true };
const NOWHERE = { unavailable: true, bar: false, cli: false, menuDisabled: true, shortcut: false, starts: false };

test("on the Mac Capture is in the menu, the command bar, the ardia command and its shortcut, and starts", () => {
  assert.deepEqual(entryPoints(), OFFERED);
});

test("on Windows, Linux and the web demo, which can't copy an area, Capture is offered nowhere and its key starts nothing", () => {
  assert.deepEqual(entryPoints(featuresOf("windows")), NOWHERE);
  assert.deepEqual(entryPoints(featuresOf("linux")), NOWHERE);
  assert.deepEqual(entryPoints(IN_THE_WEB_DEMO), NOWHERE);
});
