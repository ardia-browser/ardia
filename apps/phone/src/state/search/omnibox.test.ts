import assert from "node:assert/strict";
import { test } from "node:test";
import { enterTarget, idleRows, ROW_LIMIT, rowTarget, setSources, suggest, withTypedQuery, type TrayRow } from "./omnibox.ts";

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
