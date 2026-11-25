import assert from "node:assert/strict";
import { test } from "node:test";
import { poolFor, tabsOver } from "./candidatePool.ts";
import { buildSuggestions } from "./suggest.ts";

const now = Date.UTC(2026, 8, 24);

function callsTo(holder: object, name: string, run: () => void): number {
  const target = holder as Record<string, (...args: unknown[]) => unknown>;
  const original = target[name]!;
  let calls = 0;
  target[name] = function (this: unknown, ...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    target[name] = original;
  }
  return calls;
}

function historyOf(count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push({ url: `https://react${i}.dev/docs/${i}`, title: `React native perf notes ${i}`, favicon: null, visits: 1 + (i % 5), lastVisit: now - i * 1000 });
  return rows;
}

function typePhrase(source: Parameters<typeof buildSuggestions>[1]) {
  const q = "react native perf";
  for (let i = 1; i <= q.length; i++) buildSuggestions(q.slice(0, i), source, { now });
}

test("with no renamed tab, typing does no per-candidate rename lookup, however many pages match", () => {
  const tabs = [{ id: "t1", url: "https://example.com/", title: "Example", favicon: null }];
  const few = { tabs, history: historyOf(50), bookmarks: [] };
  const many = { tabs, history: historyOf(2000), bookmarks: [] };
  buildSuggestions("x", few, { now });
  buildSuggestions("x", many, { now });
  assert.equal(callsTo(Set.prototype, "has", () => typePhrase(many)), callsTo(Set.prototype, "has", () => typePhrase(few)));
});

test("a renamed tab still stands in for its page's own row while the phrase is typed", () => {
  const history = historyOf(50);
  const tabs = [{ id: "t1", url: history[3]!.url, title: history[3]!.title, customTitle: "Perf board", favicon: null }];
  const result = buildSuggestions("react3.dev", { tabs, history, bookmarks: [] }, { now });
  const rows = result.items.filter((s) => s.kind === "page" && s.url === history[3]!.url);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind === "page" ? rows[0]!.tabId : null, "t1");
});

test("the open-tab rows keep the first tab of each page that has no saved row", () => {
  const pool = poolFor(historyOf(20), []);
  const tabs = [];
  for (let i = 0; i < 200; i++) tabs.push({ id: `t${i}`, url: `https://tab${i % 150}.dev/`, title: `Tab ${i}`, favicon: null });
  tabs.push({ id: "saved", url: "https://react2.dev/docs/2", title: "Saved", favicon: null });
  const built = tabsOver(pool, tabs);
  assert.deepEqual(
    built.extra.map((c) => c.tabId),
    tabs.slice(0, 150).map((t) => t.id),
  );
  assert.equal(built.tabIds.get(built.extra[3]!.text.key), "t3");
  assert.equal(built.tabIds.size, 151);
});

test("a renamed tab is the one a page's switch row goes to, wherever it sits among that page's tabs", () => {
  const pool = poolFor([], []);
  const tabs = [
    { id: "a", url: "https://docs.dev/", title: "Docs", favicon: null },
    { id: "b", url: "https://docs.dev/", title: "Docs", customTitle: "My docs", favicon: null },
    { id: "c", url: "https://docs.dev/", title: "Docs", favicon: null },
  ];
  const built = tabsOver(pool, tabs);
  assert.deepEqual([...built.tabIds.values()], ["b"]);
  assert.deepEqual(
    built.extra.map((c) => c.tabId),
    ["b"],
  );
});
