import assert from "node:assert/strict";
import test from "node:test";
import { bookmarkPages, bookmarksHtml } from "./bookmarksHtml.ts";

const HEADER = [
  "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
  "<!-- This is an automatically generated file.",
  "     It will be read and overwritten.",
  "     DO NOT EDIT! -->",
  '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
  "<TITLE>Bookmarks</TITLE>",
  "<H1>Bookmarks</H1>",
  "<DL><p>",
];
const folder = (id, t, a, c = []) => ({ id, k: "f", t, a, c });
const link = (id, t, u, a) => ({ id, k: "u", t, u, a });
const emptyTree = () => ({ bar: folder("bar", "Bookmarks bar", 1_700_000_000_999), other: folder("other", "Other bookmarks", 1_700_000_000_999) });

function parse(html) {
  const root = { title: null, children: [] };
  const stack = [root];
  let pending = null;
  for (const line of html.split("\r\n")) {
    const text = line.trim();
    const heading = /^<DT><H3 ADD_DATE="(\d+)" LAST_MODIFIED="(\d+)"( PERSONAL_TOOLBAR_FOLDER="true")?>(.*)<\/H3>$/.exec(text);
    const anchor = /^<DT><A HREF="([^"]*)" ADD_DATE="(\d+)"(?: ICON="([^"]*)")?>(.*)<\/A>$/.exec(text);
    if (heading) {
      pending = { title: heading[4], added: Number(heading[1]), modified: Number(heading[2]), bar: !!heading[3], children: [], indent: line.length - line.trimStart().length };
      stack[stack.length - 1].children.push(pending);
    } else if (anchor) {
      stack[stack.length - 1].children.push({ href: anchor[1], added: Number(anchor[2]), icon: anchor[3] ?? null, title: anchor[4], indent: line.length - line.trimStart().length });
    } else if (text === "<DL><p>") {
      stack.push(pending ?? root);
      pending = null;
    } else if (text === "</DL><p>") stack.pop();
  }
  assert.deepEqual(stack, [root], "every list is closed");
  return root.children;
}

test("an empty tree is the header, an empty bookmarks bar and the closing list, with CRLF line ends", () => {
  assert.equal(
    bookmarksHtml(emptyTree()),
    [...HEADER, '    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>', "    <DL><p>", "    </DL><p>", "</DL><p>", ""].join("\r\n"),
  );
});

test("the bar's bookmarks nest under the bar, and Other bookmarks' children sit at the top level, as Chromium writes them", () => {
  const tree = emptyTree();
  tree.bar.c = [
    link("a", "Ardia", "https://ardia.dev/", 1_710_000_000_000),
    folder("f", "Reading", 1_711_000_000_000, [
      link("b", "Deep", "https://example.com/deep", 1_712_000_000_500),
      folder("g", "Empty", 1_713_000_000_000),
      folder("h", "Deeper", 1_714_000_000_000, [link("c", "Leaf", "https://example.com/leaf", 1_715_000_000_000)]),
    ]),
  ];
  tree.other.c = [link("d", "Loose", "https://loose.example/", 1_716_000_000_000), folder("i", "Shelf", 1_717_000_000_000, [link("e", "On the shelf", "https://shelf.example/", 1_718_000_000_000)])];
  assert.equal(
    bookmarksHtml(tree),
    [
      ...HEADER,
      '    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1711000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
      "    <DL><p>",
      '        <DT><A HREF="https://ardia.dev/" ADD_DATE="1710000000">Ardia</A>',
      '        <DT><H3 ADD_DATE="1711000000" LAST_MODIFIED="1714000000">Reading</H3>',
      "        <DL><p>",
      '            <DT><A HREF="https://example.com/deep" ADD_DATE="1712000000">Deep</A>',
      '            <DT><H3 ADD_DATE="1713000000" LAST_MODIFIED="0">Empty</H3>',
      "            <DL><p>",
      "            </DL><p>",
      '            <DT><H3 ADD_DATE="1714000000" LAST_MODIFIED="1715000000">Deeper</H3>',
      "            <DL><p>",
      '                <DT><A HREF="https://example.com/leaf" ADD_DATE="1715000000">Leaf</A>',
      "            </DL><p>",
      "        </DL><p>",
      "    </DL><p>",
      '    <DT><A HREF="https://loose.example/" ADD_DATE="1716000000">Loose</A>',
      '    <DT><H3 ADD_DATE="1717000000" LAST_MODIFIED="1718000000">Shelf</H3>',
      "    <DL><p>",
      '        <DT><A HREF="https://shelf.example/" ADD_DATE="1718000000">On the shelf</A>',
      "    </DL><p>",
      "</DL><p>",
      "",
    ].join("\r\n"),
  );
  const parsed = parse(bookmarksHtml(tree));
  assert.deepEqual(parsed.map((node) => node.title), ["Bookmarks bar", "Loose", "Shelf"]);
  assert.equal(parsed[0].bar, true);
  assert.deepEqual(parsed[0].children[1].children.map((node) => node.title), ["Deep", "Empty", "Deeper"]);
  assert.equal(parsed[0].children[1].children[2].children[0].href, "https://example.com/leaf");
});

