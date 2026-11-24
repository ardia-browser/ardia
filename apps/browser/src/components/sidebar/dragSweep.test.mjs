import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { world, regionsOf } = await import("./fixtures/dragWorld.mjs");
const { S, entryKey, tailKey, mount, sceneLayout, readDrag } = D;

function listScene(hosts) {
  const W = world(...hosts);
  const L = sceneLayout({ top: 100 });
  const top = L.y;
  for (const h of hosts) L.row(W.id[h]);
  L.tail("list");
  return { ...W, L, regions: regionsOf(L, { list: [top, L.y] }) };
}

function slotOf(m, keys, r) {
  if (r.marks.split) return keys.indexOf(r.marks.split.key) + 0.5;
  if (!r.gapKey) return null;
  return r.gapKey === tailKey("list") ? keys.length : keys.indexOf(r.gapKey);
}

const { SPLIT_HOLD_MS } = await import("./dragModel.ts");

function overlaps(c) {
  const live = [...c.items.values()].filter((i) => i.frame && i.kind === "row" && !c.session.sources.includes(i)).sort((a, b) => a.frame.y - b.frame.y);
  const out = [];
  for (let i = 1; i < live.length; i++) {
    const above = c.shown(live[i - 1]);
    const below = c.shown(live[i]);
    if (below.y < above.y + above.h - 0.01) out.push(`${live[i - 1].key} ${above.y}+${above.h} over ${live[i].key} ${below.y}`);
  }
  return out;
}

const FRAME_MS = 16;

async function sweep(t, splitView, from, to, step, splitHoldMs = SPLIT_HOLD_MS, frameMs = FRAME_MS) {
  const hosts = ["a", "b", "c", "d", "e", "f", "g"];
  const m = listScene(hosts);
  const keys = hosts.map((h) => entryKey("tab", m.id[h]));
  const { c } = mount({ entries: m.L.entries, regions: m.regions, splitHoldMs });
  c.splitView = splitView;
  const d = m.L.entries.find((e) => e.key === keys[3]).frame;
  await c.begin(keys[3], d.x + 40, d.y + 17);
  const seen = [];
  const overlapped = [];
  for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
    c.move(d.x + 40, y);
    t.mock.timers.tick(frameMs);
    seen.push([y, slotOf(m, keys, readDrag(c))]);
    overlapped.push(...overlaps(c));
  }
  c.end(false);
  seen.overlapped = overlapped;
  return seen;
}

const flips = (seen, down) => {
  const out = [];
  let last = null;
  for (const [y, slot] of seen) {
    if (slot === null) continue;
    if (last !== null && (down ? slot < last.slot : slot > last.slot)) out.push(`${last.y}:${last.slot} -> ${y}:${slot}`);
    last = { y, slot };
  }
  return out;
};

