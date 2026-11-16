import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { bookmarkRoots } = await import("./bookmarks.ts");
const { canDragInTree, canDropInto, treeDrop } = await import("./treeDrop.ts");

const S = () => useBrowser.getState();

function seed() {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  const link = (title, parentId) => S().addBookmark({ profileId: "default", url: `https://${title.toLowerCase()}.example/`, title, parentId });
  const folder = (title, parentId) => S().addBookmarkFolder({ profileId: "default", title, parentId });
  const a = link("A");
  const f = folder("F");
  const b = link("B");
  const g = folder("G");
  const h = folder("H");
  const x = link("X", f);
  const f1 = folder("F1", f);
  const f2 = folder("F2", f1);
  const roots = bookmarkRoots(S(), "default");
  return { a, b, f, g, h, x, f1, f2, bar: roots.bar, other: roots.other };
}

const titles = (id) => S().bookmarks.nodes[id].children.map((c) => S().bookmarks.nodes[c].title);
const row = (id, expanded = false) => ({ id, expanded });
const drop = (moving, target, fraction) => {
  const spot = treeDrop(S().bookmarks, moving, target, fraction);
  if (spot) "into" in spot ? S().moveBookmarks(moving, spot.into) : S().moveBookmarks(moving, spot.parentId, spot.index);
  return spot;
};

test("the middle of a folder row drops into it, at the end", () => {
  const n = seed();
  assert.deepEqual(drop([n.h], row(n.g), 0.5), { into: n.g });
  assert.deepEqual(titles(n.bar), ["A", "F", "B", "G"]);
  assert.deepEqual(titles(n.g), ["H"]);
  assert.deepEqual(drop([n.g], row(n.f), 0.3), { into: n.f });
  assert.deepEqual(titles(n.f), ["X", "F1", "G"]);
});

test("the top edge drops before the folder, the bottom edge after it, counted among all its siblings", () => {
  const n = seed();
  assert.deepEqual(drop([n.h], row(n.f), 0.1), { parentId: n.bar, index: 1, edge: "before" });
  assert.deepEqual(titles(n.bar), ["A", "H", "F", "B", "G"]);
  assert.deepEqual(drop([n.h], row(n.g), 0.9), { parentId: n.bar, index: 4, edge: "after" });
  assert.deepEqual(titles(n.bar), ["A", "F", "B", "G", "H"]);
  assert.deepEqual(drop([n.g], row(n.f), 0.9), { parentId: n.bar, index: 2, edge: "after" });
  assert.deepEqual(titles(n.bar), ["A", "F", "G", "B", "H"]);
});

test("a folder dropped beside a folder in another parent leaves its own parent and keeps the bookmarks around it", () => {
  const n = seed();
  drop([n.g], row(n.f1), 0.05);
  assert.deepEqual(titles(n.f), ["X", "G", "F1"]);
  assert.deepEqual(titles(n.bar), ["A", "F", "B", "H"]);
  drop([n.f1], row(n.h), 0.95);
  assert.deepEqual(titles(n.bar), ["A", "F", "B", "H", "F1"]);
  assert.deepEqual(titles(n.f1), ["F2"]);
});

test("below an open folder that shows subfolders is its first child, as in Chrome's tree", () => {
  const n = seed();
  assert.deepEqual(drop([n.h], row(n.f, true), 0.9), { parentId: n.f, index: 0, edge: "after" });
  assert.deepEqual(titles(n.f), ["H", "X", "F1"]);
});

test("a folder can't go into itself or anything inside it", () => {
  const n = seed();
  for (const fraction of [0.1, 0.5, 0.9]) {
    assert.equal(treeDrop(S().bookmarks, [n.f], row(n.f), fraction), null);
    assert.equal(treeDrop(S().bookmarks, [n.f], row(n.f1, true), fraction), null);
    assert.equal(treeDrop(S().bookmarks, [n.f], row(n.f2), fraction), null);
  }
  assert.equal(canDropInto(S().bookmarks, [n.f], n.f2), false);
  assert.equal(canDropInto(S().bookmarks, [n.a, n.f], n.f1), false);
  assert.equal(canDropInto(S().bookmarks, [n.f1], n.g), true);
});

test("dropping where it already is moves nothing", () => {
  const n = seed();
  assert.equal(treeDrop(S().bookmarks, [n.g], row(n.h), 0.1), null);
  assert.equal(treeDrop(S().bookmarks, [n.g], row(n.b), 0.9), null);
  assert.equal(treeDrop(S().bookmarks, [n.f1], row(n.f), 0.5), null);
  assert.equal(treeDrop(S().bookmarks, [n.x], row(n.f), 0.5), null);
  assert.equal(canDropInto(S().bookmarks, [n.x, n.f1], n.f), false);
  assert.equal(canDropInto(S().bookmarks, [n.x, n.a], n.f), true);
});

test("the Bookmarks Bar and Other Bookmarks stay put: they can't be dragged and their edges drop into them", () => {
  const n = seed();
  assert.equal(canDragInTree(S().bookmarks, n.bar), false);
  assert.equal(canDragInTree(S().bookmarks, n.other), false);
  assert.equal(canDragInTree(S().bookmarks, n.a), false);
  assert.equal(canDragInTree(S().bookmarks, n.f2), true);
  assert.deepEqual(drop([n.g], row(n.other, true), 0.05), { into: n.other });
  assert.deepEqual(titles(n.other), ["G"]);
  assert.deepEqual(drop([n.f1], row(n.bar, true), 0.95), { into: n.bar });
  assert.deepEqual(titles(n.bar), ["A", "F", "B", "H", "F1"]);
  assert.equal(treeDrop(S().bookmarks, [n.bar], row(n.other), 0.5), null);
});

test("bookmarks dragged from the list drop into tree folders and between them too", () => {
  const n = seed();
  assert.deepEqual(drop([n.a, n.b], row(n.g), 0.5), { into: n.g });
  assert.deepEqual(titles(n.g), ["A", "B"]);
  drop([n.x], row(n.h), 0.05);
  assert.deepEqual(titles(n.bar), ["F", "G", "X", "H"]);
});
