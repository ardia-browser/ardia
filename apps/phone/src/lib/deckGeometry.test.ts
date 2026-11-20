import assert from "node:assert/strict";
import test from "node:test";
import {
  deckMorphFrom,
  DECK_CHROME_FROM,
  deckChromeOpacity,
  deckSlot,
  mergeDeckOrder,
  deckSlotsNow,
  archiveCardEdgeY,
  deckScrollActionTarget,
  deckBarBand,
  deckStatusStrip,
  deckBarCenterFromBottom,
  pageBarGhostOpacity,
  redesignedBarCenterFromBottom,
  floatingBarCenter,
  deckCardAt,
  deckHeaderLeading,
  deckHeaderPlacement,
  deckHeaderIconReveal,
  deckDragKind,
  deckIsTap,
  deckGeometry,
  deckLeading,
  deckLift,
  deckScrollDuringDrag,
  deckSettleTarget,
  deckSettleVelocity,
  deckShouldClose,
  deckVisibleWidth,
  focusedIndex,
  initialDeckScroll,
  openingDeckScroll,
  scrollAfterClosing,
  scrollAfterRemoving,
  titleReveal,
} from "./deckGeometry.ts";

const pixel7 = deckGeometry(412, 915, 48, 24);

test("the deck geometry matches Compose's TabsDeckGeometry for a Pixel 7", () => {
  assert.equal(pixel7.focusLeading, 412 * (66 / 440));
  assert.equal(pixel7.spacing, Math.min(pixel7.cardWidth, 412 * (218 / 440)));
  assert.equal(deckLeading(pixel7, 0), pixel7.focusLeading);
  assert.equal(deckLeading(pixel7, 2), pixel7.focusLeading + 2 * pixel7.spacing);
  assert.ok(deckLeading(pixel7, -1) > 0 && deckLeading(pixel7, -1) < pixel7.focusLeading);
  assert.ok(deckLeading(pixel7, -10) > -1, "cards to the left pile up at the edge instead of leaving the screen");
  assert.equal(deckVisibleWidth(pixel7, 0, true), pixel7.cardWidth);
  assert.equal(deckVisibleWidth(pixel7, 0, false), pixel7.spacing);
});

test("a drag that starts upward on a card lifts it; anything else scrolls the deck", () => {
  assert.equal(deckDragKind(1, 3, -20), "lift");
  assert.equal(deckDragKind(1, -30, -20), "scroll");
  assert.equal(deckDragKind(1, 2, 20), "scroll");
  assert.equal(deckDragKind(-1, 0, -40), "scroll");
  assert.equal(deckLift(-80), -80);
  assert.equal(deckLift(50), 6);
});

test("a lifted card closes on a flick or past a third of its height, and not when pulled down", () => {
  const h = pixel7.cardHeight;
  assert.equal(deckShouldClose(-40, -900, h), true);
  assert.equal(deckShouldClose(-h / 3 - 1, 0, h), true);
  assert.equal(deckShouldClose(-h / 3 - 1, 400, h), false);
  assert.equal(deckShouldClose(-h / 4, -100, h), false);
  assert.equal(deckShouldClose(30, -900, h), false);
});

test("a horizontal drag scrolls a card per spacing, rubber-bands past the ends and settles to the projected card", () => {
  assert.equal(deckScrollDuringDrag(pixel7, 1, -pixel7.spacing, 4), 2);
  assert.ok(deckScrollDuringDrag(pixel7, 0, pixel7.spacing * 2, 4) > -1);
  assert.ok(deckScrollDuringDrag(pixel7, 3, -pixel7.spacing * 3, 4) < 4);
  assert.equal(deckSettleTarget(pixel7, 1.2, 0, 4), 1);
  assert.equal(deckSettleTarget(pixel7, 1.2, -2000, 4), 3);
  assert.equal(deckSettleTarget(pixel7, 1.2, 2000, 4), 0);
  assert.equal(deckSettleTarget(pixel7, 9, 0, 4), 3);
  assert.equal(deckSettleVelocity(pixel7, 2, 2, -500), 0);
  assert.ok(deckSettleVelocity(pixel7, 1.5, 2, -500) > 0);
});

test("a tap lands on the topmost card under it", () => {
  const y = pixel7.cardCenterY;
  assert.equal(deckCardAt(pixel7, 3, 1, deckLeading(pixel7, 0) + 10, y), 1);
  assert.equal(deckCardAt(pixel7, 3, 1, deckLeading(pixel7, 1) + 10, y), 2);
  assert.equal(deckCardAt(pixel7, 3, 1, 200, 2), -1);
});

