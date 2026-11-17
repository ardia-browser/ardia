import assert from "node:assert/strict";
import { test } from "node:test";
const { WHATS_SENT } = await import("./copy.ts");

const MAC_NOTE =
  "Every 10 minutes Ardia notes on this Mac its tab, window and profile counts, its memory use, rough free disk space, the Mac's memory pressure, how long it has been open, and which of Ardia's own pages (like Settings or History) the tab in front was on, never a website's address. Ardia also takes that note when you open or leave one of those pages, and keeps the last 3 of those pages with how many minutes ago you were on each. That note is sent only with a crash report, or at the next launch after Ardia didn't quit cleanly, with whether the Mac restarted since. Turning sharing off or deleting a profile erases it";

test("the Mac's What's Sent keeps its ten-minute note word for word", () => {
  assert.ok(WHATS_SENT.some((group) => group.items.includes(MAC_NOTE)));
});

test("What's Sent says a crash report names the termination reason's code and description, the exception codes, and the crashed thread and queue", () => {
  const crashes = WHATS_SENT.flatMap((group) => group.items).filter((item) => item.startsWith("The same for crashes of Ardia's page, graphics and helper processes"));
  assert.equal(crashes.length, 1);
  for (const phrase of ["termination reason", "code and short description", "exception codes", "thread and queue that crashed"]) assert.ok(crashes[0].includes(phrase), phrase);
});
