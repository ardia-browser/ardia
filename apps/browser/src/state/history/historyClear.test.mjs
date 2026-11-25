import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("../browser/store.ts");
const { historyOf } = await import("./history.ts");
const { seedHistory } = await import("../../../../../packages/demo/src/seed.ts");

test("successive range clears keep the newest surviving date in newest-first demo history", () => {
  const now = 2_000_000_000_000;
  const day = 86_400_000;
  const seeded = seedHistory([{ url: "https://history.example/", title: "History" }], () => null, now);
  const originalTimes = seeded[0].visitTimes.slice();
  useBrowser.getState().hydrate({});
  useBrowser.setState({ history: { "": { list: seeded, floor: -Infinity, ready: true } } });
  useBrowser.getState().clearHistory("default", now - day, now);
  const afterDay = historyOf(useBrowser.getState(), "default")[0];
  const firstLastVisit = afterDay.lastVisit;
  useBrowser.getState().clearHistory("default", now - 7 * day, now);
  const afterWeek = historyOf(useBrowser.getState(), "default")[0];
  assert.deepEqual({
    firstLastVisit,
    remainingTimes: afterWeek.visitTimes,
    lastVisit: afterWeek.lastVisit,
    visits: afterWeek.visits,
  }, {
    firstLastVisit: now - day - 3_600_000,
    remainingTimes: originalTimes.filter((at) => at < now - 7 * day).sort((a, b) => a - b),
    lastVisit: now - 7 * day - 3_600_000,
    visits: 7,
  });
  assert.deepEqual(seeded[0].visitTimes, originalTimes, "the original history is not reordered in place");
});
