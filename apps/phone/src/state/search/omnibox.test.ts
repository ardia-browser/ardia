import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSE_FOR_ME, enterTarget, idleRows, offersBrowseForMe, ROW_LIMIT, rowTarget, setSources, suggest, withBrowseForMe, withTypedQuery, type TrayRow } from "./omnibox.ts";

const context = { currentUrl: null, currentTabId: null };

test("tapping the top row does what Enter does, for addresses and for words", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  for (const text of ["https://www.google.com/search?q=otters", "example.com", "example.com/a/b", "otter facts"]) {
    for (const remote of [[], [text, "otters"]]) {
      const top = suggest(text, remote, context).rows[0]!;
      assert.deepEqual(rowTarget(top), enterTarget(text), `${text} with ${remote.length} remote`);
    }
  }
});

test("an address typed in full opens, from Enter and from every row that names it, and no row searches the engine for the address itself", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  for (const text of ["https://www.google.com/search?q=otters", "example.com", "example.com/a/b"]) {
    const rows = suggest(text, [text], context).rows;
    const target = enterTarget(text)!;
    assert.equal(target.origin, "typed");
    for (const row of rows) {
      const opens = rowTarget(row);
      if (opens?.origin === "search") assert.ok(!decodeURIComponent(opens.url).includes(text), `${text}: ${opens.url}`);
    }
    assert.ok(rows.some((row) => row.kind === "page" && rowTarget(row)?.url === target.url), text);
    const typedRow = rows.find((row) => row.kind === "query" && row.title === text);
    assert.ok(typedRow, text);
    assert.deepEqual(rowTarget(typedRow!), target, text);
  }
});

test("words search the engine from the row and from Enter alike", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  const target = enterTarget("otter facts")!;
  assert.equal(target.origin, "search");
  assert.match(target.url, /otter(%20|\+)facts/);
  assert.deepEqual(rowTarget(suggest("otter facts", [], context).rows[0]!), target);
});

test("the exact text typed always keeps a row of its own, second after the top result, within nine rows, an address included as main's SearchSuggestionsModel does", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  const page = (n: number): TrayRow => ({ key: `p:${n}`, kind: "page", title: `Otter ${n}`, detail: "example.com", url: `https://example.com/${n}`, favicon: null, tabId: null, switchesTab: false });
  const kept = withTypedQuery([page(1), page(2)], "otter");
  assert.deepEqual(kept.map((row) => row.kind), ["page", "query", "page"]);
  assert.equal(kept[1]!.title, "otter");
  assert.equal(withTypedQuery(Array.from({ length: 12 }, (_, n) => page(n)), "otter").length, ROW_LIMIT);
  const address = withTypedQuery([page(1)], "example.com");
  assert.deepEqual(address.map((row) => row.kind), ["page", "query"]);
  assert.deepEqual(rowTarget(address[1]!), enterTarget("example.com"));
  const already: TrayRow = { key: "q:Otter", kind: "query", title: "Otter", url: "https://www.google.com/search?q=Otter", query: "Otter" };
  assert.equal(withTypedQuery([already, page(1)], "otter").filter((row) => row.kind === "query").length, 1);
});

test("a visited page at the top of the suggestions stays put while you type on, with the typed search row second on every key (main's 513bc30a7)", () => {
  setSources({ tabs: [], history: [{ url: "https://en.wikipedia.org/wiki/Sintra", title: "Sintra - Wikipedia", favicon: null, visits: 12, lastVisit: Date.now() - 60_000 }], bookmarks: [] });
  let previous: string[] = [];
  let topped = 0;
  for (const text of ["s", "si", "sin", "sint", "sintr", "sintra"]) {
    for (const remote of [previous, [text, `${text} portugal`]]) {
      const rows = suggest(text, remote, context).rows;
      if (rows[0]?.kind !== "page") continue;
      topped += 1;
      assert.equal(rows[0].url, "https://en.wikipedia.org/wiki/Sintra", `${text}: the page stays first`);
      assert.deepEqual([rows[1]?.kind, rows[1]?.title], ["query", text], `${text}: the typed search row is second, before and after the answer for this text`);
    }
    previous = [text, `${text} portugal`];
  }
  assert.ok(topped >= 6, `the page led on only ${topped} of the 12 lists`);
});

test("a calculation reads as = value and keeps the value to copy; a Mac's tab shows its host and opens as a synced tab", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  const calc = suggest("12*12", [], context).rows.find((row) => row.kind === "calc");
  assert.ok(calc && calc.kind === "calc");
  assert.equal(calc.title, "= 144");
  assert.equal(calc.value, "144");
  const [mac] = idleRows([], [{ url: "https://www.swift.org/blog/", title: "Blog | Swift.org", deviceName: "MacBook Pro" }]);
  assert.ok(mac && mac.kind === "page");
  assert.equal(mac.detail, "swift.org");
  assert.equal(mac.fromMac, "MacBook Pro");
  assert.equal(rowTarget(mac)?.origin, "sync");
});

