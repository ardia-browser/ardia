import assert from "node:assert/strict";
import { test } from "node:test";

const { FOLD_ROWS_PER_FRAME, foldRows, nextFoldMount, rowsWithin } = await import("./foldRows.ts");

const ROW = 30;
const GAP = 2;
const rows = (n) => Array.from({ length: n }, (_, i) => ({ key: `tab:t${i}` }));
const height = () => ROW;
const plan = (entries, opts) => foldRows(entries, { kept: new Set(), spacers: true, ghosts: true, heightOf: height, gap: GAP, reach: 320, ...opts });

test("opening mounts only the rows that can show in the window, and the rest grow in a few at a time once it settles", () => {
  const entries = rows(200);
  const within = rowsWithin(entries, height, GAP, 320);
  assert.equal(within, 10);
  let mount = nextFoldMount({ collapsed: true, shown: 0 }, false, entries, height, GAP, 320);
  assert.deepEqual(mount, { collapsed: false, shown: 10 });
  mount = nextFoldMount(mount, false, entries, height, GAP, 320, true);
  assert.equal(mount.shown, 10 + FOLD_ROWS_PER_FRAME);
  for (let i = 0; i < 200; i++) mount = nextFoldMount(mount, false, entries, height, GAP, 320, true);
  assert.equal(mount.shown, Infinity);
});

test("closing keeps every mounted row, so opening it again mounts nothing", () => {
  const entries = rows(20);
  let mount = nextFoldMount({ collapsed: false, shown: Infinity }, true, entries, height, GAP, 320);
  assert.deepEqual(mount, { collapsed: true, shown: 20 });
  assert.equal(nextFoldMount(mount, true, entries, height, GAP, 320, true), mount);
  assert.deepEqual(nextFoldMount(mount, false, entries, height, GAP, 320), { collapsed: false, shown: Infinity });
});

test("the fill stops at the last entry for one frame before it calls itself done, so a group it mounts last still gets sliced", () => {
  const entries = rows(10);
  const last = nextFoldMount({ collapsed: false, shown: 8 }, false, entries, height, GAP, 320, true);
  assert.deepEqual(last, { collapsed: false, shown: 10 });
  assert.deepEqual(nextFoldMount(last, false, entries, height, GAP, 320, true), { collapsed: false, shown: Infinity });
});

test("rows not mounted yet stand in as one spacer of their height and gaps, so the fold is as tall as it will be", () => {
  const entries = rows(10);
  const slots = plan(entries, { shown: 4 });
  assert.deepEqual(slots.map((s) => s.kind), ["row", "row", "row", "row", "spacer"]);
  assert.equal(slots[4].height, 6 * ROW + 5 * GAP);
  const total = slots.reduce((sum, s) => sum + (s.kind === "spacer" ? s.height : ROW), 0) + GAP * (slots.length - 1);
  assert.equal(total, 10 * ROW + 9 * GAP);
});

test("a kept row stays mounted past the spacer, and the spacer splits around it", () => {
  const entries = rows(10);
  const slots = plan(entries, { shown: 2, kept: new Set(["tab:t6"]) });
  assert.deepEqual(slots.map((s) => (s.kind === "row" ? entries[s.index].key : `${s.kind}:${s.height}`)), ["tab:t0", "tab:t1", `spacer:${4 * ROW + 3 * GAP}`, "tab:t6", `spacer:${3 * ROW + 2 * GAP}`]);
  assert.equal(plan(entries, { shown: 2, kept: new Set(["tab:t6"]), spacers: false }).length, 3);
});

test("rows that start past the window's height are out of reach, so they snap instead of moving", () => {
  const slots = plan(rows(12), { shown: Infinity, reach: 100 });
  assert.deepEqual(slots.map((s) => s.inReach), [true, true, true, true, false, false, false, false, false, false, false, false]);
});

test("ghosts take no room and show only while the fold is open", () => {
  const entries = [{ key: "tab:a" }, { key: "ghost:1", ghost: true }, { key: "tab:b" }];
  assert.equal(rowsWithin(entries, height, GAP, 40), 3);
  assert.deepEqual(plan(entries, { shown: Infinity }).map((s) => s.index), [0, 1, 2]);
  assert.deepEqual(plan(entries, { shown: Infinity, ghosts: false }).map((s) => s.index), [0, 2]);
});
