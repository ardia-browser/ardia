import assert from "node:assert/strict";
import test from "node:test";
import { mobileSetSources, mobileSuggest } from "@ardia/core/src/mobile.ts";

const WORDS = ["otter", "lisbon", "news", "wiki", "github", "docs", "example", "tapas", "train", "weather", "maps", "mail"];
const ADDRESS = "https://en.wikipedia.org/wiki/Otter_conservation_in_Lisbon";
const LARGE = 4000;
const SMALL = 40;
const REPEATS = 5;
const MAX_RATIO = 30;

const history = (count: number, now: number) =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://${WORDS[i % 12]}${i}.example.com/path/${i}?q=${WORDS[(i * 7) % 12]}`,
    title: `${WORDS[(i * 5) % 12]} page ${i}`,
    favicon: null,
    visits: 1 + (i % 9),
    lastVisit: now - i * 60_000,
  }));

test("typing a long address costs far less than a hundred times more with 4,000 history rows than with 40", () => {
  const now = Date.now();
  const tabs = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, url: `https://${WORDS[i % 12]}.org/${i}`, title: `Tab ${i}`, favicon: null }));
  const sources = { large: history(LARGE, now), small: history(SMALL, now) };
  const spent = { large: 0, small: 0 };
  const typeAddress = (measured: boolean) => {
    for (let i = 1; i <= ADDRESS.length; i++) {
      for (const size of ["small", "large"] as const) {
        mobileSetSources({ tabs, history: sources[size], bookmarks: [] });
        const began = performance.now();
        for (let r = 0; r < REPEATS; r++) mobileSuggest(ADDRESS.slice(0, i), { remote: [], preference: "website", limit: 8, now, currentUrl: null, currentTabId: null });
        if (measured) spent[size] += performance.now() - began;
      }
    }
  };
  typeAddress(false);
  typeAddress(true);
  const ratio = spent.large / spent.small;
  assert.ok(ratio < MAX_RATIO, `4,000 rows cost ${ratio.toFixed(1)}x 40 rows; a cost that grew with every row would be near ${LARGE / SMALL}x`);
});
