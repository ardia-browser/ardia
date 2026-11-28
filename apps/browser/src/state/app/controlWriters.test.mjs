import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const WRITERS = new Map([
  ["state/settings/settings.ts", "the setting's own spec"],
  ["state/app/programControlSetting.ts", "setControlByUser and setControlByApp"],
  ["state/plugins/lifecycle.ts", "approving a plugin that asks for control, the person's own choice"],
  ["state/automation/socketSettings.ts", "the socket's refusal to switch control"],
]);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test("cliControl is written only through a setter that says whether the person or the app chose it", () => {
  const strays = sources(SRC)
    .map((path) => relative(SRC, path).split("\\").join("/"))
    .filter((path) => !WRITERS.has(path) && /\bcliControl\s*:/.test(readFileSync(join(SRC, path), "utf8")));
  assert.deepEqual(strays, [], "write cliControl with setControlByUser (Settings, the pill's Stop) or setControlByApp (anything the app decides by itself)");
});

test("the setter for the app's own writes keeps the person's choice apart", async () => {
  await import("../../test-native/index.ts");
  const { useBrowser } = await import("../browser/store.ts");
  const control = await import("./programControlSetting.ts");
  useBrowser.getState().hydrate({});
  control.setControlByApp(true);
  control.setControlByApp(false);
  assert.equal(control.controlStoppedItself(), true);
  assert.equal(control.userTurnedControlOff(), false);
  control.setControlByUser(false);
  assert.equal(control.controlStoppedItself(), false);
  assert.equal(control.userTurnedControlOff(), true);
  control.setControlByUser(true);
  control.setControlByApp(false);
  assert.equal(control.userTurnedControlOff(), false, "an Off the app writes after the person's On is still the app's");
});
