import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { splitSuggestions } = await import("./suggestions.ts");

const S = () => useBrowser.getState();

function windowWith(tabs) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://empty.example/" });
  const empty = S().windows[w].tabIds[0];
  S().updateTab(empty, { lastActiveAt: 1000 });
  const ids = tabs.map(([url, title], i) => {
    const id = S().newTab(w, { url, background: true });
    S().updateTab(id, { title, lastActiveAt: 2000 + i * 60_000 });
    return id;
  });
  return { w, empty, ids };
}

const EIGHT = [
  ["https://github.com/ardia-browser/ardia", "ardia-browser/ardia"],
  ["https://news.ycombinator.com/", "Hacker News"],
  ["https://docs.example.com/guide", "Guide"],
  ["https://mail.example.org/inbox", "Inbox"],
  ["https://github.com/pulls", "Pull requests"],
  ["https://maps.example.net/", "Maps"],
  ["https://weather.example.io/", "Weather"],
  ["https://music.example.com/", "Music"],
];

test("with nothing typed, the card lists the five most recently used tabs", () => {
  const { empty, ids } = windowWith(EIGHT);
  assert.deepEqual(splitSuggestions(S(), empty, ""), [ids[7], ids[6], ids[5], ids[4], ids[3]]);
  assert.deepEqual(splitSuggestions(S(), empty, "   "), [ids[7], ids[6], ids[5], ids[4], ids[3]], "blank text is nothing typed");
});

test("typed text narrows the list to tabs whose title, site or address match, best match first", () => {
  const { empty, ids } = windowWith(EIGHT);
  const git = splitSuggestions(S(), empty, "github");
  assert.deepEqual(new Set(git), new Set([ids[0], ids[4]]), "only the two github tabs");
  assert.equal(git[0], ids[4], "equal matches keep the most recently used first");
  assert.deepEqual(splitSuggestions(S(), empty, "hacker"), [ids[1]], "a page title");
  assert.deepEqual(splitSuggestions(S(), empty, "weather.example"), [ids[6]], "an address");
  assert.deepEqual(splitSuggestions(S(), empty, "zzzzqq"), [], "nothing matches");
});

test("a tab's custom title is matched, not the page's own", () => {
  const { empty, ids } = windowWith(EIGHT);
  S().updateTab(ids[2], { customTitle: "Quarterly budget" });
  assert.deepEqual(splitSuggestions(S(), empty, "budget"), [ids[2]]);
});

test("the list is capped at five matches", () => {
  const { empty } = windowWith(Array.from({ length: 8 }, (_, i) => [`https://shop.example.com/${i}`, `Shop ${i}`]));
  assert.equal(splitSuggestions(S(), empty, "shop").length, 5);
});

test("tabs already in the split and other windows' tabs are never listed", () => {
  const { w, empty, ids } = windowWith(EIGHT);
  S().createSplit([empty, ids[7]]);
  assert.ok(!splitSuggestions(S(), empty, "").includes(ids[7]), "a pane of this split");
  assert.ok(!splitSuggestions(S(), empty, "music").includes(ids[7]), "even when it matches what was typed");
  assert.ok(!splitSuggestions(S(), empty, "").includes(empty), "the empty pane itself");
  const other = S().createWindow({ url: "https://github.com/elsewhere" });
  assert.notEqual(other, w);
  assert.ok(!splitSuggestions(S(), empty, "elsewhere").length, "another window's tab");
});
