import assert from "node:assert/strict";
import { test } from "node:test";
const { WHATS_SENT } = await import("./copy.ts");

const MAC_NOTE =
  "Every 10 minutes Ardia notes on this Mac its tab, window and profile counts, its memory use, rough free disk space, the Mac's memory pressure, how long it has been open, and which of Ardia's own pages (like Settings or History) the tab in front was on, never a website's address. Ardia also takes that note when you open or leave one of those pages. That note is sent only with a crash report, or at the next launch after Ardia didn't quit cleanly, with whether the Mac restarted since. Turning sharing off or deleting a profile erases it";

test("the Mac's What's Sent keeps its ten-minute note word for word", () => {
  assert.ok(WHATS_SENT.some((group) => group.items.includes(MAC_NOTE)));
});
