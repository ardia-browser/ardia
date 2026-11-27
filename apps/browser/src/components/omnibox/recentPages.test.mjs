import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.require ??= (id) => ({ asset: id });
const { recentPages } = await import("./dropdownStart.ts");
const { withoutFragment } = await import("../../lib/url.ts");

function sortedReference(history, shownUrl, count) {
  const seen = new Set(shownUrl ? [withoutFragment(shownUrl)] : []);
  const out = [];
  for (const h of [...history].sort((a, b) => b.lastVisit - a.lastVisit)) {
    const key = withoutFragment(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length === count) break;
  }
  return out;
}

function randomHistory(seed, size) {
  let x = seed;
  const next = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: size }, (_, i) => ({ url: `https://s${Math.floor(next() * 12)}.example/${Math.floor(next() * 6)}${next() < 0.3 ? `#${i}` : ""}`, lastVisit: Math.floor(next() * 40), id: i }));
}

test("#2433: the sidebar bar's recent pages are the newest four distinct pages, as the full sort found them, without sorting the history", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const history = randomHistory(seed, 1 + (seed % 60));
    const shown = seed % 3 ? history[seed % history.length].url : "";
    assert.deepEqual(recentPages(history, shown, 4).map((h) => h.id), sortedReference(history, shown, 4).map((h) => h.id), `seed ${seed}`);
  }
});

test("#2433: the shown page and its fragments are left out, and fewer pages than asked give what there is", () => {
  const history = [
    { url: "https://a.example/#x", lastVisit: 9 },
    { url: "https://b.example/", lastVisit: 8 },
    { url: "https://a.example/", lastVisit: 7 },
  ];
  assert.deepEqual(recentPages(history, "https://a.example/", 4).map((h) => h.url), ["https://b.example/"]);
  assert.deepEqual(recentPages([], "", 4), []);
});
