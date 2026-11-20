import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { useShortcutHint, useShortcutHints } = await import("./commandShortcuts.ts");

const setShortcuts = (shortcuts) => useBrowser.setState((s) => ({ settings: { ...s.settings, shortcuts } }));

test("a shortcut hint follows a rebinding and ignores every other store update", () => {
  const before = useBrowser.getState().settings.shortcuts;
  try {
    const one = mount(() => useShortcutHint("closeTab"));
    const many = mount(() => useShortcutHints(["closeTab", "newTab"]));
    const shown = { one: one.renders, many: many.renders };
    useBrowser.setState((s) => ({ settings: { ...s.settings, showFullUrl: !s.settings.showFullUrl } }));
    useBrowser.setState((s) => ({ tabs: { ...s.tabs } }));
    assert.equal(one.renders, shown.one, "a settings change that leaves the shortcuts alone renders nothing");
    assert.equal(many.renders, shown.many);
    setShortcuts({ ...before, closeTab: ["t", "command"] });
    assert.equal(one.value, "⌘T");
    assert.equal(many.value.closeTab, "⌘T");
    assert.equal(many.value.newTab, undefined);
    one.unmount();
    many.unmount();
  } finally {
    setShortcuts(before);
  }
});

test("hint hooks hear only the shortcut settings and the profile order, not every browser-store update", () => {
  const source = readFileSync(new URL("./commandShortcuts.ts", import.meta.url), "utf8");
  const hooks = source.slice(source.indexOf("export function useShortcutHint("), source.indexOf("export const NAV_HINTS"));
  assert.ok(!hooks.includes("useBrowser(("), "no hint hook selects from the whole browser store");
  assert.match(hooks, /useBrowser\.subscribeTo\(\["settings", "profileOrder"\]/);
});
