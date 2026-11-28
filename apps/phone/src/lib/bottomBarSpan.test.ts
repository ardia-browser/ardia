import assert from "node:assert/strict";
import test from "node:test";
import { barSwipeSpan, besideStrip, bottomBarLayout, deckHeaderSides, deckSpacesMenu, deckSpacesSlot, deckStripOf, deckStripSlots, DUO_PLUS_ABOVE, duoFieldReach, duoSqueeze, isOpenDuo } from "./bottomBarSpan.ts";
import { pagerCommitDistance, snapTarget } from "./pagerPhysics.ts";

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

test("a sideways swipe on the bar commits at half the drag span the bar offers: half the screen on an iPhone and the closed Duo, as before, and half the 400-wide capsule on the open Duo, so a swipe that stays on the capsule can switch tabs", () => {
  const commitOn = (width: number, insets: { left: number; right: number }, hinge: "none" | "closed" | "fullyOpen") => pagerCommitDistance(barSwipeSpan(width, bottomBarLayout(width, insets, hinge, 24)));
  assert.equal(commitOn(402, { left: 0, right: 0 }, "none"), 201);
  assert.equal(commitOn(852, { left: 59, right: 59 }, "none"), 426);
  assert.equal(commitOn(466, { left: 0, right: 84 }, "closed"), 233);
  assert.equal(commitOn(951, { left: 0, right: 84 }, "fullyOpen"), 200);
  assert.equal(commitOn(951, { left: 84, right: 0 }, "fullyOpen"), 200);
  assert.equal(commitOn(951, { left: 0, right: 0 }, "fullyOpen"), 475.5, "a pose with no strip keeps the plain bar and its threshold");
  assert.ok(commitOn(951, { left: 0, right: 84 }, "fullyOpen") < 400, "reachable within the capsule");
  const open = commitOn(951, { left: 0, right: 84 }, "fullyOpen");
  assert.equal(snapTarget(230, 0, 951, true, true, open), 1, "a slow 230 point pan to the right commits");
  assert.equal(snapTarget(-230, 0, 951, true, true, open), -1);
  assert.equal(snapTarget(370, 200, 951, true, true, open), 1);
  assert.equal(snapTarget(150, 0, 951, true, true, open), 0, "a short drag still springs back");
  assert.equal(snapTarget(230, -400, 951, true, true, open), 0, "a drag let go moving back does not switch");
  assert.equal(snapTarget(230, 0, 951, true, true), 0, "the old half-screen threshold refused it");
  assert.equal(snapTarget(230, 0, 402, true, true), 1);
  assert.equal(snapTarget(190, 0, 402, true, true), 0);
});

test("the deck's cards keep clear of the Duo's strip on whichever side it is, and a plain iPhone has none", () => {
  assert.deepEqual(deckStripOf(bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24), { left: 0, right: 84 }), { side: "right", inset: 84 });
  assert.deepEqual(deckStripOf(bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24), { left: 84, right: 0 }), { side: "left", inset: 84 });
  assert.equal(deckStripOf(bottomBarLayout(852, { left: 59, right: 59 }, "none", 24), { left: 59, right: 59 }), null);
  assert.equal(deckStripOf(bottomBarLayout(466, { left: 0, right: 20 }, "closed", 24), { left: 0, right: 20 }), null);
});

test("the deck header pads by the wider side inset plus 24 on both sides, as it is drawn only where there is no strip", () => {
  assert.deepEqual(deckHeaderSides({ left: 0, right: 0 }, 24), { left: 24, right: 24 });
  assert.deepEqual(deckHeaderSides({ left: 59, right: 59 }, 24), { left: 83, right: 83 });
  assert.deepEqual(deckHeaderSides({ left: 62, right: 0 }, 24), { left: 86, right: 86 });
});

