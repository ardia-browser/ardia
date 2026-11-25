import assert from "node:assert/strict";
import { after, test } from "node:test";
const { formatShortcut, parseShortcut, resolveShortcuts } = await import("./shortcuts.ts");
const { useBrowser } = await import("../browser/store.ts");
const { menuState } = await import("./menuState.ts");
const { setMouseShortcut, setShortcutOverride } = await import("../settings/actions.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");
const { noteMouseShortcutRun, takeMouseShortcutCounts } = await import("../telemetry/mouseShortcutCounts.ts");
await import("../../test-native/index.ts");
const client = await import("../telemetry/client.ts");
after(() => client.setSharing(false, "settings"));

const source = (id, ...keys) => ({ id, keys: keys.map(parseShortcut) });
const menu = [
  source("newTab", "⌘T"),
  source("closeTab", "⌘W"),
  source("goBack", "⌘["),
  source("duplicateTab"),
  { id: "system:Window > Bring All to Front", keys: [parseShortcut("⌥⌘B")], fixed: true },
];
const S = () => useBrowser.getState();

test("a mouse button is named plainly, with modifiers written as for keys", () => {
  assert.equal(formatShortcut({ key: "mouse:middle", modifiers: [] }), "Middle Click");
  assert.equal(formatShortcut({ key: "mouse:4", modifiers: [] }), "Mouse Button 4");
  assert.equal(formatShortcut({ key: "mouse:5", modifiers: ["shift", "command"] }), "⇧⌘ Mouse Button 5");
});

test("Middle Click for Close Tab keeps ⌘W and takes nothing from other commands", () => {
  const resolved = resolveShortcuts(menu, {}, undefined, { closeTab: ["mouse:middle"] });
  assert.deepEqual(resolved.bindings.get("closeTab").map(formatShortcut), ["⌘W"]);
  assert.equal(formatShortcut(resolved.mouse.get("closeTab")), "Middle Click");
  assert.deepEqual(resolved.holdersOf({ key: "mouse:middle", modifiers: [] }), ["closeTab"]);
  assert.deepEqual(resolved.conflictsOf("closeTab"), []);
});

test("two commands on the same button conflict, and the same button with a modifier does not", () => {
  const same = resolveShortcuts(menu, {}, undefined, { closeTab: ["mouse:middle"], duplicateTab: ["mouse:middle"] });
  assert.deepEqual(same.conflictsOf("closeTab"), ["duplicateTab"]);
  assert.deepEqual(same.conflictsOf("duplicateTab"), ["closeTab"]);
  const apart = resolveShortcuts(menu, {}, undefined, { closeTab: ["mouse:middle"], duplicateTab: ["mouse:middle", "command"] });
  assert.deepEqual(apart.conflictsOf("closeTab"), []);
});

test("a mouse binding only takes a mouse button, and never a fixed or unknown command", () => {
  const resolved = resolveShortcuts(menu, {}, undefined, {
    newTab: ["t", "command"],
    "system:Window > Bring All to Front": ["mouse:4"],
    gone: ["mouse:5"],
    goBack: ["mouse:4"],
  });
  assert.deepEqual([...resolved.mouse.keys()], ["goBack"]);
  assert.deepEqual(resolved.bindings.get("newTab").map(formatShortcut), ["⌘T"]);
});

test("the menu state carries mouse bindings apart from key equivalents, and none when unset", () => {
  S().hydrate({});
  S().createWindow({ url: "https://a.com/" });
  assert.deepEqual(menuState(S()).mouseShortcuts, {});
  const keysBefore = JSON.stringify(menuState(S()).shortcuts);
  setMouseShortcut("closeTab", { key: "mouse:middle", modifiers: ["option"] });
  assert.deepEqual(menuState(S()).mouseShortcuts, { closeTab: ["mouse:middle", "option"] });
  assert.equal(JSON.stringify(menuState(S()).shortcuts), keysBefore);
  setShortcutOverride("closeTab", { key: "", modifiers: [] });
  assert.deepEqual(menuState(S()).shortcuts.closeTab, []);
  assert.deepEqual(menuState(S()).mouseShortcuts, { closeTab: ["mouse:middle", "option"] });
  setMouseShortcut("closeTab", null);
  assert.deepEqual(menuState(S()).mouseShortcuts, {});
  assert.deepEqual(S().settings.mouseShortcuts, {});
});

test("only the first of two commands on one button reaches the native table, and fn is never part of a button", () => {
  S().hydrate({});
  S().createWindow({ url: "https://a.com/" });
  setMouseShortcut("newTab", { key: "mouse:middle", modifiers: [] });
  setMouseShortcut("closeTab", { key: "mouse:middle", modifiers: [] });
  const sent = menuState(S()).mouseShortcuts;
  assert.equal(Object.keys(sent).length, 1);
  const resolved = resolveShortcuts(menu, {}, undefined, { closeTab: ["mouse:middle", "function"], duplicateTab: ["mouse:middle"] });
  assert.deepEqual(resolved.conflictsOf("closeTab"), ["duplicateTab"]);
  assert.equal(formatShortcut(resolved.mouse.get("closeTab")), "Middle Click");
  S().updateSettings({ mouseShortcuts: {} });
});

test("the daily snapshot counts commands with a mouse button, and the hourly count is by button only, with consent", async () => {
  assert.equal(settingsSnapshot({ shortcuts: {}, mouseShortcuts: {} }).custom_mouse_shortcuts, "0");
  assert.equal(settingsSnapshot({ shortcuts: {}, mouseShortcuts: { closeTab: ["mouse:middle"], goBack: ["mouse:4", "command"] } }).custom_mouse_shortcuts, "2");
  noteMouseShortcutRun("middle", null);
  assert.equal(takeMouseShortcutCounts().mouse_shortcut_runs_middle, 0, "not counted without a consent token");
  await client.setSharing(true, "onboarding");
  const consent = client.consentToken();
  noteMouseShortcutRun("middle", consent);
  noteMouseShortcutRun("middle", consent);
  noteMouseShortcutRun("button5", consent);
  noteMouseShortcutRun("closeTab", consent);
  assert.deepEqual(takeMouseShortcutCounts(), { mouse_shortcut_runs_middle: 2, mouse_shortcut_runs_button4: 0, mouse_shortcut_runs_button5: 1 });
  assert.deepEqual(takeMouseShortcutCounts(), { mouse_shortcut_runs_middle: 0, mouse_shortcut_runs_button4: 0, mouse_shortcut_runs_button5: 0 });
});
