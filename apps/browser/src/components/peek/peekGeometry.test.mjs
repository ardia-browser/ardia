import assert from "node:assert/strict";
import { test } from "node:test";
const { peekGeometry } = await import("./peekGeometry.ts");

const input = (o = {}) => ({ width: 1200, height: 800, pageTop: 44, bar: 38, inset: 6, restRadius: 10, paneRadius: 10, from: { x: 300, y: 200 }, fullscreen: false, ...o });

test("off the Mac the card is main's frame, 5.5 % inset each side, and the page fills it under the bar", () => {
  const g = peekGeometry(input({ fitToTab: false }));
  assert.deepEqual(g.card, { x: 66, y: 44, width: 1068, height: 712 });
  assert.deepEqual(g.rest, { x: 72, y: 82, width: 1056, height: 668 });
  assert.deepEqual(g.page, g.rest);
});

test("off the Mac, side buttons push the frame in on their side only", () => {
  const g = peekGeometry(input({ fitToTab: false, sideRoom: { left: 0, right: 100 } }));
  assert.equal(g.card.x, 66);
  assert.equal(g.card.width, 1200 - 66 - 100);
});

test("on the Mac, side buttons keep the card clear of them and centred in what is left", () => {
  const g = peekGeometry(input({ sideRoom: { left: 100, right: 0 } }));
  assert.ok(g.card.x >= 100);
  assert.ok(Math.abs(g.card.x - 100 - (1200 - 66 - (g.card.x + g.card.width))) < 1e-9);
});

test("on the Mac a resting Peek lays its page out at the card's own size, drawn 1:1, with the tab's shape", () => {
  const g = peekGeometry(input());
  assert.deepEqual(g.page, g.rest, "the page is laid out at the slot it is shown in, not scaled into it");
  assert.deepEqual(g.tab, { x: 0, y: 44, width: 1200, height: 756 });
  assert.ok(Math.abs(g.rest.width / g.tab.width - g.rest.height / g.tab.height) < 1e-9, "the slot keeps the tab's aspect ratio");
});

test("on the Mac a Peek opening as a tab lays its page out at the tab's size", () => {
  const g = peekGeometry(input({ atTabSize: true }));
  assert.deepEqual(g.page, { x: 0, y: 44, width: 1200, height: 756 });
  assert.deepEqual(g.page, g.tab);
  assert.deepEqual(g.card, peekGeometry(input()).card, "the card stays where it was");
});

test("full screen shows the page over the whole stage on every platform", () => {
  for (const fitToTab of [true, false]) assert.deepEqual(peekGeometry(input({ fullscreen: true, fitToTab })).page, { x: 0, y: 0, width: 1200, height: 800 });
});