test("the deck opens where Compose's DeckOrder does, and keeps focus sensible after a close", () => {
  assert.equal(initialDeckScroll(5), 3);
  assert.equal(initialDeckScroll(1), 0);
  assert.equal(openingDeckScroll(4, 5), 3);
  assert.equal(openingDeckScroll(2, 5), 2);
  assert.equal(openingDeckScroll(4, 5, true), 4);
  assert.equal(openingDeckScroll(2, 5, true), 2);
  assert.equal(openingDeckScroll(0, 1, true), 0);
  assert.equal(scrollAfterRemoving(0, 2, 3), 1);
  assert.equal(scrollAfterRemoving(3, 3, 3), 2);
  assert.equal(focusedIndex(-0.4, 3), 0);
});

test("a header's title fades in between 52 and 84 points of visible card", () => {
  assert.equal(titleReveal(40), 0);
  assert.equal(titleReveal(68), 0.5);
  assert.equal(titleReveal(200), 1);
});

test("a header spans the visible card less 8 points, centred on it but never closer than 16 to the screen's edge, as both native apps place it", () => {
  assert.deepEqual(deckHeaderPlacement(40, 100), { available: 92, left: 44 });
  assert.deepEqual(deckHeaderPlacement(-90, 100), { available: 92, left: 16 - 46 });
  assert.deepEqual(deckHeaderPlacement(40, 4), { available: 0, left: 42 });
});

test("a header's icon fades in over the 12 points after it fits, and its content stays centred as the title reveals", () => {
  assert.equal(deckHeaderIconReveal(10, 16), 0);
  assert.equal(deckHeaderIconReveal(22, 16), 0.5);
  assert.equal(deckHeaderIconReveal(40, 16), 1);
  assert.equal(deckHeaderLeading(100, 16, 6, 60, 0), 42);
  assert.equal(deckHeaderLeading(100, 16, 6, 60, 0.5), 25.5);
  assert.equal(deckHeaderLeading(100, 16, 6, 300, 1), 0);
});

test("Android's page bar fades over the growing or shrinking card while the deck's own buttons fade the other way, so no frame has neither", () => {
  assert.equal(pageBarGhostOpacity(0), 1);
  assert.equal(pageBarGhostOpacity(1), 0);
  let least = 1;
  for (let p = 0; p <= 1.0001; p += 0.01) least = Math.min(least, Math.max(pageBarGhostOpacity(p), deckChromeOpacity(p)));
  assert.ok(least >= 0.25, `at worst ${least.toFixed(2)} of a bar shows`);
});

test("the redesigned bars keep iPhone's place over a home indicator, and on Android sit where the browsing bar does over a gesture bar or a 3-button bar", () => {
  assert.equal(redesignedBarCenterFromBottom(34, "ios"), 45);
  assert.equal(redesignedBarCenterFromBottom(48, "ios"), 59, "iPhone never lifts for a navigation bar");
  assert.equal(redesignedBarCenterFromBottom(24, "android"), 45.5);
  assert.equal(redesignedBarCenterFromBottom(16, "android"), 45.5, "a gesture handle never sits on the deck's bar");
  assert.equal(redesignedBarCenterFromBottom(0, "android"), 45.5);
  assert.equal(redesignedBarCenterFromBottom(48, "android"), 80);
  for (const inset of [0, 16, 24, 32, 33, 48, 63]) assert.equal(redesignedBarCenterFromBottom(inset, "android"), floatingBarCenter(inset, "android"), `the deck's bar and the browsing bar share one place at a ${inset} inset`);
  assert.ok(redesignedBarCenterFromBottom(47.27, "android") - 24 >= 47.27, "a 48 point bar ends above the navigation bar");
  const iPhone = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48);
  const lifted = deckGeometry(393, 873, 29, 48, 0, "android", "redesigned", 48);
  assert.equal(iPhone.barCenterY, 874 - 45);
  assert.equal(lifted.barCenterY, 873 - 80);
  assert.ok(lifted.cardCenterY + lifted.cardHeight / 2 < lifted.barCenterY - 24, "the cards stay above the lifted bar");
});