test("titles are escaped as HTML text and URLs only have their quotes escaped", () => {
  const tree = emptyTree();
  tree.bar.t = "Bar & <grill>";
  tree.bar.c = [
    link("a", `Tom & Jerry's <b>"best"</b>`, `https://example.com/?q="a"&b=<c>'d'`, 1_710_000_000_000),
    folder("f", `</H3><script>alert("x")</script>`, 1_711_000_000_000),
    link("u", "Ünïcødé 書籤 🔖", "https://example.com/%E6%9B%B8", 1_712_000_000_000),
  ];
  const html = bookmarksHtml(tree);
  assert.ok(html.includes("PERSONAL_TOOLBAR_FOLDER=\"true\">Bar &amp; &lt;grill&gt;</H3>"));
  assert.ok(html.includes(`<DT><A HREF="https://example.com/?q=&quot;a&quot;&b=<c>'d'" ADD_DATE="1710000000">Tom &amp; Jerry&#39;s &lt;b&gt;&quot;best&quot;&lt;/b&gt;</A>`));
  assert.ok(html.includes(`>&lt;/H3&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</H3>`));
  assert.ok(html.includes(">Ünïcødé 書籤 🔖</A>"));
  assert.equal(html.includes("<script>"), false);
  assert.equal((html.match(/<DT>/g) ?? []).length, 4);
});

test("dates are whole seconds since 1970, and a missing or bad date is 0", () => {
  const tree = emptyTree();
  tree.bar.a = 1_799_999_999_999;
  tree.bar.c = [link("a", "Half", "https://a.example/", 1_500), link("b", "None", "https://b.example/", 0), link("c", "Bad", "https://c.example/", "soon"), link("d", "Negative", "https://d.example/", -5)];
  const parsed = parse(bookmarksHtml(tree));
  assert.equal(parsed[0].added, 1_799_999_999);
  assert.equal(parsed[0].modified, 1);
  assert.deepEqual(parsed[0].children.map((node) => node.added), [1, 0, 0, 0]);
});

test("icons are written for the pages that have one, and a page's own properties are never read as an icon", () => {
  const tree = emptyTree();
  tree.bar.c = [link("a", "With", "https://with.example/", 1_000), link("b", "Without", "https://without.example/", 1_000), link("c", "Proto", "constructor", 1_000)];
  const parsed = parse(bookmarksHtml(tree, { "https://with.example/": "data:image/png;base64,AAAA" }));
  assert.deepEqual(parsed[0].children.map((node) => node.icon), ["data:image/png;base64,AAAA", null, null]);
});

test("a bookmark without a URL and a folder without children are written safely", () => {
  const tree = emptyTree();
  tree.bar.c = [{ id: "x", k: "u", t: "No URL", a: 1 }, { id: "y", k: "f", t: "No list", a: 2_000 }];
  delete tree.other.c;
  const parsed = parse(bookmarksHtml(tree));
  assert.deepEqual(parsed[0].children.map((node) => node.title), ["No list"]);
  assert.deepEqual(parsed[0].children[0].children, []);
});

test("the pages to fetch icons for are each bookmarked URL once", () => {
  const tree = emptyTree();
  tree.bar.c = [link("a", "A", "https://a.example/", 1), folder("f", "F", 1, [link("b", "A again", "https://a.example/", 1), link("c", "C", "https://c.example/", 1)])];
  tree.other.c = [link("d", "D", "https://d.example/", 1)];
  assert.deepEqual(bookmarkPages(tree), ["https://a.example/", "https://c.example/", "https://d.example/"]);
});
