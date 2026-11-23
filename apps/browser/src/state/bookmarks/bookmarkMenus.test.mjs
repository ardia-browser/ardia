import assert from "node:assert/strict";
import { test } from "node:test";
const { barMenuItems } = await import("./barMenus.ts");
const { bookmarkRowMenuItems, rowMenuTarget } = await import("./bookmarkMenus.ts");
const { historyRowMenuItems } = await import("../history/historyMenus.ts");

const G = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
const keys = (i) => (i.key ? ["control", "option", "shift", "command"].filter((m) => i.modifiers?.includes(m)).map((m) => G[m]).join("") + i.key.toUpperCase() : "");
const render = (items, depth = 0) =>
  items.flatMap((i) => [
    "  ".repeat(depth) + (i.separator ? "---" : [i.checked ? "✓" : "", i.title, keys(i), i.symbol ? `[${i.symbol}]` : "", i.enabled === false ? "(off)" : "", i.alternate ? "(alt)" : "", i.children ? "›" : ""].filter(Boolean).join(" ")),
    ...(i.children ? render(i.children, depth + 1) : []),
  ]);

const OPEN_ONE = ["Open in New Tab [plus.app]", "Open in Split View [rectangle.split.2x1]", "Open in [macwindow] ›", "  New Window [macwindow.badge.plus]", "  Incognito Window [eyeglasses]"];
const COPY_ONE = ["Copy Link [link]", "Copy Link as Markdown [link] (alt)"];

test("a bookmarks bar link: opens, Copy Link, Edit…, and Remove Bookmark last, with no bar settings mixed in", () => {
  assert.deepEqual(render(barMenuItems({ kind: "url" }, { barShown: true })), [...OPEN_ONE, "---", ...COPY_ONE, "---", "Edit… [pencil]", "---", "Remove Bookmark [trash]"]);
});

test("a bookmarks bar folder: Open All in New Tabs and group, Rename…, Remove Folder last; New Folder… lives on the bar", () => {
  assert.deepEqual(render(barMenuItems({ kind: "folder", links: 2, makesGroup: true, restoresArc: false }, { barShown: true })), [
    "Open All in New Tabs [plus.app]",
    "Add to Sidebar as Group [sidebar.left]",
    "---",
    "Rename… [pencil]",
    "---",
    "Remove Folder [trash]",
  ]);
  const empty = render(barMenuItems({ kind: "folder", links: 0, makesGroup: false, restoresArc: true }, { barShown: true }));
  assert.deepEqual(empty.slice(0, 3), ["Open All in New Tabs [plus.app] (off)", "Add to Sidebar as Group [sidebar.left] (off)", "Restore Arc Folders as Groups [arrow.uturn.backward]"]);
});

test("the bookmarks bar background: Add Page…, New Folder…, then Manage Bookmarks and the bar toggle with their real keys", () => {
  assert.deepEqual(render(barMenuItems(null, { barShown: true })), [
    "Add Page… [bookmark]",
    "New Folder… [folder.badge.plus]",
    "---",
    "Manage Bookmarks ⌥⌘B [book]",
    "✓ Show Bookmarks Bar ⇧⌘B [menubar.rectangle]",
  ]);
  assert.deepEqual(render(barMenuItems(null, { barShown: false, keys: () => ({}) })).slice(3), ["Manage Bookmarks [book]", "Show Bookmarks Bar [menubar.rectangle]"]);
});

test("a Bookmarks page row matches the bar, adds Show in Folder for a search result, and a selection acts on all of it", () => {
  assert.deepEqual(render(bookmarkRowMenuItems({ kind: "url", showPath: true })), [...OPEN_ONE, "Show in Folder [folder]", "---", ...COPY_ONE, "---", "Edit… [pencil]", "---", "Remove Bookmark [trash]"]);
  assert.deepEqual(render(bookmarkRowMenuItems({ kind: "folder", links: 3, makesGroup: false, restoresArc: false, showPath: true })), [
    "Open All in New Tabs [plus.app]",
    "Add to Sidebar as Group [sidebar.left] (off)",
    "Show in Folder [folder]",
    "---",
    "Rename… [pencil]",
    "---",
    "Remove Folder [trash]",
  ]);
  assert.deepEqual(render(bookmarkRowMenuItems({ kind: "several", links: 3, items: 2, noun: "Items" })), [
    "Open 3 in New Tabs [plus.app]",
    "Open 3 in New Window [macwindow.badge.plus]",
    "Open 3 in Incognito Window [eyeglasses]",
    "---",
    "Copy 3 Links [link]",
    "Copy 3 Links as Markdown [link] (alt)",
    "---",
    "Remove 2 Items [trash]",
  ]);
});

test("a selection's target counts the links inside folders and names what it deletes", () => {
  const b = {
    nodes: {
      f: { kind: "folder", id: "f", parentId: "bar", title: "F", children: ["x", "y"] },
      x: { kind: "url", id: "x", parentId: "f", title: "X", url: "https://x.com/" },
      y: { kind: "url", id: "y", parentId: "f", title: "Y", url: "https://y.com/" },
      z: { kind: "url", id: "z", parentId: "bar", title: "Z", url: "https://z.com/" },
    },
  };
  const s = { bookmarks: b, profiles: {}, profileOrder: [] };
  assert.deepEqual(rowMenuTarget(s, [b.nodes.f, b.nodes.z], false), { kind: "several", links: 3, items: 2, noun: "Items" });
  assert.deepEqual(rowMenuTarget(s, [b.nodes.x, b.nodes.z], false), { kind: "several", links: 2, items: 2, noun: "Bookmarks" });
  assert.deepEqual(rowMenuTarget(s, [b.nodes.z], true), { kind: "url", showPath: true });
});

test("a History row gets the same verbs plus Open in Split View; several selected rows act together and confirm the removal", () => {
  assert.deepEqual(render(historyRowMenuItems(1)), [...OPEN_ONE, "---", ...COPY_ONE, "More from This Site [magnifyingglass]", "---", "Remove from History [trash]"]);
  assert.deepEqual(render(historyRowMenuItems(4)), [
    "Open 4 in New Tabs [plus.app]",
    "Open 4 in New Window [macwindow.badge.plus]",
    "Open 4 in Incognito Window [eyeglasses]",
    "---",
    "Copy 4 Links [link]",
    "Copy 4 Links as Markdown [link] (alt)",
    "---",
    "Remove 4 Pages from History… [trash]",
  ]);
});