test("the deck's buttons keep Compose's place over a gesture bar and clear a 3-button bar", () => {
  assert.equal(deckBarCenterFromBottom(24), 30);
  assert.equal(deckBarCenterFromBottom(0), 26);
  assert.equal(deckBarCenterFromBottom(48), 76);
  assert.equal(deckBarCenterFromBottom(34, "ios"), 40, "an iPhone's home indicator is not a navigation bar: SwiftUI centres the bar at max(safeBottom, 20) + 6");
  assert.equal(deckBarCenterFromBottom(34, "android"), 62);
  assert.ok(deckBarCenterFromBottom(48) - 22 >= 48, "a 44 point control ends above the navigation bar");
  const buttons = deckGeometry(392, 872, 40, 48);
  assert.equal(buttons.barCenterY, 872 - 76);
  assert.ok(buttons.cardCenterY + buttons.cardHeight / 2 < buttons.barCenterY - 22, "cards end above the bar");
  const gesture = deckGeometry(392, 872, 40, 24);
  assert.equal(gesture.barCenterY, 872 - 30);
});

test("closing the cards at the right end leaves the deck at rest, the last card at the right edge", () => {
  assert.equal(scrollAfterClosing(scrollAfterRemoving(3, 3, 3), 3, true), 1);
  assert.equal(scrollAfterClosing(1, 2, true), 0);
  assert.equal(scrollAfterClosing(2, 4, false), 2);
  assert.equal(scrollAfterClosing(0, 1, true), 0);
});

test("a touch that moves less than the slop is a tap on the card under it", () => {
  assert.equal(deckIsTap(3, -4), true);
  assert.equal(deckIsTap(8, 7), false);
});

test("each card's accessibility frame is the strip of it that shows, so activating it at its centre opens that card", () => {
  const phone = deckGeometry(402, 874, 62, 34);
  const y = phone.cardCenterY;
  for (const scroll of [0, 1, 1.4, 2, 3]) {
    for (let index = 0; index < 4; index++) {
      const relative = index - scroll;
      const width = deckVisibleWidth(phone, relative, index === 3);
      if (width < 1) continue;
      const centre = deckLeading(phone, relative) + width / 2;
      assert.equal(deckCardAt(phone, 4, scroll, centre, y), index, `card ${index} at scroll ${scroll}`);
    }
  }
  const covered = deckLeading(phone, 0 - 1) + phone.cardWidth / 2;
  assert.notEqual(deckCardAt(phone, 4, 1, covered, y), 0, "the whole card's centre lands on the card over it");
});

test("the Archive card's bottom edge hangs at a fixed gap above the deck bar, measured from the top as the bar is, so a navigation bar the window leaves out can't push it onto the buttons", () => {
  const g = deckGeometry(393, 873, 40, 24);
  const edge = archiveCardEdgeY(g, 28);
  assert.equal(edge, g.barCenterY - 28);
  assert.ok(edge < g.barCenterY - 40 / 2);
});

test("a screen reader's scroll action moves the deck one card, and the end it can't move past offers nothing", () => {
  assert.equal(deckScrollActionTarget(3, 8, "forward"), 4);
  assert.equal(deckScrollActionTarget(3, 8, "backward"), 2);
  assert.equal(deckScrollActionTarget(7, 8, "forward"), null);
  assert.equal(deckScrollActionTarget(0, 8, "backward"), null);
  assert.equal(deckScrollActionTarget(0, 1, "forward"), null);
  assert.equal(deckScrollActionTarget(0, 0, "backward"), null);
});

test("an expanding card grows a status-bar strip above its picture, so at full size the picture sits where the live page does, and a card in the deck has none", () => {
  const g = deckGeometry(393, 873, 40, 24);
  const scale = g.width / g.cardWidth;
  assert.ok(Math.abs(deckStatusStrip(g, 0) * scale - 40) < 1e-9);
  assert.equal(deckStatusStrip(g, 1), 0);
  assert.ok(Math.abs(deckStatusStrip(g, 0.5) * scale - 20) < 1e-9);
});

test("an opening card's picture starts where the page view sat when it was captured, and its bar band grows to the bar's height", () => {
  const g = deckGeometry(393, 873, 40, 24);
  const scale = g.width / g.cardWidth;
  assert.ok(Math.abs(deckStatusStrip(g, 0, 52) * scale - 52) < 1e-9);
  const band = deckBarBand(g, 80, 0);
  assert.ok(Math.abs(band.height * scale - 80) < 1e-9);
  assert.equal(band.grown, 1);
  assert.equal(deckBarBand(g, 80, 1).grown, 0);
});

