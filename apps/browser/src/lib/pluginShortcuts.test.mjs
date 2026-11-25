import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPluginNode } from "./pluginNodes.ts";
import {
  bindingsOf,
  handledKeysOf,
  mergeShortcutBindings,
  parsePluginShortcut,
  pluginShortcutHandledKeys,
  pluginShortcutKeyChar,
  pluginShortcutMatches,
  pluginShortcutModifiers,
  pluginShortcutOf,
  pluginShortcutText,
  pressedBinding,
} from "./pluginShortcuts.ts";

const text = (raw) => {
  const s = pluginShortcutOf(raw);
  return s ? pluginShortcutText(s) : null;
};
const action = (title, shortcut) => ({ type: "Action", props: { title, shortcut }, children: [] });

test("Ardia's word and glyph notation read the same, in any case and modifier order", () => {
  assert.equal(text("cmd+shift+c"), "cmd+shift+c");
  assert.equal(text("Shift+Cmd+C"), "cmd+shift+c");
  assert.equal(text(" command + option + k "), "cmd+opt+k");
  assert.equal(text("ctrl+alt+cmd+p"), "cmd+ctrl+opt+p");
  assert.equal(text("⇧⌘C"), "cmd+shift+c");
  assert.equal(text("⌃⌥⌘Space"), "cmd+ctrl+opt+space");
  assert.equal(text("cmd+F5"), "cmd+f5");
  assert.equal(text("cmd+/"), "cmd+/");
  assert.equal(text("cmd+["), "cmd+[");
  assert.equal(text("cmd+1"), "cmd+1");
});

test("a shortcut Ardia can't read is dropped", () => {
  for (const raw of [undefined, null, 3, {}, "", "   ", "cmd+", "cmd++", "+c", "cmd+shift", "hyper+c", "cmd+cmd+c", "cmd+ab", "cmd+f13", "cmd+f0", "cmd+é", "cmd+escape", "cmd+enter", "cmd+return", "cmd+tab", "cmd+up", "cmd+left", "cmd+delete", "cmd+backspace", "cmd+home", "cmd+pageup", `cmd+${"x".repeat(50)}`]) {
    assert.equal(pluginShortcutOf(raw), null, JSON.stringify(raw));
  }
});

test("a shortcut that would type into a field or shadow an essential key is refused", () => {
  const refused = [
    "c",
    "1",
    "shift+c",
    "opt+c",
    "ctrl+c",
    "ctrl+shift+k",
    "space",
    "f5",
    "cmd+shift+1",
    "cmd+shift+/",
    "cmd+w",
    "cmd+shift+w",
    "cmd+opt+w",
    "cmd+q",
    "cmd+t",
    "cmd+shift+t",
    "cmd+n",
    "cmd+h",
    "cmd+opt+h",
    "cmd+m",
    "cmd+a",
    "cmd+c",
    "cmd+v",
    "cmd+x",
    "cmd+z",
    "cmd+shift+z",
    "cmd+shift+v",
    "cmd+opt+shift+v",
    "cmd+,",
    "cmd+`",
    "cmd+space",
    "cmd+ctrl+space",
    "cmd+ctrl+f",
    "cmd+ctrl+q",
  ];
  for (const raw of refused) {
    assert.ok(parsePluginShortcut(raw), `${raw} parses`);
    assert.equal(pluginShortcutOf(raw), null, `${raw} is refused`);
  }
  for (const raw of ["cmd+shift+c", "cmd+k", "cmd+opt+c", "cmd+ctrl+c", "cmd+shift+space", "cmd+f1", "cmd+1", "cmd+e"]) assert.ok(pluginShortcutOf(raw), `${raw} is allowed`);
});

test("the node check keeps a valid shortcut in Ardia's spelling and drops a refused one without failing the tree", () => {
  const checked = checkPluginNode({
    type: "ActionPanel",
    props: {},
    children: [
      { type: "Action", props: { title: "Copy", shortcut: "⇧⌘C" } },
      { type: "Action", props: { title: "Close", shortcut: "cmd+w" } },
      { type: "Action", props: { title: "Junk", shortcut: { key: "c" } } },
      { type: "Button", props: { title: "Go", shortcut: "Cmd+Opt+G" } },
    ],
  });
  assert.equal(checked.ok, true);
  const [copy, close, junk, go] = checked.tree.children;
  assert.equal(copy.props.shortcut, "cmd+shift+c");
  assert.equal("shortcut" in close.props, false);
  assert.equal("shortcut" in junk.props, false);
  assert.equal(go.props.shortcut, "cmd+opt+g");
  assert.equal(copy.props.title, "Copy");
});

test("a shortcut becomes Ardia's key and modifiers, in Ardia's modifier order", () => {
  const s = pluginShortcutOf("shift+opt+ctrl+cmd+k");
  assert.deepEqual(pluginShortcutModifiers(s), ["control", "option", "shift", "command"]);
  assert.equal(pluginShortcutKeyChar(s), "k");
  assert.equal(pluginShortcutOf("cmd+space"), null);
  assert.equal(pluginShortcutKeyChar(pluginShortcutOf("cmd+shift+space")), " ");
  assert.equal(pluginShortcutKeyChar(pluginShortcutOf("cmd+f1")), String.fromCharCode(0xf704));
  assert.equal(pluginShortcutKeyChar(pluginShortcutOf("cmd+f12")), String.fromCharCode(0xf70f));
});

