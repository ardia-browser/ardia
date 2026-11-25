import assert from "node:assert/strict";
import { test } from "node:test";
const { peekGeometry } = await import("./peekGeometry.ts");

const input = (o = {}) => ({ width: 1200, height: 800, pageTop: 44, bar: 38, inset: 6, cardRadius: 18, paneRadius: 10, from: { x: 300, y: 200 }, fullscreen: false, ...o });

test("off the Mac the card is main's frame, 5.5 % inset each side, and the page fills it under the bar", () => {
  const g = peekGeometry(input({ pageAtTabSize: false }));
  assert.deepEqual(g.card, { x: 66, y: 44, width: 1068, height: 712 });
  assert.deepEqual(g.rest, { x: 72, y: 82, width: 1056, height: 668 });
  assert.deepEqual(g.page, g.rest);
});

test("off the Mac, side buttons push the frame in on their side only", () => {
  const g = peekGeometry(input({ pageAtTabSize: false, sideRoom: { left: 0, right: 100 } }));
  assert.equal(g.card.x, 66);
  assert.equal(g.card.width, 1200 - 66 - 100);
});

test("on the Mac, side buttons keep the card clear of them and centred in what is left", () => {
  const g = peekGeometry(input({ sideRoom: { left: 100, right: 0 } }));
  assert.ok(g.card.x >= 100);
  assert.ok(Math.abs(g.card.x - 100 - (1200 - 66 - (g.card.x + g.card.width))) < 1e-9);
});

test("on the Mac the page keeps its tab size and the card fits it at one scale", () => {
  const g = peekGeometry(input());
  assert.deepEqual(g.page, { x: 0, y: 44, width: 1200, height: 756 });
  assert.ok(Math.abs(g.rest.width / g.page.width - g.rest.height / g.page.height) < 1e-9);
});

test("full screen shows the page over the whole stage on every platform", () => {
  for (const pageAtTabSize of [true, false]) assert.deepEqual(peekGeometry(input({ fullscreen: true, pageAtTabSize })).page, { x: 0, y: 0, width: 1200, height: 800 });
});

test("a frameless Peek clips only the page corners that touch the bottom of the card", () => {
  const g = peekGeometry(input({ inset: 0, paneRadius: 0 }));
  assert.equal(g.rest.y + g.rest.height, g.card.y + g.card.height);
  assert.equal(g.restBottomRadius, 18);
  assert.equal(g.restRadius, 0);
  assert.equal(g.tabBottomRadius, 0);
});

test("an inset Peek keeps the page frame radius on both edges", () => {
  const g = peekGeometry(input());
  assert.equal(g.restBottomRadius, 10);
  assert.equal(g.restRadius, 10);
  assert.equal(g.tabBottomRadius, 10);
});