test("a card's slot starts where it was drawn and ends at its new index, and a second close in the middle of the slide starts from where the first had got to", () => {
  const first = deckSlotsNow(["a", "b", "c", "d"], {}, 0, 1);
  assert.deepEqual(first, { a: 0, b: 1, c: 2, d: 3 });
  assert.equal(deckSlot("c", 1, first, 0, 0), 2);
  assert.equal(deckSlot("c", 1, first, 0, 1), 1);
  const midway = deckSlotsNow(["a", "c", "d"], first, 0, 0.5);
  assert.deepEqual(midway, { a: 0, c: 1.5, d: 2.5 });
  assert.equal(deckSlot("d", 1, midway, 0, 0), 2.5);
  assert.equal(deckSlot("d", 1, midway, 0, 1), 1);
  assert.equal(deckSlot("e", 2, midway, 0, 0), 2);
  assert.equal(deckSlot("a", 0, first, -1, 0), -1);
});

test("a tab that arrives while the deck is open takes its place in the live order, before the tab that follows it, so a tab from the Mac lands beside the selected one instead of past it", () => {
  assert.deepEqual(mergeDeckOrder(["a", "b", "c", "sel"], ["a", "b", "c", "mac", "sel"]), ["a", "b", "c", "mac", "sel"]);
  assert.deepEqual(mergeDeckOrder(["a", "b", "c"], ["a", "b", "c", "new"]), ["a", "b", "c", "new"]);
  assert.deepEqual(mergeDeckOrder(["c", "a", "b"], ["a", "b", "c"]), ["c", "a", "b"]);
  assert.deepEqual(mergeDeckOrder(["a", "b", "c"], ["a", "c"]), ["a", "c"]);
  assert.deepEqual(mergeDeckOrder(["a", "sel"], ["x", "a", "y", "z", "sel"]), ["x", "a", "y", "z", "sel"]);
});

test("in the redesign the cards sit under main's header, about 24 points lower, and the bar centres 11 points above max(safe bottom, 20), as main's TabsDeckGeometry", () => {
  const original = deckGeometry(402, 874, 62, 34, 0, "ios");
  const header = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48);
  assert.equal(header.barCenterY, 874 - 34 - 11);
  assert.equal(header.cardCenterY, (62 + 48 + 21 + 20 + (874 - 34 - 67 + 24)) / 2);
  assert.equal(header.cardCenterY - original.cardCenterY, 24);
  assert.equal(header.cardWidth, original.cardWidth);
  const archive = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 100);
  assert.equal(archive.cardCenterY - header.cardCenterY, 26);
  const homeButton = deckGeometry(375, 667, 20, 0, 0, "ios", "redesigned", 48);
  assert.equal(homeButton.barCenterY, 667 - 20 - 11);
  assert.deepEqual(deckGeometry(412, 915, 48, 24, 0, "android", "original", 48), pixel7);
});

test("the deck chrome is fully opaque the moment its motion settles, even when a spring stops a hair short of 1, since UIKit draws no glass under a view that is even slightly transparent", () => {
  assert.equal(deckChromeOpacity(1), 1);
  assert.equal(deckChromeOpacity(0.9995), 1);
  assert.equal(deckChromeOpacity(1.02), 1);
  assert.equal(deckChromeOpacity(DECK_CHROME_FROM), 0);
  assert.equal(deckChromeOpacity(0), 0);
  assert.ok(Math.abs(deckChromeOpacity(0.8) - 0.5) < 1e-9);
});

test("the archive capsule's geometry swap starts from where the focused card was: the cards' layer moves its centre back and scales it to its old width, then springs to rest", () => {
  const was = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", 48);
  const now = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", 96);
  const morph = deckMorphFrom(was, now);
  assert.equal(morph.originX, now.focusLeading + now.cardWidth / 2);
  assert.equal(morph.originY, now.cardCenterY);
  const centre = { x: morph.originX + morph.dx, y: morph.originY + morph.dy };
  assert.ok(Math.abs(centre.x - (was.focusLeading + was.cardWidth / 2)) < 1e-9);
  assert.ok(Math.abs(centre.y - was.cardCenterY) < 1e-9);
  assert.ok(Math.abs(now.cardWidth * morph.scale - was.cardWidth) < 1e-9);
});
