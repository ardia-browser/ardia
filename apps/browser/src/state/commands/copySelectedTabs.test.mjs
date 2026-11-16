import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mount } from "../../test-hooks.mjs";
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require("react-dom/server");
const { pressables } = await import("react-native");
const { TabPressArea } = await import("../../components/sidebar/TabPressArea.tsx");
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("./commands.ts");
const { menuState } = await import("./menuState.ts");
const { clipboard } = await import("../../test-native/shell.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

function windowWith(...hosts) {
  const w = S().createWindow({ url: `https://${hosts[0]}.com/?utm_source=x` });
  S().setFocusedWindow(w);
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/?utm_source=x` }));
  ids.forEach((id, i) => S().updateTab(id, { title: hosts[i].toUpperCase() }));
  return { w, ids };
}

function fresh() {
  S().hydrate({});
  clipboard.copied.length = 0;
}

const copied = () => clipboard.copied.at(-1);

for (const intoGroup of [false, true]) {
  test(`Option+Shift-click ${intoGroup ? "groups tabs without taking selection focus" : "selects a range and takes keyboard focus"}`, (t) => {
    fresh();
    const { w, ids: [a, b] } = windowWith("a", "b");
    S().activate(a);
    const mounted = mount(() => TabPressArea({ windowId: w, tab: S().tabs[b], children: null }));
    t.after(() => mounted.unmount());
    S().updateSettings({ optShiftClickOpensInGroup: intoGroup });
    pressables.length = 0;
    renderToStaticMarkup(mounted.value);
    const row = pressables.find((props) => props.onPressIn && props.onPress);
    assert.ok(row);
    let focuses = 0;
    row.ref.current = { focus: () => focuses++ };
    const press = { nativeEvent: { altKey: true, shiftKey: true, identifier: 0 } };
    row.onPressIn(press);
    row.onPress(press);
    assert.deepEqual(S().selection[w], intoGroup ? [] : [a, b]);
    assert.equal(focuses, intoGroup ? 0 : 1);
    if (intoGroup) assert.ok(Object.values(S().groups).some((group) => group.tabIds.includes(a) && group.tabIds.includes(b)));
  });
}

test("⇧⌘C and plain ⌘C copy every selected tab's clean URL, one per line in sidebar order", () => {
  fresh();
  const { w, ids: [, b, c, d] } = windowWith("a", "b", "c", "d");
  S().activate(c);
  S().setSelection(w, [d, b, c]);
  const menu = menuState(S());
  assert.equal(menu.copiesSelectedTabsIn, w);
  assert.equal(menu.titles.copyUrl, "Copy 3 URLs");
  assert.equal(menu.titles.copyUrlAsMarkdown, "Copy 3 URLs as Markdown");
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.equal(copied(), "https://b.com/\nhttps://c.com/\nhttps://d.com/");
  runCommand({ command: "copyUrl", arg: "selectedTabs", windowId: w });
  assert.equal(copied(), "https://b.com/\nhttps://c.com/\nhttps://d.com/");
  assert.deepEqual(S().selection[w], [d, b, c], "copying keeps the selection");
});

test("⌥⇧⌘C copies the selection as a Markdown list", () => {
  fresh();
  const { w, ids: [a, , c] } = windowWith("a", "b", "c");
  S().setSelection(w, [c, a]);
  runCommand({ command: "copyUrlAsMarkdown", arg: null, windowId: w });
  assert.equal(copied(), "- [A](https://a.com/)\n- [C](https://c.com/)");
});

test("with one tab or no selection, Copy URL copies only the active page", () => {
  fresh();
  const { w, ids: [a, b] } = windowWith("a", "b");
  S().activate(b);
  assert.equal(menuState(S()).copiesSelectedTabsIn, null);
  assert.equal(menuState(S()).titles.copyUrl, undefined);
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.equal(copied(), "https://b.com/");
  S().setSelection(w, [a]);
  assert.equal(menuState(S()).copiesSelectedTabsIn, null);
  runCommand({ command: "copyUrlAsMarkdown", arg: null, windowId: w });
  assert.equal(copied(), "[B](https://b.com/)");
});

test("stale and foreign ids in a selection don't count toward copying several tabs", () => {
  fresh();
  const one = windowWith("a", "b");
  const other = windowWith("x");
  S().setFocusedWindow(one.w);
  S().activate(one.ids[0]);
  useBrowser.setState((s) => ({ selection: { ...s.selection, [one.w]: [one.ids[1], other.ids[0], "gone"] } }));
  assert.equal(menuState(S()).copiesSelectedTabsIn, null);
  runCommand({ command: "copyUrl", arg: null, windowId: one.w });
  assert.equal(copied(), "https://a.com/");
});

test("a selection in one window doesn't change Copy URL in another", () => {
  fresh();
  const one = windowWith("a", "b");
  S().setSelection(one.w, one.ids);
  const other = windowWith("x");
  assert.equal(menuState(S()).copiesSelectedTabsIn, null);
  runCommand({ command: "copyUrl", arg: null, windowId: other.w });
  assert.equal(copied(), "https://x.com/");
  S().setFocusedWindow(one.w);
  assert.equal(menuState(S()).copiesSelectedTabsIn, one.w);
});

test("a command aimed at one tab copies that tab even with a selection", () => {
  fresh();
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c");
  S().setSelection(w, [a, b]);
  runCommand({ command: "copyUrl", arg: null, windowId: w }, { tabId: c });
  assert.equal(copied(), "https://c.com/");
});

test("selected tabs without a page still leave the menu items on, and copy only the pages", () => {
  fresh();
  const { w, ids: [a, b] } = windowWith("a", "b");
  const blank = S().newTab(w, {});
  S().activate(blank);
  S().setSelection(w, [a, b, blank]);
  const menu = menuState(S());
  assert.ok(!menu.disabled.includes("copyUrl"));
  assert.ok(!menu.disabled.includes("copyUrlAsMarkdown"));
  assert.equal(menu.titles.copyUrl, "Copy 2 URLs");
  runCommand({ command: "copyUrl", arg: "selectedTabs", windowId: w });
  assert.equal(copied(), "https://a.com/\nhttps://b.com/");
});

test("a blank tab doesn't count as a URL in the copy menu", () => {
  fresh();
  const { w, ids: [a] } = windowWith("a");
  const blank = S().newTab(w, {});
  S().setSelection(w, [a, blank]);
  assert.equal(menuState(S()).titles.copyUrl, "Copy 1 URL");
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.equal(copied(), "https://a.com/");
});

test("selecting only blank tabs never copies an unselected active page", () => {
  fresh();
  const { w, ids: [active] } = windowWith("a");
  const blanks = [S().newTab(w, {}), S().newTab(w, {})];
  S().activate(active);
  S().setSelection(w, blanks);
  for (const command of ["copyUrl", "copyUrlAsMarkdown"]) {
    runCommand({ command, arg: null, windowId: w });
    assert.deepEqual(clipboard.copied, []);
  }
});

test("an open peek copies its page instead of the sidebar selection", () => {
  fresh();
  const { w, ids: [a, b] } = windowWith("a", "b");
  const peek = S().openPeek(a, "https://peek.example/");
  S().setSelection(w, [a, b]);
  assert.ok(peek);
  assert.equal(menuState(S()).copiesSelectedTabsIn, null);
  assert.equal(menuState(S()).titles.copyUrl, undefined);
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.equal(copied(), "https://peek.example/");
});

test("a stale native Copy event keeps the clipboard when the selection is cleared", () => {
  fresh();
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c");
  S().setSelection(w, [a, b]);
  const published = menuState(S()).copiesSelectedTabsIn;
  S().clickTab(w, c);
  runCommand({ command: "copyUrl", arg: "selectedTabs", windowId: published });
  assert.deepEqual(clipboard.copied, []);
});

test("a stale native Copy event cannot copy another window's selection after its source closes", () => {
  fresh();
  const source = windowWith("a", "b");
  S().setSelection(source.w, source.ids);
  const published = menuState(S()).copiesSelectedTabsIn;
  const other = windowWith("x", "y");
  S().setSelection(other.w, other.ids);
  S().closeWindow(source.w);
  assert.equal(S().windows[source.w], undefined);
  runCommand({ command: "copyUrl", arg: "selectedTabs", windowId: published });
  assert.deepEqual(clipboard.copied, []);
});

test("a selection-only Copy without a source window cannot copy the focused selection", () => {
  fresh();
  const { w, ids } = windowWith("a", "b");
  S().setSelection(w, ids);
  runCommand({ command: "copyUrl", arg: "selectedTabs", windowId: null });
  assert.deepEqual(clipboard.copied, []);
});

test("URL and Markdown copy follow flipped split panes in a group", () => {
  fresh();
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c");
  const split = S().createSplit([a, b]);
  S().groupTabs([a, b, c], { pinned: true });
  S().flipSplit(split);
  S().setSelection(w, [c, a, b]);
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.equal(copied(), "https://b.com/\nhttps://a.com/\nhttps://c.com/");
  runCommand({ command: "copyUrlAsMarkdown", arg: null, windowId: w });
  assert.equal(copied(), "- [B](https://b.com/)\n- [A](https://a.com/)\n- [C](https://c.com/)");
});
