import assert from "node:assert/strict";
import { test } from "node:test";
const { WHATS_SENT } = await import("./copy.ts");

const MAC_NOTE =
  "Every 10 minutes Ardia notes on this Mac its tab, window and profile counts, its memory use, rough free disk space, the Mac's memory pressure, how long it has been open, and which of Ardia's own pages (like Settings or History) the tab in front was on, never a website's address. Ardia also takes that note when you open or leave one of those pages, and keeps the last 3 of those pages with how many minutes ago you were on each. That note is sent only with a crash report, or at the next launch after Ardia didn't quit cleanly, with whether the Mac restarted since. Turning sharing off or deleting a profile erases it";

test("the Mac's What's Sent keeps its ten-minute note word for word", () => {
  assert.ok(WHATS_SENT.some((group) => group.items.includes(MAC_NOTE)));
});

const items = WHATS_SENT.flatMap((group) => group.items);
const translation = items.filter((item) => item.startsWith("When a page's first translation pass ends"));

test("What's Sent says a translation that fails records the step it reached, a fixed reason and the kind of error the model reported, never text", () => {
  assert.equal(translation.length, 1);
  const [line] = translation;
  for (const part of ["first translation pass ends or is turned away before it starts", "tried again piece by piece, whether or not that second try worked", "was turned away or failed", "the step it reached", "one label from a short fixed list", "the language pair isn't available", "no window to ask about the language download in", "the page wasn't ready", "the translation model didn't answer", "the page closed", "the kind of error the translation model reported most", "a name from a fixed list", "how many errors it reported"])
    assert.ok(line.includes(part), part);
  assert.ok(line.endsWith("Never the page, its text or address, or an error's own words"));
});
