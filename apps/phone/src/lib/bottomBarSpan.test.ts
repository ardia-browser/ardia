import assert from "node:assert/strict";
import test from "node:test";
import { besideStrip, bottomBarLayout, DUO_PLUS_ABOVE, duoFieldReach, duoSqueeze, isOpenDuo } from "./bottomBarSpan.ts";

test("with no hinge every bottom bar pads by the larger side inset plus its own side, on both sides, and nothing goes to a strip", () => {
  assert.deepEqual(bottomBarLayout(402, { left: 0, right: 0 }, "none", 24), { span: { left: 24, right: 24 }, strip: null });
  assert.deepEqual(bottomBarLayout(852, { left: 59, right: 59 }, "none", 24), { span: { left: 83, right: 83 }, strip: null });
  assert.deepEqual(bottomBarLayout(874, { left: 62, right: 0 }, "none", 24), { span: { left: 86, right: 86 }, strip: null });
  assert.deepEqual(bottomBarLayout(1032, { left: 0, right: 0 }, "none", 24), { span: { left: 24, right: 24 }, strip: null });
});

const CLOSED_STRIP = { side: "right", centerX: 418, plus: -55, tabs: 0, ends: false };
const OPEN_STRIP = { side: "right", centerX: 903, plus: -110, tabs: -55, ends: true } as const;

test("on the closed Duo the capsule runs from 24 to 12 short of the strip, 24 to 370 on its 466 screen, and Tabs and + stack in the strip 48 from the edge, Tabs on the bar's line and + 55 above", () => {
  const { span, strip } = bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24);
  assert.deepEqual(span, { left: 24, right: 96 });
  assert.equal(466 - span.left - span.right, 346);
  assert.deepEqual(strip, CLOSED_STRIP);
  assert.equal(DUO_PLUS_ABOVE, 55);
  assert.deepEqual(besideStrip(strip!, 466, 250, 16), { right: 80, width: 250 });
  assert.deepEqual(besideStrip(strip!, 466, 400, 16), { right: 80, width: 370 });
});

test("on the open Duo three fixed slots stack in the strip at 903, + 110 and Tabs 55 above the bar's line, and the 400-wide capsule ends at the bottom slot's right edge, 527 to 927 on 951", () => {
  const { span, strip } = bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24);
  assert.deepEqual(span, { left: 527, right: 24 });
  assert.equal(951 - span.left - span.right, 400);
  assert.equal(951 - span.right, 903 + 24);
  assert.deepEqual(strip, OPEN_STRIP);
  assert.deepEqual(bottomBarLayout(600, { left: 0, right: 200 }, "fullyOpen", 24).span, { left: 176, right: 24 });
});

test("a strip on the leading side mirrors it all", () => {
  assert.deepEqual(bottomBarLayout(466, { left: 84, right: 0 }, "closed", 24), { span: { left: 96, right: 24 }, strip: { ...CLOSED_STRIP, side: "left", centerX: 48 } });
  assert.deepEqual(bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24), { span: { left: 24, right: 527 }, strip: { ...OPEN_STRIP, side: "left", centerX: 48 } });
  assert.deepEqual(besideStrip({ ...CLOSED_STRIP, side: "left", centerX: 48 }, 466, 250, 16), { left: 80, width: 250 });
  assert.equal(bottomBarLayout(466, { left: 0, right: 60 }, "closed", 24).strip!.centerX, 466 - 36);
});

test("only the open Duo squeezes, and only the capsule's left edge moves: right into the bottom slot's circle", () => {
  const open = bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24);
  assert.deepEqual(duoSqueeze(951, open), { marginLeft: 352, marginRight: 0 });
  assert.equal(527 + 352, 903 - 24);
  const mirrored = bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24);
  assert.deepEqual(duoSqueeze(951, mirrored), { marginLeft: 0, marginRight: 352 });
});

