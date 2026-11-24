import test from "node:test";
import assert from "node:assert/strict";

const { badgeFit, badgeTextWidth } = await import("./badgeFit.ts");

const fit = (textWidth, room) => badgeFit({ textWidth, room, roomyPad: 4, tightPad: 2, minScale: 0.6 });

test("text that fits with the roomy padding keeps it at full size", () => {
  assert.deepEqual(fit(5.5, 27), { pad: 4, scale: 1 });
  assert.deepEqual(fit(19, 27), { pad: 4, scale: 1 });
});

test("text that only fits with the tight padding takes it at full size", () => {
  assert.deepEqual(fit(19.5, 27), { pad: 2, scale: 1 });
  assert.deepEqual(fit(23, 27), { pad: 2, scale: 1 });
});

test("wider text shrinks to just under the room the tight padding leaves", () => {
  const { pad, scale } = fit(20, 21);
  assert.equal(pad, 2);
  assert.equal(scale, 16 / 20);
  assert.ok(20 * scale < 17);
});

test("text never shrinks below the minimum scale", () => {
  assert.deepEqual(fit(40, 21), { pad: 2, scale: 0.6 });
});

test("a measurement of the same text and size is used as it is", () => {
  assert.equal(badgeTextWidth({ text: "2.50", fontSize: 9, width: 19.4 }, "2.50", 9), 19.4);
});

test("until new text is measured, its width is estimated from the last measurement", () => {
  assert.equal(badgeTextWidth({ text: "WWWW", fontSize: 9, width: 36 }, "1", 9), 9);
  assert.equal(badgeTextWidth({ text: "9", fontSize: 9, width: 6 }, "10", 9), 12);
  assert.equal(badgeTextWidth({ text: "12", fontSize: 9, width: 12 }, "12", 12), 16);
});

test("a measurement of empty text estimates nothing", () => {
  assert.equal(badgeTextWidth({ text: "", fontSize: 9, width: 0 }, "12", 9), 0);
});
