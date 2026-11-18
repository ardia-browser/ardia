import assert from "node:assert/strict";
import { test } from "node:test";
const mac = await import("./platformTerms.ts");
const windows = await import("./platformTerms.windows.ts");
const macFeatures = (await import("./platformFeatures.ts")).PLATFORM_FEATURES;
const windowsFeatures = (await import("./platformFeatures.windows.ts")).PLATFORM_FEATURES;

test("the OS ids keep the Mac's macos report key and darwin os.type, and name Windows on Windows", () => {
  assert.deepEqual(mac.PLATFORM_IDS, { report: "macos", otel: "darwin" });
  assert.deepEqual(windows.PLATFORM_IDS, { report: "windows_os", otel: "windows" });
});

test("only the Mac reports memory pressure", () => {
  assert.equal(macFeatures.memoryPressure, true);
  assert.equal(windowsFeatures.memoryPressure, false);
});

test("a pop-up button looks like its platform's: the Mac's accent box with two chevrons, Windows's single chevron, and on Windows it is never narrower than its title", async () => {
  const macChrome = await import("./platformChrome.ts");
  const windowsChrome = await import("./platformChrome.windows.ts");
  assert.deepEqual(macChrome.POP_UP_CHROME, { indicator: "accentUpDown", growsToItsTitle: false });
  assert.deepEqual(windowsChrome.POP_UP_CHROME, { indicator: "chevronDown", growsToItsTitle: true });
  assert.deepEqual((await import("./platformChrome.linux.ts")).POP_UP_CHROME, macChrome.POP_UP_CHROME);
  const { vectorIcon } = await import("../../../../packages/expo-windows/src/symbol/layers.ts");
  assert.ok(vectorIcon("chevron.down", 8, "bold"), "Windows can draw the chevron");
  assert.ok(vectorIcon("chevron.down", 9, "semibold"), "Windows can draw the chevron of a Settings pop-up");
});

test("every Settings pane's icon is one Windows can draw", async () => {
  const { PANES } = await import("../components/settings/settingsIndex.ts");
  const { vectorIcon } = await import("../../../../packages/expo-windows/src/symbol/layers.ts");
  assert.ok(PANES.length >= 7);
  assert.deepEqual(PANES.filter((pane) => !vectorIcon(pane.icon, 13, "semibold")).map((pane) => pane.icon), []);
});

test("Windows draws the Plugins pane's filled puzzle piece", async () => {
  const { vectorIcon } = await import("../../../../packages/expo-windows/src/symbol/layers.ts");
  assert.ok(vectorIcon("puzzlepiece.fill", 13, "semibold"));
});
