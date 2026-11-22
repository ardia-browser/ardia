import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_ARCHIVED, DEMO_HISTORY, DEMO_OPEN, demoSeed } from "./demoSeed.ts";

test("the demo store holds Compose's DemoSeed: eight open tabs, four archived, seven typed visits, backdated from now", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  let next = 0;
  const rows = demoSeed(now, () => `t${++next}`);
  const open = rows.tabs.filter((tab) => tab.archivedAt === null);
  const archived = rows.tabs.filter((tab) => tab.archivedAt !== null);
  assert.equal(open.length, DEMO_OPEN.length);
  assert.equal(archived.length, DEMO_ARCHIVED.length);
  assert.equal(rows.visits.length, DEMO_HISTORY.length);
  const newest = open.reduce((best, tab) => (tab.lastActive > best.lastActive ? tab : best));
  assert.equal(newest.title, "Sintra - Wikipedia", "the newest open tab is the one selected");
  assert.equal(newest.lastActive, now - 3 * 60_000);
  const timeOut = archived.find((tab) => tab.title === "Time Out Lisbon")!;
  assert.equal(timeOut.archivedAt, now - 300 * 60_000);
  assert.equal(timeOut.lastActive, timeOut.archivedAt! - 600_000);
  assert.ok(rows.visits.every((visit) => visit.transition === "typed" && visit.visitedAt < now));
  assert.equal(new Set(rows.tabs.map((tab) => tab.id)).size, rows.tabs.length);
});

test("the lab's ArdiaDemoScale adds that many archived tabs and three times as many visits over 30 days, each its own address", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  let next = 0;
  const rows = demoSeed(now, () => `id-${next++}`, 1000);
  const archived = rows.tabs.filter((tab) => tab.archivedAt !== null);
  assert.equal(archived.length, DEMO_ARCHIVED.length + 1000);
  assert.equal(rows.visits.length, DEMO_HISTORY.length + 3000);
  assert.equal(new Set(archived.map((tab) => tab.url)).size, archived.length);
  const oldest = Math.min(...archived.map((tab) => tab.archivedAt!));
  assert.ok(now - oldest <= 31 * 24 * 3_600_000 && now - oldest >= 29 * 24 * 3_600_000);
  assert.equal(rows.tabs.filter((tab) => tab.archivedAt === null).length, DEMO_OPEN.length);
  assert.deepEqual(demoSeed(now, () => "x").tabs.length, DEMO_ARCHIVED.length + DEMO_OPEN.length);
});