test("on the Mac cmd is the Command key; a press matches only with exactly its modifiers, either case", () => {
  const s = pluginShortcutOf("cmd+shift+c");
  assert.equal(pluginShortcutMatches(s, { key: "C", metaKey: true, shiftKey: true }, "metaKey"), true);
  assert.equal(pluginShortcutMatches(s, { key: "c", metaKey: true, shiftKey: true }, "metaKey"), true);
  assert.equal(pluginShortcutMatches(s, { key: "c", metaKey: true }, "metaKey"), false, "shift is required");
  assert.equal(pluginShortcutMatches(s, { key: "C", metaKey: true, shiftKey: true, altKey: true }, "metaKey"), false, "an extra modifier doesn't match");
  assert.equal(pluginShortcutMatches(s, { key: "C", ctrlKey: true, shiftKey: true }, "metaKey"), false, "Control isn't Command on the Mac");
  assert.equal(pluginShortcutMatches(s, { key: "x", metaKey: true, shiftKey: true }, "metaKey"), false);
  assert.equal(pluginShortcutMatches(s, {}, "metaKey"), false);
  assert.equal(pluginShortcutMatches(pluginShortcutOf("cmd+f2"), { key: "F2", metaKey: true }, "metaKey"), true);
  assert.equal(pluginShortcutMatches(pluginShortcutOf("cmd+shift+space"), { key: " ", metaKey: true, shiftKey: true }, "metaKey"), true);
  assert.equal(pluginShortcutMatches(pluginShortcutOf("cmd+opt+c"), { key: "c", metaKey: true, altKey: true }, "metaKey"), true);
});

test("on Windows and Linux cmd is Ctrl", () => {
  const s = pluginShortcutOf("cmd+k");
  assert.equal(pluginShortcutMatches(s, { key: "k", ctrlKey: true }, "ctrlKey"), true);
  assert.equal(pluginShortcutMatches(s, { key: "k", metaKey: true }, "ctrlKey"), false);
  assert.deepEqual(pluginShortcutHandledKeys(s, "ctrlKey"), [
    { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
    { key: "K", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
  ]);
});

test("a field is told to swallow exactly the keys a shortcut presses, every modifier spelled out", () => {
  assert.deepEqual(pluginShortcutHandledKeys(pluginShortcutOf("cmd+shift+c"), "metaKey"), [
    { key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
    { key: "C", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
  ]);
  assert.deepEqual(pluginShortcutHandledKeys(pluginShortcutOf("cmd+ctrl+/"), "metaKey"), [{ key: "/", metaKey: true, ctrlKey: true, altKey: false, shiftKey: false }]);
  assert.deepEqual(pluginShortcutHandledKeys(pluginShortcutOf("cmd+f3"), "metaKey"), [{ key: "F3", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }]);
});

test("only actions with a usable shortcut bind, and the first in a panel wins a shared key", () => {
  const copy = action("Copy", "cmd+shift+c");
  const copyAgain = action("Copy again", "shift+cmd+C");
  const open = action("Open", "cmd+o");
  const none = action("Nothing");
  const bad = action("Bad", "cmd+w");
  const merged = mergeShortcutBindings([{ depth: 0, seq: 0, bindings: bindingsOf([none, copy, bad, copyAgain, open]) }]);
  assert.deepEqual(merged.map((b) => b.action.props.title), ["Copy", "Open"]);
  assert.equal(pressedBinding(merged, { key: "C", metaKey: true, shiftKey: true }, "metaKey").action, copy);
  assert.equal(pressedBinding(merged, { key: "o", metaKey: true }, "metaKey").action, open);
  assert.equal(pressedBinding(merged, { key: "w", metaKey: true }, "metaKey"), null);
  assert.equal(handledKeysOf(merged, "metaKey").length, 4);
});

test("a List's selected item beats the list's own actions, and both beat a Detail nested deeper, whatever order they registered in", () => {
  const itemCopy = action("Item copy", "cmd+shift+c");
  const listCopy = action("List copy", "cmd+shift+c");
  const listRefresh = action("Refresh", "cmd+r");
  const detailRefresh = action("Detail refresh", "cmd+r");
  const detailOnly = action("Detail only", "cmd+d");
  const merged = mergeShortcutBindings([
    { depth: 2, seq: 0, bindings: bindingsOf([detailRefresh, detailOnly]) },
    { depth: 0, seq: 1, bindings: bindingsOf([itemCopy, listCopy, listRefresh]) },
  ]);
  assert.deepEqual(merged.map((b) => b.action.props.title), ["Item copy", "Refresh", "Detail only"]);
});

test("at the same depth the one that registered first wins", () => {
  const a = action("A", "cmd+e");
  const b = action("B", "cmd+e");
  assert.equal(mergeShortcutBindings([{ depth: 1, seq: 5, bindings: bindingsOf([b]) }, { depth: 1, seq: 2, bindings: bindingsOf([a]) }])[0].action, a);
});

test("a key one of Ardia's commands holds never binds, and doesn't pass to a later action either", () => {
  const first = action("First", "cmd+l");
  const second = action("Second", "cmd+l");
  const other = action("Other", "cmd+k");
  const held = (s) => pluginShortcutText(s) === "cmd+l";
  const merged = mergeShortcutBindings([{ depth: 0, seq: 0, bindings: bindingsOf([first]) }, { depth: 1, seq: 1, bindings: bindingsOf([second, other]) }], held);
  assert.deepEqual(merged.map((b) => b.action.props.title), ["Other"]);
});
