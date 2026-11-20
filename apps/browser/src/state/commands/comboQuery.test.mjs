import assert from "node:assert/strict";
import { test } from "node:test";
import { bindsCombo, commandsBoundTo, parseCombo } from "./comboQuery.ts";
import { formatShortcut, parseShortcut } from "./shortcuts.ts";
import * as linuxWords from "./comboWords.linux.ts";
import * as windowsWords from "./comboWords.windows.ts";
import { windowsModifiers } from "./windowsKeys.ts";

const mac = (text) => {
  const combo = parseCombo(text);
  return combo && formatShortcut(combo);
};
const linux = { modifiers: linuxWords.COMBO_MODIFIER_WORDS, keys: linuxWords.COMBO_PLATFORM_KEYS, stored: (m) => [...m] };
const windows = { modifiers: windowsWords.COMBO_MODIFIER_WORDS, keys: windowsWords.COMBO_PLATFORM_KEYS, stored: windowsModifiers };

test("glyph notation reads as the same combo", () => {
  assert.equal(mac("⌥⌘N"), "⌥⌘N");
  assert.equal(mac("⇧⌘T"), "⇧⌘T");
  assert.equal(mac("⌘⌥n"), "⌥⌘N");
  assert.equal(mac(" ⌃⇥ "), "⌃⇥");
  assert.equal(mac("⌃tab"), "⌃⇥");
  assert.equal(mac("⌘,"), "⌘,");
  assert.equal(mac("⇧⌘⌫"), "⇧⌘⌫");
  assert.equal(mac("⌘F12"), "⌘F12");
});

test("words and abbreviations with any separator read as a combo", () => {
  for (const text of ["cmd opt n", "command+option+n", "Command + Option + N", "opt-cmd-n", "alt+cmd+n", "cmd alt N", "⌘ option n"]) assert.equal(mac(text), "⌥⌘N", text);
  assert.equal(mac("ctrl+alt+n"), "⌃⌥N");
  assert.equal(mac("option shift t"), "⌥⇧T");
  assert.equal(mac("cmd-w"), "⌘W");
  assert.equal(mac("ctrl tab"), "⌃⇥");
  assert.equal(mac("shift cmd left"), "⇧⌘←");
  assert.equal(mac("cmd return"), "⌘↩");
  assert.equal(mac("cmd delete"), "⌘⌫");
  assert.equal(mac("cmd space"), "⌘Space");
  assert.equal(mac("cmd comma"), "⌘,");
});

test("a minus or plus at the end is the key", () => {
  assert.equal(mac("cmd -"), "⌘-");
  assert.equal(mac("cmd+-"), "⌘-");
  assert.equal(mac("⌘-"), "⌘-");
  assert.equal(mac("ctrl++"), "⌃+");
  assert.equal(mac("⌘+"), "⌘+");
  assert.equal(parseCombo("cmd-"), null);
  assert.equal(parseCombo("cmd+"), null);
});

test("plain words stay a text search", () => {
  for (const text of ["", "  ", "tab", "new tab", "n", "⌘", "cmd", "cmd opt", "shift click", "option click", "command bar", "control center", "cmd ab", "cmd n m", "dark mode", "alt click", "F5"]) {
    assert.equal(parseCombo(text), null, JSON.stringify(text));
  }
});

test("Linux reads Ctrl as the command key and Super as control", () => {
  assert.deepEqual(parseCombo("Ctrl+Alt+N", linux), { key: "n", modifiers: ["option", "command"] });
  assert.deepEqual(parseCombo("super+1", linux), { key: "1", modifiers: ["control"] });
  assert.deepEqual(parseCombo("ctrl+shift+delete", linux), { key: "", modifiers: ["shift", "command"] });
});

test("Windows reads Ctrl and ⌘ alike, as its stored control key", () => {
  assert.deepEqual(parseCombo("Ctrl+Alt+N", windows), { key: "n", modifiers: ["control", "option"] });
  assert.deepEqual(parseCombo("⌥⌘N", windows), { key: "n", modifiers: ["control", "option"] });
  assert.equal(parseCombo("win+e", windows), null);
  assert.equal(parseCombo("fn f5", windows), null);
});

test("a combo matches every binding a command holds, uppercase and Delete spellings included", () => {
  const combo = parseCombo("cmd opt n");
  assert.ok(bindsCombo(parseShortcut("⌥⌘N"), combo));
  assert.ok(bindsCombo({ key: "N", modifiers: ["option", "command"] }, parseCombo("shift opt cmd n")));
  assert.ok(!bindsCombo(parseShortcut("⌘N"), combo));
  assert.ok(!bindsCombo(undefined, combo));
  assert.ok(!bindsCombo({ key: "", modifiers: [] }, combo));
  assert.ok(bindsCombo({ key: "\u007f", modifiers: ["shift", "command"] }, parseCombo("⇧⌘⌫")));
  const items = [{ id: "newLittleArdia" }, { id: "newWindow" }, { id: "toggleSidebar" }];
  const bindings = { newLittleArdia: [parseShortcut("⌥⌘N")], newWindow: [parseShortcut("⌘N")], toggleSidebar: [parseShortcut("⌘S"), parseShortcut("⇧⌘L")] };
  assert.deepEqual(commandsBoundTo(combo, items, (id) => bindings[id]).map((i) => i.id), ["newLittleArdia"]);
  assert.deepEqual(commandsBoundTo(parseCombo("shift cmd l"), items, (id) => bindings[id]).map((i) => i.id), ["toggleSidebar"]);
});