test("the deck stacks ···, Incognito and + in the strip: on the closed Duo + on the bar's line, Incognito 55 and ··· 110 above it; on the open Duo ··· 165, + 110 and Incognito 55 above the magnifier's slot on the line", () => {
  const closed = bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24);
  assert.deepEqual(deckStripSlots(closed.strip!), { more: -110, plus: 0, incognito: -55 });
  assert.deepEqual([closed.span.left, 466 - closed.span.right], [24, 370]);
  const open = bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24);
  assert.deepEqual(deckStripSlots(open.strip!), { more: -165, plus: -110, incognito: -55 });
  assert.deepEqual(deckStripSlots(bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24).strip!), { more: -165, plus: -110, incognito: -55 });
});

test("on the open Duo the top slot, ··· at 165 above the line, clears the Wi-Fi ring and the clock: on the 669-high pose with its bar line at 624 it spans 435 to 483, the ring ending about 150", async () => {
  const { deckGeometry } = await import("./deckGeometry.ts");
  const barLine = deckGeometry(951, 669, 0, 34, 84, "ios", "redesigned", 0, 55, "arc", { side: "right", inset: 84 }).barCenterY;
  const slots = deckStripSlots(bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24).strip!);
  assert.equal(barLine, 624);
  assert.deepEqual([barLine + slots.more - 24, barLine + slots.more + 24], [435, 483]);
  assert.ok(barLine + slots.more - 24 > 150);
});

test("on the closed Duo the space switcher leads the bar row from 24 and Search Tabs flexes after it to 370, 12 short of the strip; the switcher takes at most half the row", () => {
  const closed = bottomBarLayout(466, { left: 0, right: 84 }, "closed", 24);
  assert.deepEqual(deckSpacesSlot(466, closed, 24, 8), { inRow: true, anchor: "start", at: 24, from: 24, to: 370, maxWidth: 169 });
  assert.deepEqual(deckSpacesMenu(deckSpacesSlot(466, closed, 24, 8)!, 120, 250), { left: 24, width: 250 }, "its menu rises above it, left-aligned with it");
  const mirrored = bottomBarLayout(466, { left: 84, right: 0 }, "closed", 24);
  assert.deepEqual(deckSpacesSlot(466, mirrored, 24, 8), { inRow: true, anchor: "end", at: 442, from: 96, to: 442, maxWidth: 169 });
  assert.deepEqual(deckSpacesMenu(deckSpacesSlot(466, mirrored, 24, 8)!, 120, 250), { left: 192, width: 250 });
});

test("on the open Duo the space switcher sits on the bar line ending 8 before the magnifier's slot circle, at 871 where the circle starts at 879, and its menu never reaches past it into the strip", () => {
  const open = bottomBarLayout(951, { left: 0, right: 84 }, "fullyOpen", 24);
  const slot = deckSpacesSlot(951, open, 24, 8)!;
  assert.deepEqual(slot, { inRow: false, anchor: "end", at: 871, from: 24, to: 871, maxWidth: 200 });
  assert.equal(open.strip!.centerX - 24 - 8, 871);
  assert.deepEqual(deckSpacesMenu(slot, 110, 250), { left: 621, width: 250 });
  assert.deepEqual(deckSpacesMenu(slot, 300, 250), { left: 571, width: 250 }, "a capsule wider than the menu keeps it left-aligned");
  const mirrored = deckSpacesSlot(951, bottomBarLayout(951, { left: 84, right: 0 }, "fullyOpen", 24), 24, 8)!;
  assert.deepEqual(mirrored, { inRow: false, anchor: "start", at: 80, from: 80, to: 927, maxWidth: 200 });
  assert.deepEqual(deckSpacesMenu(mirrored, 110, 250), { left: 80, width: 250 });
});

test("with no strip there is no bottom-row switcher, so Search Tabs keeps the whole row", () => {
  assert.equal(deckSpacesSlot(402, bottomBarLayout(402, { left: 0, right: 0 }, "none", 24), 24, 8), null);
  assert.equal(deckSpacesSlot(466, bottomBarLayout(466, { left: 0, right: 20 }, "closed", 24), 24, 8), null);
});
