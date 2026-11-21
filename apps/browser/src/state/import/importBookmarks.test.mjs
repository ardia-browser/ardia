import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");

const S = () => useBrowser.getState();
const P = "default";

const exported = () => ({
  type: "folder",
  title: "",
  children: [
    {
      type: "folder",
      title: "Bookmarks Bar",
      role: "toolbar",
      children: [
        {
          type: "folder",
          title: "Work",
          children: [
            { type: "url", title: "Docs", url: "https://docs.example/" },
            { type: "folder", title: "Old", children: [{ type: "url", title: "Wiki", url: "https://wiki.example/" }] },
          ],
        },
        { type: "folder", title: "Empty", children: [] },
      ],
    },
    { type: "folder", title: "Other Bookmarks", role: "other", children: [{ type: "url", title: "Later", url: "https://later.example/" }] },
  ],
});

const titles = (id) => {
  const n = S().bookmarks.nodes[id];
  return n.kind === "folder" ? { [n.title]: n.children.map(titles) } : n.title;
};
const bar = () => titles(bookmarkRoots(S(), P).bar);
const fresh = () => {
  S().hydrate({});
  S().createWindow({ url: "https://home.example/" });
  const roots = bookmarkRoots(S(), P);
  if (roots) S().removeBookmarks([roots.bar, roots.other].flatMap((id) => S().bookmarks.nodes[id].children));
};
const other = () => titles(bookmarkRoots(S(), P).other);

test("importing the same bookmarks again adds no second Imported from folder", () => {
  fresh();
  assert.equal(importBookmarks(P, exported(), "Dia"), 3);
  const once = { bar: bar(), other: other() };
  assert.deepEqual(once.bar["Bookmarks Bar"].at(-1), { Empty: [] }, "a first import keeps an empty folder");
  assert.equal(importBookmarks(P, exported(), "Dia"), 0);
  assert.equal(importBookmarks(P, exported(), "Dia"), 0);
  assert.deepEqual({ bar: bar(), other: other() }, once);
});

test("a re-import brings only the bookmarks that are new, in their folders", () => {
  fresh();
  importBookmarks(P, exported(), "Dia");
  const more = exported();
  more.children[0].children[0].children.push({ type: "url", title: "New", url: "https://new.example/" });
  assert.equal(importBookmarks(P, more, "Dia"), 1);
  const added = bar()["Bookmarks Bar"].at(-1);
  assert.deepEqual(added, { "Imported from Dia": [{ Work: ["New"] }] });
});

test("bookmarks the profile already has elsewhere still count as had, whatever the case of the host", () => {
  fresh();
  S().addBookmarkTree(P, [{ title: "Mine", url: "https://DOCS.example/" }, { title: "Wiki", url: "https://wiki.example/#" }, { title: "Later", url: "https://later.example/" }]);
  assert.equal(importBookmarks(P, exported(), "Dia"), 0);
  assert.deepEqual(bar(), { "Bookmarks Bar": ["Mine", "Wiki", "Later"] });
});
