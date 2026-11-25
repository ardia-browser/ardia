import assert from "node:assert/strict";
import { test } from "node:test";
const { comboKey, formatShortcut, parseShortcut, resolveShortcuts } = await import("./shortcuts.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");

const source = (id, ...keys) => ({ id, keys: keys.map(parseShortcut) });
const menu = [
  source("newTab", "⌘T"),
  source("closeTab", "⌘W"),
  source("reopenClosedTab", "⇧⌘T"),
  source("toggleSidebar", "⌘S", "⇧⌘L"),
  source("duplicateTab"),
  { id: "system:Window > Bring All to Front", keys: [parseShortcut("⌥⌘B")], fixed: true },
];
const hints = (resolved, id) => (resolved.bindings.get(id) ?? []).map(formatShortcut);

test("binding Close Tab to ⌘T takes it from New Tab without a conflict", () => {
  const resolved = resolveShortcuts(menu, { closeTab: ["t", "command"] });
  assert.deepEqual(hints(resolved, "closeTab"), ["⌘T"]);
  assert.deepEqual(hints(resolved, "newTab"), []);
  assert.deepEqual(resolved.conflictsOf("closeTab"), []);
  assert.deepEqual(resolved.conflictsOf("newTab"), []);
});

test("two shortcuts you set to the same keys conflict", () => {
  const resolved = resolveShortcuts(menu, { closeTab: ["t", "command"], duplicateTab: ["t", "command"] });
  assert.deepEqual(resolved.conflictsOf("closeTab"), ["duplicateTab"]);
  assert.deepEqual(resolved.conflictsOf("duplicateTab"), ["closeTab"]);
  assert.deepEqual(hints(resolved, "newTab"), []);
});

test("an override whose menu item is gone takes nothing", () => {
  const resolved = resolveShortcuts(menu, { "switchSpace:deleted": ["t", "command"] });
  assert.deepEqual(hints(resolved, "newTab"), ["⌘T"]);
  assert.equal(resolved.bindings.has("switchSpace:deleted"), false);
});

test("a cleared shortcut has no keys and takes none", () => {
  const resolved = resolveShortcuts(menu, { newTab: [""] });
  assert.deepEqual(hints(resolved, "newTab"), []);
  assert.deepEqual(hints(resolved, "closeTab"), ["⌘W"]);
});

test("a taken alias goes and the rest of the defaults stay", () => {
  const resolved = resolveShortcuts(menu, { duplicateTab: ["l", "shift", "command"] });
  assert.deepEqual(hints(resolved, "toggleSidebar"), ["⌘S"]);
  assert.deepEqual(resolved.conflictsOf("duplicateTab"), []);
});

test("an override replaces every default of its own action", () => {
  const resolved = resolveShortcuts(menu, { toggleSidebar: ["e", "command"] });
  assert.deepEqual(hints(resolved, "toggleSidebar"), ["⌘E"]);
});

test("a fixed system item keeps its keys, so taking them is a conflict", () => {
  const resolved = resolveShortcuts(menu, { duplicateTab: ["b", "option", "command"] });
  assert.deepEqual(hints(resolved, "system:Window > Bring All to Front"), ["⌥⌘B"]);
  assert.deepEqual(resolved.conflictsOf("duplicateTab"), ["system:Window > Bring All to Front"]);
});

test("an uppercase key means shift, as in the menu bar", () => {
  assert.equal(comboKey({ key: "T", modifiers: ["command"] }), comboKey({ key: "t", modifiers: ["shift", "command"] }));
  const resolved = resolveShortcuts(menu, { closeTab: ["T", "command"] });
  assert.deepEqual(hints(resolved, "reopenClosedTab"), []);
});

test("shortcuts print the way Settings shows them and parse back", () => {
  for (const text of ["⌘T", "⇧⌘]", "⌥⇧⌘C", "⌃⇥", "⌘↩", "⇧⌘⌫", "⌃⇟", "F12", "⌃F5", "🌐F", "⌘+", "⌘,"]) {
    assert.equal(formatShortcut(parseShortcut(text)), text);
  }
  assert.deepEqual(parseShortcut("⇧⌘C"), { key: "c", modifiers: ["shift", "command"] });
});

test("Mac glyphs never read Object.prototype names as keys, and every valid Mac shortcut reads and prints as before", async () => {
  const { formatMacShortcut, parseMacShortcut } = await import("./macGlyphs.ts");
  for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    const parsed = parseMacShortcut(`⌘${name}`);
    assert.equal(typeof parsed.key, "string", name);
    assert.equal(typeof formatMacShortcut(parsed), "string", name);
  }
  for (let c = 0x21; c < 0x7f; c++) {
    const ch = String.fromCharCode(c);
    assert.deepEqual(parseMacShortcut(`⌘${ch}`), { key: ch.toLowerCase(), modifiers: ["command"] });
    assert.equal(formatMacShortcut(parseMacShortcut(`⇧⌘${ch}`)), `⇧⌘${ch.toUpperCase()}`);
  }
  for (const glyph of ["⇥", "↩", "⌤", "⌫", "⌦", "⎋", "Space", "↑", "↓", "←", "→", "↖", "↘", "⇞", "⇟", "F1", "F12", "F20"]) {
    assert.equal(formatMacShortcut(parseMacShortcut(`⌥⌘${glyph}`)), `⌥⌘${glyph}`);
  }
});

test("an arrow shortcut saved as the layout's code with fn binds the arrow itself", () => {
  const tabs = [source("nextTab", "⇧⌘]"), source("previousTab", "⇧⌘["), source("nextProfile", "⌥⌘→"), source("toggleFullScreen", "🌐F")];
  const resolved = resolveShortcuts(tabs, {
    nextTab: ["\u001d", "shift", "command", "function"],
    previousTab: ["\u001c", "shift", "command", "function"],
    nextProfile: ["\u007f", "option", "command", "function"],
    toggleFullScreen: ["\u001c", "command"],
  });
  assert.deepEqual(hints(resolved, "nextTab"), ["⇧⌘→"]);
  assert.deepEqual(hints(resolved, "previousTab"), ["⇧⌘←"]);
  assert.deepEqual(hints(resolved, "nextProfile"), ["⌥⌘⌦"]);
  assert.deepEqual(resolved.bindings.get("toggleFullScreen"), [{ key: "\u001c", modifiers: ["command"] }]);
});

test("telemetry counts custom shortcuts and those on arrow, page and F keys, never which", () => {
  const shortcuts = { nextTab: ["\uf703", "shift", "command"], previousTab: ["\u001c", "shift", "command", "function"], newTab: ["n", "command"], closeTab: [""] };
  const snapshot = settingsSnapshot({ shortcuts });
  assert.equal(snapshot.custom_shortcuts, "3");
  assert.equal(snapshot.custom_shortcuts_navigation_keys, "2");
  assert.equal(snapshot.custom_shortcuts_option_only, "0");
  assert.equal(settingsSnapshot({ shortcuts: { copyUrl: ["c", "option"], newTab: ["t", "option", "command"] } }).custom_shortcuts_option_only, "1");
  assert.ok(!JSON.stringify(snapshot).includes("nextTab"));
});