test("the closed Duo and a phone with no hinge never squeeze", () => {
  assert.equal(duoSqueeze(466, bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24)), null);
  assert.equal(duoSqueeze(466, bottomBarLayout(466, { left: 84, right: 0 }, "closed", 24)), null);
  assert.equal(duoSqueeze(599, bottomBarLayout(599, { left: 0, right: 84 }, "fullyOpen", 24)), null);
  assert.equal(duoSqueeze(402, bottomBarLayout(402, { left: 0, right: 0 }, "none", 24)), null);
  assert.equal(duoSqueeze(1032, bottomBarLayout(1032, { left: 0, right: 0 }, "none", 24)), null);
});

test("on the open Duo the deck's Search Tabs field rests in the bottom slot, opens to 400, and runs from 24 to the slot's right edge while typing", () => {
  const open = bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24);
  assert.deepEqual(duoFieldReach(951, open, 24), { side: "marginLeft", rest: 352, open: 0, typing: -503 });
  assert.equal(527 + 352, 903 - 24);
  assert.equal(527 - 503, 24);
  const mirrored = bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24);
  assert.deepEqual(duoFieldReach(951, mirrored, 24), { side: "marginRight", rest: 352, open: 0, typing: -503 });
  assert.equal(duoFieldReach(466, bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24), 24), null);
  assert.equal(duoFieldReach(402, bottomBarLayout(402, { left: 0, right: 0 }, "none", 24), 24), null);
});

test("the open Duo is an open hinge at 600 wide or more, which is where closing search lands in one move; a closed Duo turned on its side stays closed", () => {
  assert.equal(isOpenDuo(951, "fullyOpen"), true);
  assert.equal(isOpenDuo(600, "partiallyOpen"), true);
  assert.equal(isOpenDuo(466, "closed"), false);
  assert.equal(isOpenDuo(678, "closed"), false);
  assert.equal(isOpenDuo(1032, "none"), false);
});

test("a closed Duo turned on its side with its strip at a side keeps the closed sizing: Tabs on the bar's line, the capsule from 24 to 12 short of the strip", () => {
  const { span, strip } = bottomBarLayout(678, { left: 0, right: 84 }, "closed", 24);
  assert.deepEqual(span, { left: 24, right: 96 });
  assert.deepEqual(strip, { ...CLOSED_STRIP, centerX: 630 });
  assert.equal(duoSqueeze(678, bottomBarLayout(678, { left: 0, right: 84 }, "closed", 24)), null);
});

test("a hinge whose strip-side inset can't hold a 48 circle gets the plain centred bar, so the capsule never runs under a strip button, whatever the inset", () => {
  for (const hinge of ["closed", "partiallyOpen", "fullyOpen"] as const) {
    for (const width of [466, 669, 951]) {
      assert.deepEqual(bottomBarLayout(width, { left: 0, right: 0 }, hinge, 24), { span: { left: 24, right: 24 }, strip: null });
      assert.deepEqual(bottomBarLayout(width, { left: 30, right: 0 }, hinge, 24), { span: { left: 54, right: 54 }, strip: null });
      assert.deepEqual(bottomBarLayout(width, { left: 0, right: 47 }, hinge, 24), { span: { left: 71, right: 71 }, strip: null });
    }
  }
});

test("wherever a strip is kept, its buttons sit inside the inset and a closed capsule ends at least 12 short of them", () => {
  for (const inset of [48, 50, 60, 72, 84, 120]) {
    const { span, strip } = bottomBarLayout(466, { left: 0, right: inset }, "closed", 24);
    const buttonLeft = strip!.centerX - 24;
    assert.ok(466 - buttonLeft <= inset, `inset ${inset}`);
    assert.ok(buttonLeft - (466 - span.right) >= 12, `inset ${inset}`);
  }
});

test("Duo's strip control is the shared 48-point bar control, not a second definition", async () => {
  const { DUO_BAR } = await import("./bottomBarSpan.ts");
  const { FLOATING_BAR_PLACE } = await import("./deckGeometry.ts");
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./bottomBarSpan.ts", import.meta.url), "utf8"));
  assert.equal(DUO_BAR.button, FLOATING_BAR_PLACE.control);
  assert.match(source, /button: FLOATING_BAR_PLACE\.control/);
  assert.equal(DUO_BAR.axis, 48);
});
