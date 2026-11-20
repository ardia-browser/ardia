import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks, untitledLinks } = await import("./apply.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { noteUntitledBookmarks, takeImportRuns } = await import("../telemetry/importRuns.ts");
const { menuState } = await import("../commands/menuState.ts");

const S = () => useBrowser.getState();
const P = "default";

function tree(id) {
  const node = S().bookmarks.nodes[id];
  if (node.kind === "url") return [node.title, node.url];
  return [node.title, node.children.map(tree)];
}

const menuTree = (items) => items.map((i) => (i.children ? [i.title, menuTree(i.children)] : [i.title, i.url]));

const root = {
  type: "folder",
  title: "",
  children: [
    {
      type: "folder",
      title: "Bookmarks bar",
      role: "toolbar",
      children: [
        { type: "url", title: "", url: "https://icon-only.example/" },
        { type: "url", title: "Named", url: "https://named.example/" },
        { type: "folder", title: "Work", children: [{ type: "url", title: "", url: "https://work.example/" }, { type: "url", title: "Docs", url: "https://docs.example/" }] },
      ],
    },
    { type: "folder", title: "Other bookmarks", role: "other", children: [{ type: "url", title: "", url: "https://other.example/" }] },
  ],
};

test("an imported bookmark with an empty name keeps it empty, named ones, folders and order are unchanged, and the Bookmarks menu names it by its URL", () => {
  S().hydrate({});
  S().createWindow({ url: "https://home.example/" });
  assert.equal(importBookmarks(P, root, "Helium"), 5);
  const roots = bookmarkRoots(S(), P);
  assert.deepEqual(tree(roots.bar)[1], [
    ["", "https://icon-only.example/"],
    ["Named", "https://named.example/"],
    ["Work", [["", "https://work.example/"], ["Docs", "https://docs.example/"]]],
  ]);
  assert.deepEqual(tree(roots.other)[1], [["", "https://other.example/"]]);

  const menus = menuState(S());
  assert.deepEqual(menuTree(menus.bookmarksBar), [
    ["https://icon-only.example/", "https://icon-only.example/"],
    ["Named", "https://named.example/"],
    ["Work", [["https://work.example/", "https://work.example/"], ["Docs", "https://docs.example/"]]],
  ]);
  assert.deepEqual(menuTree(menus.otherBookmarks), [["https://other.example/", "https://other.example/"]]);
  assert.ok(menus.recentBookmarks.every((b) => b.title));
});

test("the untitled count covers every empty-named link in the bar, its folders and Other Bookmarks, once per hour", () => {
  assert.equal(untitledLinks(root), 3);
  assert.equal(untitledLinks(undefined), 0);
  takeImportRuns();
  noteUntitledBookmarks(untitledLinks(root));
  assert.equal(takeImportRuns().import_untitled_bookmarks, 3);
  assert.equal(takeImportRuns().import_untitled_bookmarks, 0);
});

test("a reader that sends no name at all still gets the URL as the name, and isn't counted as untitled", () => {
  S().hydrate({});
  S().createWindow({ url: "https://home.example/" });
  const nameless = { type: "folder", title: "", children: [{ type: "folder", title: "Bar", role: "toolbar", children: [{ type: "url", url: "https://untitled.example/" }] }] };
  assert.equal(importBookmarks("second", nameless, "Safari"), 1);
  assert.equal(untitledLinks(nameless), 0);
  assert.deepEqual(tree(bookmarkRoots(S(), "second").bar)[1], [["https://untitled.example/", "https://untitled.example/"]]);
});