test("a plain search of three letters or more offers Browse for Me, an address, a bang or a short word doesn't, as main's SwiftUI offersResearch", () => {
  for (const text of ["otter facts", "how tall is everest", "abc", "  otters  "]) assert.equal(offersBrowseForMe(text), true, text);
  for (const text of ["ot", "example.com", "https://example.com/a", "!w otters", "otters !w", "", "   "]) assert.equal(offersBrowseForMe(text), false, text);
});

test("Browse for Me sits right under the typed search, carries the query, opens no address of its own and keeps the tray to nine rows", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  const rows = suggest("otter facts", ["otter facts for kids", "otter facts sea"], context, new Map(), true).rows;
  const typed = rows.findIndex((row) => row.kind === "query" && row.title === "otter facts");
  const browse = rows[typed + 1]!;
  assert.equal(browse.kind, "browseForMe");
  assert.equal(browse.title, BROWSE_FOR_ME);
  assert.equal(browse.detail, "otter facts");
  assert.equal(browse.kind === "browseForMe" ? browse.query : null, "otter facts");
  assert.equal(rowTarget(browse), null);
  assert.equal(rows.filter((row) => row.kind === "browseForMe").length, 1);
  const page = (n: number): TrayRow => ({ key: `p:${n}`, kind: "page", title: `Otter ${n}`, detail: "example.com", url: `https://example.com/${n}`, favicon: null, tabId: null, switchesTab: false });
  const full = withBrowseForMe(withTypedQuery(Array.from({ length: 12 }, (_, n) => page(n)), "otters"), "otters");
  assert.equal(full.length, ROW_LIMIT);
  assert.equal(full[2]!.kind, "browseForMe");
});

test("without the native page, as on Android, the tray never shows Browse for Me", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  assert.equal(suggest("otter facts", [], context).rows.some((row) => row.kind === "browseForMe"), false);
  assert.equal(suggest("example.com", [], context, new Map(), true).rows.some((row) => row.kind === "browseForMe"), false);
});

test("an untitled address row shows its path under the host", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  const rows = suggest("example.com/My Folder/index.html", [], context).rows;
  const guess = rows.find((row) => row.kind === "page" && row.url === "https://example.com/My%20Folder/index.html");
  assert.ok(guess && guess.kind === "page");
  assert.equal(guess.title, "example.com");
  assert.equal(guess.detail, "example.com/My%20Folder/index.html");
});

test("an untitled history row still shows only its host", () => {
  setSources({ tabs: [], history: [{ url: "https://example.com/foo?token=abc", title: "", favicon: null, visits: 5, lastVisit: Date.now() - 1000 }], bookmarks: [] });
  const row = suggest("foo", [], context).rows.find((r) => r.kind === "page" && r.url === "https://example.com/foo?token=abc");
  assert.ok(row && row.kind === "page");
  assert.equal(row.detail, "example.com");
});

test("the escaped row stays beside a tab open at another fragment, and shows its fragment", () => {
  const url = "https://example.com/My%20Folder/index.html";
  setSources({ tabs: [{ id: "t1", url: `${url}#tail`, title: "My Folder", favicon: null, lastActiveAt: Date.now() }], history: [{ url, title: "My Folder", favicon: null, visits: 3, lastVisit: Date.now() - 1000 }], bookmarks: [] });
  const rows = suggest("example.com/My Folder/index.html", [], context).rows;
  assert.ok(rows.some((r) => r.kind === "page" && r.url === url && !r.switchesTab), "the exact address is still offered");
  assert.ok(rows.some((r) => r.kind === "page" && r.switchesTab && r.tabId === "t1"), "and so is the tab at #tail");
  setSources({ tabs: [], history: [{ url: "https://example.com/#Chapter%202", title: "", favicon: null, visits: 3, lastVisit: Date.now() - 1000 }], bookmarks: [] });
  const chapter = suggest("example.com#Chapter 2", [], context).rows.find((r) => r.kind === "page");
  assert.ok(chapter && chapter.kind === "page");
  assert.match(chapter.detail, /#Chapter/);
});

test("a remote suggestion at the escaped row's address doesn't add a second row", () => {
  setSources({ tabs: [], history: [], bookmarks: [] });
  const rows = suggest("example.com#Chapter 2", ["https://EXAMPLE.com:443/#Chapter%202"], context).rows;
  assert.equal(rows.filter((r) => r.kind === "page").length, 1);
});

test("a tab open at the escaped address and a remote copy of it show as one Switch to Tab row", () => {
  setSources({ tabs: [{ id: "t2", url: "https://example.com/#Chapter%202", title: "Chapter", favicon: null, lastActiveAt: Date.now() }], history: [], bookmarks: [] });
  const pages = suggest("example.com#Chapter 2", ["https://example.com/#Chapter%202"], context).rows.filter((r) => r.kind === "page");
  assert.equal(pages.length, 1);
  assert.ok(pages[0]?.kind === "page" && pages[0].switchesTab);
});
