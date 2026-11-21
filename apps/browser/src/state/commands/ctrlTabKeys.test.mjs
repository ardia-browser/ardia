import assert from "node:assert/strict";
import { test } from "node:test";
const { resolveShortcuts, formatShortcut, parseShortcut } = await import("./shortcuts.ts");
const { staticShortcutSources } = await import("./commandCatalog.ts");
const { ctrlTabChoiceOf, ctrlTabCombos, ctrlTabCustomTarget, ctrlTabOverrides } = await import("./ctrlTabKeys.ts");
const { ctrlTabCustomQuery } = await import("./commandShortcuts.ts");
const { parseWindowsShortcut, windowsDefaultKeys, windowsModifiers, formatWindowsShortcut } = await import("./windowsKeys.ts");

const macSources = staticShortcutSources();
const mac = (overrides) => resolveShortcuts(macSources, overrides);
const hints = (resolved, id) => (resolved.bindings.get(id) ?? []).map(formatShortcut);
const SWITCHER = { "tabSwitcher:forward": ["\t", "control"], "tabSwitcher:backward": ["\t", "control", "shift"] };

const pick = (overrides, preset, resolve = mac) => ctrlTabOverrides(overrides, ctrlTabCombos(resolve(overrides)), preset, resolve(overrides).defaultsOf);

test("the defaults step through tabs: ⌃⇥ is Next Tab and ⌃⇧⇥ Previous Tab", () => {
  assert.equal(ctrlTabChoiceOf(mac({})), "step");
  assert.ok(hints(mac({}), "nextTab").includes("⌃⇥"));
  assert.deepEqual(hints(mac({}), "tabSwitcher:forward"), []);
});

test("⌃⇥ and ⌃⇧⇥ on the tab switcher read as the recent tabs switcher, and Next Tab keeps its other keys", () => {
  const resolved = mac(SWITCHER);
  assert.equal(ctrlTabChoiceOf(resolved), "switcher");
  assert.ok(!hints(resolved, "nextTab").includes("⌃⇥"));
  assert.ok(hints(resolved, "nextTab").includes("⇧⌘]"));
});

test("anything else is custom: one direction only, a key of your own on Next Tab, or ⌃⇥ set for another command", () => {
  assert.equal(ctrlTabChoiceOf(mac({ "tabSwitcher:forward": ["\t", "control"] })), "custom");
  assert.equal(ctrlTabChoiceOf(mac({ nextTab: ["j", "command"] })), "custom");
  assert.equal(ctrlTabChoiceOf(mac({ newTab: ["\t", "control"] })), "custom");
  assert.equal(ctrlTabChoiceOf(mac({ ...SWITCHER, duplicateTab: ["\t", "control"] })), "custom");
  assert.equal(ctrlTabChoiceOf(mac({ nextTab: [""] })), "custom");
});

test("picking the switcher binds both directions and keeps your unrelated shortcuts", () => {
  const next = pick({ closeTab: ["t", "command"] }, "switcher");
  assert.deepEqual(next, { closeTab: ["t", "command"], ...SWITCHER });
  assert.equal(ctrlTabChoiceOf(mac(next)), "switcher");
});

test("picking step through tabs undoes the switcher and keeps the switcher's own other keys", () => {
  assert.deepEqual(pick(SWITCHER, "step"), {});
  const own = { "tabSwitcher:forward": ["\t", "option"] };
  assert.deepEqual(pick({ ...own, "tabSwitcher:backward": ["\t", "control", "shift"] }, "step"), own);
  assert.equal(ctrlTabChoiceOf(mac(pick(SWITCHER, "step"))), "step");
});

test("only the press takes ⌃⇥ from another command or a custom Next Tab, so the picked card is what you get", () => {
  const custom = { newTab: ["\t", "control"], nextTab: ["j", "command"], closeTab: ["w", "command"] };
  assert.equal(ctrlTabChoiceOf(mac(custom)), "custom");
  const stepped = pick(custom, "step");
  assert.deepEqual(stepped, { closeTab: ["w", "command"] });
  assert.equal(ctrlTabChoiceOf(mac(stepped)), "step");
  const switched = pick(custom, "switcher");
  assert.deepEqual(switched, { nextTab: ["j", "command"], closeTab: ["w", "command"], ...SWITCHER });
  assert.equal(ctrlTabChoiceOf(mac(switched)), "switcher");
});

test("picking is idempotent", () => {
  assert.deepEqual(pick(pick({}, "switcher"), "switcher"), SWITCHER);
  assert.deepEqual(pick(pick({}, "step"), "step"), {});
});

const windowsSources = macSources.map((source) => ({ ...source, keys: windowsDefaultKeys(source.id).map(parseWindowsShortcut) }));
const windows = (overrides) => resolveShortcuts(windowsSources, overrides, windowsModifiers);

test("on Windows the same presets use Ctrl+Tab and Ctrl+Shift+Tab", () => {
  const combos = ctrlTabCombos(windows({}));
  assert.equal(formatWindowsShortcut(combos.forward), "Ctrl+Tab");
  assert.equal(formatWindowsShortcut(combos.backward), "Ctrl+Shift+Tab");
  assert.equal(ctrlTabChoiceOf(windows({})), "step");
  const switched = pick({}, "switcher", windows);
  assert.equal(ctrlTabChoiceOf(windows(switched)), "switcher");
  assert.equal(ctrlTabChoiceOf(windows(pick(switched, "step", windows))), "step");
});

const LINUX_KEYS = { nextTab: ["⇧⌘]", "⌘⇟", "⌥⌘↓"], previousTab: ["⇧⌘[", "⌘⇞", "⌥⌘↑"], "tabSwitcher:forward": ["⌘⇥"], "tabSwitcher:backward": ["⇧⌘⇥"] };
const linuxSources = macSources.map((source) => (LINUX_KEYS[source.id] ? { ...source, keys: LINUX_KEYS[source.id].map(parseShortcut) } : source));
const linux = (overrides) => resolveShortcuts(linuxSources, overrides);

test("on Linux, where Ctrl+Tab opens the switcher by default and Ctrl is stored as command, both cards work", () => {
  assert.equal(ctrlTabChoiceOf(linux({})), "switcher");
  const stepped = pick({}, "step", linux);
  assert.deepEqual(stepped, { nextTab: ["\t", "command"], previousTab: ["\t", "shift", "command"] });
  assert.equal(ctrlTabChoiceOf(linux(stepped)), "step");
  assert.deepEqual(pick(stepped, "switcher", linux), {});
  assert.equal(ctrlTabChoiceOf(linux(pick(stepped, "switcher", linux))), "switcher");
});

test("Show in Shortcuts searches for the chord that differs from both cards", () => {
  assert.equal(formatShortcut(ctrlTabCustomTarget(mac({ "tabSwitcher:backward": ["\t", "control", "shift"] })).combo), "⌃⇧⇥");
  assert.equal(formatShortcut(ctrlTabCustomTarget(mac({ newTab: ["\t", "control"] })).combo), "⌃⇥");
});

test("with Next Tab cleared, no command holds ⌃⇥, so Show in Shortcuts searches for Next Tab by name", () => {
  assert.deepEqual(ctrlTabCustomTarget(mac({ nextTab: [""] })), { command: "nextTab" });
  assert.deepEqual(ctrlTabCustomTarget(linux({ "tabSwitcher:forward": [""] })), { command: "tabSwitcher:forward" });
  assert.equal(ctrlTabCustomQuery({ settings: { shortcuts: { nextTab: [""] } }, profileOrder: [] }), "Next Tab");
});