for (const splitView of [false, true]) {
  test(`a slow sweep down and up the list moves the slot one way only (split view ${splitView ? "on" : "off"})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const hold of [SPLIT_HOLD_MS, 0]) {
      const down = await sweep(t, splitView, 90, 400, 0.5, hold);
      assert.deepEqual(flips(down, true), [], JSON.stringify(down.filter((s, i, a) => i === 0 || s[1] !== a[i - 1][1])));
      assert.deepEqual(down.overlapped, [], "no row is ever drawn over another");
      const up = await sweep(t, splitView, 400, 90, -0.5, hold);
      assert.deepEqual(flips(up, false), [], JSON.stringify(up.filter((s, i, a) => i === 0 || s[1] !== a[i - 1][1])));
      assert.deepEqual(up.overlapped, []);
    }
  });
}

test("passing over rows never lights a half: only a pointer resting in a row's middle arms it, and moving to another row starts over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const down = await sweep(t, true, 90, 400, 0.5);
  assert.ok(down.every(([, slot]) => slot === null || Number.isInteger(slot)), "no split while sweeping a frame at a time");
  const resting = await sweep(t, true, 90, 400, 0.5, SPLIT_HOLD_MS, 40);
  assert.ok(resting.some(([, slot]) => slot !== null && !Number.isInteger(slot)), "a crawl slow enough to rest 0.25 s within the slop does light a half, so the sweep runs the hold");
  const hosts = ["a", "b", "c", "d", "e"];
  const m = listScene(hosts);
  const keys = hosts.map((h) => entryKey("tab", m.id[h]));
  const { c } = mount({ entries: m.L.entries, regions: m.regions, splitHoldMs: SPLIT_HOLD_MS });
  c.splitView = true;
  const d = m.L.entries.find((e) => e.key === keys[3]).frame;
  await c.begin(keys[3], d.x + 40, d.y + 17);
  const middle = (key, fx) => {
    const f = c.shown(c.items.get(key));
    return [f.x + f.w * fx, f.y + f.h / 2];
  };
  c.move(...middle(keys[0], 0.75));
  assert.equal(readDrag(c).marks.split, null, "not at once");
  t.mock.timers.tick(SPLIT_HOLD_MS - 1);
  assert.equal(readDrag(c).marks.split, null);
  c.move(...middle(keys[1], 0.75));
  t.mock.timers.tick(SPLIT_HOLD_MS - 1);
  assert.equal(readDrag(c).marks.split, null, "a new row starts the hold over");
  t.mock.timers.tick(1);
  assert.deepEqual(readDrag(c).marks.split, { key: keys[1], side: "right" });
  c.move(...middle(keys[1], 0.25));
  assert.deepEqual(readDrag(c).marks.split, { key: keys[1], side: "left" }, "changing sides keeps it armed");
  c.move(60, d.y + 60);
  assert.equal(readDrag(c).marks.split, null);
  c.move(...middle(keys[1], 0.75));
  assert.equal(readDrag(c).marks.split, null, "leaving disarms it");
  c.end(false);
});

test("an armed half on one row never carries over to the next row's middle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hosts = ["a", "b", "c", "d", "e"];
  const m = listScene(hosts);
  const keys = hosts.map((h) => entryKey("tab", m.id[h]));
  const { c } = mount({ entries: m.L.entries, regions: m.regions, splitHoldMs: SPLIT_HOLD_MS });
  c.splitView = true;
  const e = m.L.entries.find((x) => x.key === keys[4]).frame;
  await c.begin(keys[4], e.x + 40, e.y + 17);
  const middle = (key, fx) => {
    const f = c.shown(c.items.get(key));
    return [f.x + f.w * fx, f.y + f.h / 2];
  };
  c.move(...middle(keys[1], 0.75));
  t.mock.timers.tick(SPLIT_HOLD_MS);
  assert.equal(readDrag(c).marks.split?.key, keys[1]);
  c.move(...middle(keys[2], 0.75));
  assert.notEqual(readDrag(c).marks.split?.key, keys[1]);
  assert.notEqual(readDrag(c).drop.type, "split");
  c.end(false);
});

test("a half arms only for a pointer at rest: one that keeps creeping through a row's middle restarts the hold", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hosts = ["a", "b", "c", "d", "e"];
  const m = listScene(hosts);
  const keys = hosts.map((h) => entryKey("tab", m.id[h]));
  const { c } = mount({ entries: m.L.entries, regions: m.regions, splitHoldMs: SPLIT_HOLD_MS });
  c.splitView = true;
  const e = m.L.entries.find((x) => x.key === keys[4]).frame;
  await c.begin(keys[4], e.x + 40, e.y + 17);
  const b = c.items.get(keys[1]);
  const at = (fy) => {
    const f = c.shown(b);
    return [f.x + f.w * 0.75, f.y + f.h * fy];
  };
  c.move(...at(0.5));
  for (const fy of [0.3, 0.45, 0.6, 0.45, 0.3]) {
    t.mock.timers.tick(SPLIT_HOLD_MS / 2);
    c.move(...at(fy));
  }
  assert.equal(readDrag(c).marks.split, null, "a pointer still moving 5 pt every eighth of a second never arms");
  t.mock.timers.tick(SPLIT_HOLD_MS);
  assert.equal(readDrag(c).marks.split?.key, keys[1], "resting arms it");
  c.end(false);
});

const { animations } = await import("../../test-native/reactNative.ts");

test("the list's end never moves during an in-list drag: the tail shows where it rests at every step, slow or fast", async () => {
  for (const step of [0.5, 6, 18, 30]) {
    const hosts = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const m = listScene(hosts);
    const keys = hosts.map((h) => entryKey("tab", m.id[h]));
    const { c } = mount({ entries: m.L.entries, regions: m.regions });
    const tail = c.items.get(tailKey("list"));
    const d = m.L.entries.find((e) => e.key === keys[3]).frame;
    await c.begin(keys[3], d.x + 40, d.y + 17);
    const rest = tail.frame.y;
    const moved = [];
    const bottom = m.L.entries.find((e) => e.key === keys.at(-1)).frame.y + 20;
    for (let y = d.y + 17; y <= bottom; y += step) {
      c.move(d.x + 40, y);
      if (Math.abs(c.shown(tail).y - rest) > 0.01) moved.push([y, c.shown(tail).y]);
    }
    for (let y = bottom; y >= 102; y -= step) {
      c.move(d.x + 40, y);
      if (Math.abs(c.shown(tail).y - rest) > 0.01) moved.push([y, c.shown(tail).y]);
    }
    c.end(false);
    assert.deepEqual(moved, [], `step ${step}`);
  }
});

test("collapse and gaps always add up to one row's room: every frame of a fast drag keeps the rows below where they were", async () => {
  const hosts = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const m = listScene(hosts);
  const keys = hosts.map((h) => entryKey("tab", m.id[h]));
  animations.held = true;
  try {
    const { c } = mount({ entries: m.L.entries, regions: m.regions });
    const source = c.items.get(keys[2]);
    const room = () => source.size.__getValue() + [...c.items.values()].reduce((sum, i) => sum + i.gap.__getValue(), 0);
    const progress = (fraction) => {
      for (const r of animations.running) if (r.value.running === r) r.value.move(r.value.__getValue() + (r.to - r.value.__getValue()) * fraction);
    };
    const s = m.L.entries.find((e) => e.key === keys[2]).frame;
    await c.begin(keys[2], s.x + 40, s.y + 17);
    const pitch = source.frame.h + D.GAP;
    const off = [];
    const check = (y) => Math.abs(room() - pitch) > 0.01 && off.push([y, room()]);
    check("begin");
    for (const y of [130, 200, 260, 330, 380, 300, 180, 110, 240, 360]) {
      c.move(s.x + 40, y);
      check(y);
      for (const f of [0.3, 0.5, 0.7]) {
        progress(f);
        check(`${y}@${f}`);
      }
    }
    assert.deepEqual(off, [], `room should stay ${pitch}`);
    c.end(false);
  } finally {
    animations.finish();
    animations.held = false;
  }
});
