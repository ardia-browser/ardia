import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");

const S = () => useBrowser.getState();
const P = "default";
const link = (title, url) => ({ type: "url", title, url });
const folder = (title, children, role) => ({ type: "folder", title, children, ...(role ? { role } : {}) });

const outline = (id) => {
  const node = S().bookmarks.nodes[id];
  return node.kind === "folder" ? { [node.title]: node.children.map(outline) } : node.title;
};
const otherBookmarks = () => S().bookmarks.nodes[bookmarkRoots(S(), P).other].children.map(outline);

test("a Chrome bookmarks HTML file keeps the folders it lists beside the bookmarks bar", () => {
  S().hydrate({});
  useBrowser.setState({ bookmarks: { nodes: {} } });
  const exported = folder("Bookmarks", [
    folder("Bookmarks bar", [link("Bar link", "https://bar.example/")], "toolbar"),
    folder("Work", [folder("Spec", [link("Spec doc", "https://spec.example/")]), link("Work home", "https://work.example/")]),
    folder("Archive", []),
    link("Loose link", "https://loose.example/"),
  ]);
  assert.equal(importBookmarks(P, exported, "HTML File"), 4);
  assert.deepEqual(otherBookmarks(), [{ Work: [{ Spec: ["Spec doc"] }, "Work home"] }, { Archive: [] }, "Loose link"]);
});

test("a Firefox bookmarks HTML file still empties its Other Bookmarks folder into Other Bookmarks", () => {
  S().hydrate({});
  useBrowser.setState({ bookmarks: { nodes: {} } });
  const exported = folder("Bookmarks", [
    folder("Menu folder", [link("Menu link", "https://menu.example/")]),
    folder("Other Bookmarks", [link("Later", "https://later.example/"), folder("Reading", [link("Essay", "https://essay.example/")])], "other"),
  ]);
  assert.equal(importBookmarks(P, exported, "HTML File"), 3);
  assert.deepEqual(otherBookmarks(), [{ "Menu folder": ["Menu link"] }, "Later", { Reading: ["Essay"] }]);
});

test("a list the file gives no folder name still lands loose in Other Bookmarks", () => {
  S().hydrate({});
  useBrowser.setState({ bookmarks: { nodes: {} } });
  const exported = folder("Bookmarks", [folder("", [link("Example", "https://example.org/")])]);
  assert.equal(importBookmarks(P, exported, "HTML File"), 1);
  assert.deepEqual(otherBookmarks(), ["Example"]);
});
