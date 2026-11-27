import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const adapter = new URL("./shortcutState.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/commands/commandShortcuts") && context.parentURL?.endsWith("/state/settings/paneData.ts")) return { url: adapter, shortCircuit: true };
    return next(specifier, context);
  },
});

globalThis.__DEV__ = false;
const { shellNativeModules } = await import("../../browser/src/test-native/shell.ts");
const { cached, load } = await import("../../browser/src/state/settings/resources.ts");
const { noteMenuShortcuts, shortcutItems } = await import("../../browser/src/state/settings/paneData.ts");
const { menuBarRevision } = await import("../../browser/src/state/commands/commandShortcuts.ts");

const OFFERED = [{ id: "newTab", title: "New Tab", path: ["File"], remappable: true }];

test("the menu sync stores the shortcut list through the desktop adapter without the adapter storing it back forever", () => {
  const revision = menuBarRevision();
  noteMenuShortcuts(OFFERED, null);
  assert.ok(cached(shortcutItems, []).length > 0, "the Settings list holds the desktop's shortcuts");
  assert.ok(menuBarRevision() > revision, "the menu bar took the list");
});

test("a Settings read stores the shortcut list through the desktop adapter without the adapter storing it back forever", async () => {
  shellNativeModules.ArdiaMenus.menuShortcuts = () => Promise.resolve(OFFERED.map((item) => ({ ...item })));
  await load(shortcutItems, [], { fresh: true });
  assert.ok(cached(shortcutItems, []).length > 0, "the Settings list holds the desktop's shortcuts");
});
