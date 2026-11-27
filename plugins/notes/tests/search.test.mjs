import { test } from "node:test";
import assert from "node:assert/strict";
import { load, rng } from "./support/build.mjs";

const M = await load();

const entry = (page, title, updatedAt = 1, extra = {}) => ({ workspace: "w", page, title, icon: "", kind: "page", path: [], updatedAt, live: true, ...extra });

test("folding drops case and diacritics", () => {
  assert.equal(M.fold("Crème BRÛLÉE Straße Øre"), "creme brulee strasse ore");
  assert.deepEqual(M.tokens("Hello, wörld! 42x"), ["hello", "world", "42x"]);
});

test("titles outrank text, exact words outrank prefixes, recency breaks ties", () => {
  const index = new M.SearchIndex();
  index.upsert(entry("p1", "Weekly meeting notes", 10), "agenda and actions");
  index.upsert(entry("p2", "Groceries", 20), "remember the meeting with Sam");
  index.upsert(entry("p3", "Meetings archive", 30), "");
  index.upsert(entry("p4", "Meeting", 5), "");
  index.upsert(entry("p5", "Meeting", 50), "");
  const hits = index.search("meeting");
  assert.deepEqual(hits.map((h) => h.page), ["p5", "p4", "p1", "p3", "p2"]);
  assert.deepEqual(index.search("meet").map((h) => h.page).slice(0, 2).sort(), ["p4", "p5"]);
});

test("every word must match, as a prefix", () => {
  const index = new M.SearchIndex();
  index.upsert(entry("p1", "Project plan"), "budget for the launch in spring");
  index.upsert(entry("p2", "Project retro"), "what went well");
  assert.deepEqual(index.search("proj laun").map((h) => h.page), ["p1"]);
  assert.deepEqual(index.search("proj").length, 2);
  assert.deepEqual(index.search("proj zebra"), []);
});

test("diacritics match both ways", () => {
  const index = new M.SearchIndex();
  index.upsert(entry("p1", "Café crème"), "Résumé of the naïve approach");
  assert.equal(index.search("cafe")[0]?.page, "p1");
  assert.equal(index.search("CAFÉ")[0]?.page, "p1");
  assert.equal(index.search("resume naive")[0]?.page, "p1");
  assert.match(index.search("naive")[0].snippet, /naïve/);
});

test("snippets centre on the first match and stay short", () => {
  const index = new M.SearchIndex();
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
  index.upsert(entry("p1", "Long page"), `${filler}The secret ingredient is cardamom and patience. ${filler}`);
  const [hit] = index.search("cardamom");
  assert.ok(hit.snippet.length <= 160, `snippet is ${hit.snippet.length}`);
  assert.match(hit.snippet, /cardamom/);
  assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"));
  const [titleOnly] = index.search("long");
  assert.ok(titleOnly.snippet.startsWith("Lorem ipsum"));
  assert.ok(titleOnly.snippet.length <= 160);
});

test("archived pages, other workspaces and titlesOnly are respected", () => {
  const index = new M.SearchIndex();
  index.upsert(entry("p1", "Alpha", 1, { live: false }), "");
  index.upsert(entry("p2", "Alpha two", 1, { workspace: "x" }), "");
  index.upsert(entry("p3", "Beta"), "alpha in the body");
  assert.deepEqual(index.search("alpha").map((h) => h.page).sort(), ["p2", "p3"]);
  assert.deepEqual(index.search("alpha", { workspace: "w" }).map((h) => h.page), ["p3"]);
  assert.deepEqual(index.search("alpha", { titlesOnly: true }).map((h) => h.page), ["p2"]);
  index.remove("w", "p3");
  assert.deepEqual(index.search("alpha").map((h) => h.page), ["p2"]);
});

test("mid-word and CJK text still match through the substring pass", () => {
  const index = new M.SearchIndex();
  index.upsert(entry("p1", "東京の旅行"), "");
  index.upsert(entry("p2", "Notebook"), "");
  assert.equal(index.search("旅行")[0]?.page, "p1");
  assert.equal(index.search("ebook")[0]?.page, "p2");
});

test("updates replace the old text", () => {
  const index = new M.SearchIndex();
  index.upsert(entry("p1", "Note"), "old words");
  index.setText("w", "p1", "new words");
  assert.deepEqual(index.search("old"), []);
  assert.equal(index.search("new")[0]?.page, "p1");
});

test("answers in a few ms over thousands of pages", () => {
  const index = new M.SearchIndex();
  const random = rng(5);
  const words = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}${"abcdefghij"[i % 10]}`);
  const pick = () => words[Math.floor(random() * words.length)];
  for (let i = 0; i < 5000; i++) {
    const text = Array.from({ length: 300 }, pick).join(" ");
    index.upsert(entry(`p${i}`, `${pick()} ${pick()} ${pick()}`, i), text);
  }
  const queries = ["w1", "w2a", "w3b w4", "wzz", "w10 w20", "w5"];
  for (const q of queries) index.search(q, { limit: 8 });
  const start = performance.now();
  for (let i = 0; i < 20; i++) for (const q of queries) index.search(q, { limit: 8 });
  const each = (performance.now() - start) / (20 * queries.length);
  assert.ok(each < 25, `a query took ${each.toFixed(2)} ms`);
  console.log(`search: ${each.toFixed(2)} ms a query over 5000 pages`);
});
