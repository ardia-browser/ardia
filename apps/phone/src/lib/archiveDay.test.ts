import assert from "node:assert/strict";
import test from "node:test";
import { archiveDayKind, archiveDayTitle } from "./archiveDay.ts";

const now = new Date(2026, 10, 14, 15, 0).getTime();
const daysAgo = (days: number) => new Date(2026, 10, 14 - days, 9, 30).getTime();

test("archive days read Today, Yesterday, the weekday within six days, then the date, with the year only when it differs", () => {
  assert.equal(archiveDayKind(daysAgo(0), now), "today");
  assert.equal(archiveDayKind(daysAgo(1), now), "yesterday");
  assert.equal(archiveDayKind(daysAgo(2), now), "weekday");
  assert.equal(archiveDayKind(daysAgo(6), now), "weekday");
  assert.equal(archiveDayKind(daysAgo(7), now), "monthDay");
  assert.equal(archiveDayKind(new Date(2025, 11, 30).getTime(), now), "monthDayYear");
  assert.equal(archiveDayTitle(daysAgo(2), now, "en-US"), "Thursday");
  assert.equal(archiveDayTitle(daysAgo(10), now, "en-US"), "November 4");
  assert.equal(archiveDayTitle(new Date(2025, 11, 30).getTime(), now, "en-US"), "December 30, 2025");
});
