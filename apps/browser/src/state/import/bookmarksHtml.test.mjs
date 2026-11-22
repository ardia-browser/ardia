import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { bookmarksFromHtml } = await import("../../../../../packages/expo-windows/src/import/fileFormats.ts");

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

test("an untitled folder no parser marked as a list stays a folder, whatever its date", () => {
  S().hydrate({});
  useBrowser.setState({ bookmarks: { nodes: {} } });
  const exported = folder("Bookmarks", [folder("", []), folder("", [link("Example", "https://example.org/")])]);
  assert.equal(importBookmarks(P, exported, "HTML File"), 1);
  assert.deepEqual(otherBookmarks(), [{ "": [] }, { "": ["Example"] }]);
});

const fresh = () => {
  S().hydrate({});
  useBrowser.setState({ bookmarks: { nodes: {} } });
};
const ADDED = 1_700_000_000_000;

test("a folder the file names with an empty title stays a folder, empty or holding links", () => {
  fresh();
  const exported = folder("Bookmarks", [
    { type: "folder", title: "", dateAdded: ADDED, children: [] },
    { type: "folder", title: "", dateAdded: ADDED, children: [folder("Inner", [link("Deep", "https://deep.example/")]), link("Kept", "https://kept.example/")] },
  ]);
  assert.equal(importBookmarks(P, exported, "HTML File"), 2);
  assert.deepEqual(otherBookmarks(), [{ "": [] }, { "": [{ Inner: ["Deep"] }, "Kept"] }]);
});

test("a list the parser marks as unnamed lands loose in Other Bookmarks", () => {
  fresh();
  const exported = folder("Bookmarks", [folder("", [link("Loose", "https://loose.example/")], "list")]);
  assert.equal(importBookmarks(P, exported, "HTML File"), 1);
  assert.deepEqual(otherBookmarks(), ["Loose"]);
});

const EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
    </DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0"></H3>
    <DL><p>
    </DL><p>
    <DT><H3 ADD_DATE="0" LAST_MODIFIED="0"></H3>
    <DL><p>
    </DL><p>
    <DT><H3></H3>
    <DL><p>
        <DT><A HREF="https://kept.example/" ADD_DATE="1700000000">Kept</A>
    </DL><p>
    <DT><H3 ADD_DATE="0"></H3>
    <DL><p>
        <DT><A HREF="https://zero.example/">Zero</A>
    </DL><p>
    <DL><p>
        <DT><A HREF="https://loose.example/" ADD_DATE="1700000000">Loose</A>
    </DL><p>
</DL><p>
`;

test("through the Windows parser, empty-named folders stay folders with or without a date, and an unnamed list lands loose", () => {
  fresh();
  const root = bookmarksFromHtml(EXPORT, "bookmarks.html");
  assert.equal(importBookmarks(P, root, "HTML File"), 3);
  assert.deepEqual(otherBookmarks(), [{ "": [] }, { "": [] }, { "": ["Kept"] }, { "": ["Zero"] }, "Loose"]);
});
