import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { shortcutHint } = await import("../commands/commandShortcuts.ts");
const { OUTRO_COMMANDS, outroShortcuts } = await import("./outroShortcuts.ts");

const S = () => useBrowser.getState();
const rows = () => outroShortcuts(Object.fromEntries(OUTRO_COMMANDS.map((id) => [id, shortcutHint(id, S())])));

test("onboarding's last page lists each shortcut as it is bound now, one row per command", () => {
  S().hydrate({});
  assert.deepEqual(
    rows().map((r) => [r.command, r.keys]),
    [
      ["newTab", shortcutHint("newTab", S())],
      ["focusCommandBar", shortcutHint("focusCommandBar", S())],
      ["toggleSidebar", shortcutHint("toggleSidebar", S())],
    ],
  );
  S().updateSettings({ shortcuts: { toggleSidebar: ["t", "command"] } });
  const rebound = rows();
  assert.deepEqual(rebound.map((r) => r.command), ["focusCommandBar", "toggleSidebar"], "New Tab lost ⌘T to Auto-Hide Tabs, so it has no row");
  assert.equal(new Set(rebound.map((r) => r.keys)).size, rebound.length);
  S().updateSettings({ shortcuts: { toggleSidebar: ["", ""] } });
  assert.deepEqual(rows().map((r) => r.command), ["newTab", "focusCommandBar"]);
});

test("two commands showing the same chord list it once, under the first", () => {
  assert.deepEqual(outroShortcuts({ newTab: "⌘J", focusCommandBar: "⌘L", toggleSidebar: "⌘J" }), [
    { command: "newTab", keys: "⌘J", label: "Open a new tab" },
    { command: "focusCommandBar", keys: "⌘L", label: "Go anywhere from the command bar" },
  ]);
});
