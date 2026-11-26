import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { resolvedShortcuts } = await import("../commands/commandShortcuts.ts");
const { applyRecordedShortcut, clearShortcut } = await import("./recordedShortcut.ts");
const { conflictMessage, conflictTitles } = await import("../commands/shortcutConflicts.ts");

const S = () => useBrowser.getState();
const resolved = () => resolvedShortcuts(S());
const autoHide = { id: "toggleSidebar", remappable: true, mouseBindable: true };

test("recording the shortcut a command already has changes nothing and isn't counted", () => {
  S().hydrate({});
  assert.equal(applyRecordedShortcut(autoHide, { key: "s", modifiers: ["command"] }), null);
  assert.deepEqual(S().settings.shortcuts, {});
  assert.equal(applyRecordedShortcut(autoHide, { key: "j", modifiers: ["command", "option"] }), "changed");
  assert.deepEqual(S().settings.shortcuts.toggleSidebar, ["j", "command", "option"]);
  assert.equal(applyRecordedShortcut(autoHide, { key: "j", modifiers: ["command", "option"] }), null);
  assert.equal(applyRecordedShortcut(autoHide, { key: "s", modifiers: ["command"] }), "changed");
  assert.equal(S().settings.shortcuts.toggleSidebar, undefined, "going back to the default drops the override");
  assert.equal(applyRecordedShortcut(autoHide, null), null);
  assert.equal(applyRecordedShortcut(autoHide, undefined), null);
});

test("removing the shortcut counts once, and removing it again changes nothing", () => {
  S().hydrate({});
  assert.equal(clearShortcut(autoHide), "cleared");
  assert.equal(resolved().bindings.get("toggleSidebar")?.length, 0);
  assert.equal(clearShortcut(autoHide), null);
});

test("a chord another command holds is named as a conflict on the Auto-hide tabs row", () => {
  S().hydrate({});
  const items = [
    { id: "newTab", title: "New Tab" },
    { id: "toggleSidebar", title: "Auto-Hide Tabs" },
  ];
  assert.deepEqual(conflictTitles(resolved(), items, "toggleSidebar"), []);
  S().updateSettings({ shortcuts: { newTab: ["j", "control"], toggleSidebar: ["j", "control"] } });
  assert.deepEqual(conflictTitles(resolved(), items, "toggleSidebar"), ["New Tab"]);
  assert.equal(conflictMessage(["New Tab"]), "This shortcut conflicts with another shortcut: New Tab");
  assert.equal(conflictMessage(["New Tab", "Print…"]), "This shortcut conflicts with other shortcuts: New Tab, Print…");
});

test("recording the fallback chord Auto-hide tabs shows saves it, so resetting the command that took ⌘S doesn't take it back", () => {
  S().hydrate({});
  S().updateSettings({ shortcuts: { print: ["s", "command"] } });
  const fallback = resolved().bindings.get("toggleSidebar")?.[0];
  assert.ok(fallback && !(fallback.key === "s" && fallback.modifiers.join() === "command"), "Print took ⌘S, so Auto-Hide Tabs shows its next default");
  assert.equal(applyRecordedShortcut(autoHide, fallback), "changed");
  const { print: _, ...rest } = S().settings.shortcuts;
  S().updateSettings({ shortcuts: rest });
  assert.deepEqual(resolved().bindings.get("toggleSidebar")?.[0], fallback, "resetting Print pulled Auto-Hide Tabs back to ⌘S");
  assert.equal(applyRecordedShortcut(autoHide, fallback), null, "recording the saved shortcut again is no change");
});

test("recording the default chord while another command holds it keeps it as an explicit, visible conflict", () => {
  S().hydrate({});
  S().updateSettings({ shortcuts: { print: ["s", "command"] } });
  assert.equal(applyRecordedShortcut(autoHide, { key: "s", modifiers: ["command"] }), "changed");
  assert.deepEqual(S().settings.shortcuts.toggleSidebar, ["s", "command"]);
  assert.deepEqual(resolved().conflictsOf("toggleSidebar"), ["print"]);
});

test("recording a cleared command's default chord gives the default back", () => {
  S().hydrate({});
  assert.equal(clearShortcut(autoHide), "cleared");
  assert.equal(applyRecordedShortcut(autoHide, { key: "s", modifiers: ["command"] }), "changed");
  assert.equal(S().settings.shortcuts.toggleSidebar, undefined);
  assert.equal(resolved().bindings.get("toggleSidebar")?.[0]?.key, "s");
});

test("a chord another command takes while the recorder waits is saved as an explicit conflict, read when the recording lands", () => {
  S().hydrate({});
  const shownWhenRecordingStarted = resolved().bindings.get("toggleSidebar")?.[0];
  S().updateSettings({ shortcuts: { print: ["s", "command"] } });
  assert.equal(applyRecordedShortcut(autoHide, shownWhenRecordingStarted), "changed");
  assert.deepEqual(S().settings.shortcuts.toggleSidebar, ["s", "command"]);
  assert.deepEqual(resolved().conflictsOf("toggleSidebar"), ["print"]);
});
