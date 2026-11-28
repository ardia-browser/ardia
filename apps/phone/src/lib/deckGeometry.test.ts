import assert from "node:assert/strict";
import test from "node:test";
import {
  DECK_ARC,
  DECK_DUO_ARC,
  DECK_ARC_HEADER,
  DECK_REDESIGN,
  deckArcHeaderPlacement,
  deckArcTitleReveal,
  deckPileScale,
  deckHeaderReveal,
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
  deckCurtain,
  deckCurtainOpacity,
  DECK_STRIP_CURTAIN,
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

test("the redesigned bars keep iPhone's place over a home indicator, and on Android sit above a gesture bar or a 3-button bar, where the browsing bar does", () => {
  assert.equal(redesignedBarCenterFromBottom(34, "ios"), 45);
  assert.equal(redesignedBarCenterFromBottom(48, "ios"), 59, "iPhone never lifts for a navigation bar");
  assert.equal(redesignedBarCenterFromBottom(24, "android"), 52);
  assert.equal(redesignedBarCenterFromBottom(16, "android"), 45.5);
  for (const inset of [1, 16, 20, 24, 32]) assert.ok(redesignedBarCenterFromBottom(inset, "android") - 24 >= inset + 4, `a 48 point bar ends 4 points above a ${inset} point gesture bar, so its handle never sits on it`);
  for (const inset of [33, 48, 63]) assert.ok(redesignedBarCenterFromBottom(inset, "android") - 24 >= inset + 8, `a 48 point bar ends 8 points above a ${inset} point 3-button bar`);
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
  assert.ok(Math.abs(header.cardWidth - 402 * DECK_REDESIGN.cardWidthRatio) < 1e-9, "the redesign's cards are smaller than main's, so three or four read at once");
  assert.ok(header.cardWidth < original.cardWidth);
  const archive = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 100);
  assert.equal(archive.cardCenterY - header.cardCenterY, 26);
  const homeButton = deckGeometry(375, 667, 20, 0, 0, "ios", "redesigned", 48);
  assert.equal(homeButton.barCenterY, 667 - 20 - 11);
  assert.deepEqual(deckGeometry(412, 915, 48, 24, 0, "android", "original", 48), pixel7);
});

test("in the redesign the focused card sits centred, the cards on either side pile up 8 points in from the screen's edges instead of being sliced by them, and each card's strip ends at the screen", () => {
  const g = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48);
  assert.ok(Math.abs(deckLeading(g, 0) + g.cardWidth / 2 - 201) < 1e-9);
  assert.equal(deckLeading(g, 1), g.focusLeading + g.spacing);
  for (let relative = -12; relative <= 12; relative += 0.25) {
    const leading = deckLeading(g, relative);
    assert.ok(leading >= DECK_REDESIGN.pileEdge - 1e-9 && leading <= 402 - DECK_REDESIGN.pileEdge + 1e-9, `card at ${relative} starts on screen`);
    assert.ok(deckLeading(g, relative + 0.25) > leading, "cards keep their order");
    assert.ok(leading + deckVisibleWidth(g, relative, relative === 12) <= 402 + 1e-9, `card at ${relative} shows no more than the screen holds`);
  }
  const slope = (relative: number) => (deckLeading(g, relative + 1e-4) - deckLeading(g, relative - 1e-4)) / 2e-4;
  assert.ok(Math.abs(slope(1) - g.spacing) < 0.01 && Math.abs(slope(0) - g.spacing) < 0.01, "a pan moves the cards without a jolt where the piles begin");
  assert.ok(deckVisibleWidth(g, 0, false) > 120 && deckVisibleWidth(g, 1, false) > 88, "the focused card and the one after it have room for a title");
});

test("a redesigned card's header shows its icon and title together, only once a title fits", () => {
  assert.equal(deckHeaderReveal(56), 0);
  assert.equal(deckHeaderReveal(70), 0.5);
  assert.equal(deckHeaderReveal(84), 1);
});

test("the deck chrome is fully opaque the moment its motion settles, even when a spring stops a hair short of 1, since UIKit draws no glass under a view that is even slightly transparent", () => {
  assert.equal(deckChromeOpacity(1), 1);
  assert.equal(deckChromeOpacity(0.9995), 1);
  assert.equal(deckChromeOpacity(1.02), 1);
  assert.equal(deckChromeOpacity(DECK_CHROME_FROM), 0);
  assert.equal(deckChromeOpacity(0), 0);
  assert.ok(Math.abs(deckChromeOpacity(0.8) - 0.5) < 1e-9);
});

test("the redesigned deck stacks as Arc Search's switcher: cards two thirds of the screen tall, the focused one's strip a little over half the width, its left neighbour peeking 0.17 of the width and the one behind a sliver at the edge", () => {
  const g = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  assert.equal(g.stack, "arc");
  assert.ok(Math.abs(g.cardWidth - 402 * DECK_ARC.cardWidthRatio) < 1e-9);
  assert.ok(Math.abs(g.cardHeight / 874 - 0.655) < 0.002, `card ${g.cardHeight.toFixed(1)} tall on an 874 screen`);
  assert.ok(Math.abs(g.spacing / 402 - 0.553) < 0.002, "the focused card shows about 55% of the width before the next card covers it");
  assert.ok(Math.abs(deckLeading(g, 0) / 402 - 0.206) < 0.01, "the focused card starts a fifth of the way in");
  assert.ok(Math.abs((deckLeading(g, 0) - deckLeading(g, -1)) / 402 - 0.173) < 0.002, "the card behind peeks out 0.17 of the width");
  const behind = deckLeading(g, -2) + (g.cardWidth * (1 - deckPileScale(g, -2))) / 2;
  assert.ok(behind > -4 && behind < deckLeading(g, -1), `the second card back starts at ${behind.toFixed(1)}, a sliver at the screen's edge`);
  assert.ok(deckLeading(g, -3) + g.cardWidth * deckPileScale(g, -3) < deckLeading(g, -1) + g.cardWidth, "the third card back is hidden");
  assert.ok(deckLeading(g, 1) + g.cardWidth > 402 + 100, "the next card runs off the right edge");
  assert.ok(deckLeading(g, 2) > 402, "the one after is off screen");
  assert.equal(g.cardCorner, DECK_ARC.cardCorner);
  assert.ok(Math.abs(g.cardCenterY - 874 * DECK_ARC.centerRatio) < 1e-9, "the cards centre a little under the screen's middle");
  assert.ok(g.cardCenterY - g.cardHeight / 2 >= 62 + 48 + 21 + 20 - 1e-9, "a card's title row clears the header");
  assert.ok(g.cardCenterY + g.cardHeight / 2 < g.barCenterY - 24 - 40, "the cards end well above the bar");
});

test("Arc's stack moves without a jolt: cards keep their order, the focused card slides at the spacing on both sides of rest, and the cards behind shrink a little, then more", () => {
  const g = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  for (let relative = -8; relative <= 4; relative += 0.25) assert.ok(deckLeading(g, relative + 0.25) > deckLeading(g, relative), `order at ${relative}`);
  const before = (deckLeading(g, 0) - deckLeading(g, -1e-5)) / 1e-5;
  const after = (deckLeading(g, 1e-5) - deckLeading(g, 0)) / 1e-5;
  assert.ok(Math.abs(before - g.spacing) < 0.01 && Math.abs(after - g.spacing) < 0.01, `${before} then ${after} points per card`);
  assert.equal(deckPileScale(g, 0), 1);
  assert.equal(deckPileScale(g, 1), 1);
  assert.ok(Math.abs(deckPileScale(g, -1) - 0.98) < 1e-9);
  assert.ok(Math.abs(deckPileScale(g, -2) - 0.91) < 1e-9);
  assert.equal(deckPileScale(g, -40), DECK_ARC.leastScale);
  assert.equal(deckPileScale(deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48), -2), 1, "the pile never shrinks");
  assert.ok(deckVisibleWidth(g, 1, true) <= 402 - deckLeading(g, 1) + 1e-9, "the next card's strip ends at the screen");
});

test("a tap and each card's accessibility frame land on the right card in Arc's stack", () => {
  const g = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  const y = g.cardCenterY;
  for (const scroll of [0, 1, 2, 3, 6]) {
    for (let index = 0; index < 8; index++) {
      const relative = index - scroll;
      const width = deckVisibleWidth(g, relative, index === 7);
      const leading = deckLeading(g, relative);
      if (width < 1 || leading < 0 || leading > 402) continue;
      assert.equal(deckCardAt(g, 8, scroll, leading + width / 2, y), index, `card ${index} at scroll ${scroll}`);
    }
  }
});

test("with 40 tabs on the redesigned pile a tap at the right edge lands on a mounted card, never one squeezed past the mount window", () => {
  const g = deckGeometry(360, 740, 24, 48, 0, "android", "redesigned", 48);
  assert.equal(g.stack, "pile");
  assert.ok(g.rightReach > 0);
  const reach = 9;
  const card = deckCardAt(g, 40, 0, 359, g.cardCenterY, 0, reach);
  assert.ok(card >= 0 && card <= reach, `card ${card}`);
});

test("in Arc's stack a card shrunk behind the focused one answers only inside its drawn bounds", () => {
  const g = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  const scroll = 2;
  const scale = deckPileScale(g, 0 - scroll);
  assert.ok(scale < 1);
  const centerX = deckLeading(g, -scroll) + g.cardWidth / 2;
  const halfWidth = (g.cardWidth * scale) / 2;
  const halfHeight = (g.cardHeight * scale) / 2;
  const left = centerX - halfWidth;
  const x = left + 2;
  assert.equal(deckCardAt(g, 3, scroll, x, g.cardCenterY), 0, "inside the drawn card");
  assert.equal(deckCardAt(g, 3, scroll, x, g.cardCenterY - halfHeight - 1), -1, "just above the drawn top edge");
  assert.equal(deckCardAt(g, 3, scroll, x, g.cardCenterY + halfHeight + 1), -1, "just below the drawn bottom edge");
  assert.equal(deckCardAt(g, 3, scroll, left - 1, g.cardCenterY), -1, "just left of the drawn edge");
});

test("Arc's card titles sit 16 in from the card's left edge, the favicon alone on a peeking card and the title once 36 points of it fit", () => {
  assert.deepEqual(deckArcHeaderPlacement(80, 220), { available: 220 - DECK_ARC_HEADER.inset - DECK_ARC_HEADER.trailing, left: 96 });
  assert.deepEqual(deckArcHeaderPlacement(10, 12), { available: 0, left: 26 });
  const g = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  const peeking = deckArcHeaderPlacement(deckLeading(g, -1), deckVisibleWidth(g, -1, false));
  assert.equal(deckHeaderIconReveal(peeking.available, 16), 1);
  assert.equal(deckArcTitleReveal(peeking.available, 16, 6), 0);
  const focused = deckArcHeaderPlacement(deckLeading(g, 0), deckVisibleWidth(g, 0, false));
  assert.equal(deckArcTitleReveal(focused.available, 16, 6), 1);
  const next = deckArcHeaderPlacement(deckLeading(g, 1), deckVisibleWidth(g, 1, true));
  assert.equal(deckArcTitleReveal(next.available, 16, 6), 1);
  assert.equal(deckArcTitleReveal(16 + 6 + 42, 16, 6), 0.5);
});

test("Arc's stack fits a home-button iPhone and an iPhone on its side", () => {
  const se = deckGeometry(375, 667, 20, 0, 0, "ios", "redesigned", 48, 0, "arc");
  assert.ok(se.cardCenterY - se.cardHeight / 2 >= 20 + 48 + 21 + 20 - 1e-9);
  assert.ok(se.cardCenterY + se.cardHeight / 2 <= se.barCenterY - 24);
  const side = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", 48, 55, "arc");
  assert.ok(side.cardCenterY - side.cardHeight / 2 >= 48 + 21 + 20 - 1e-9);
  assert.ok(side.cardCenterY + side.cardHeight / 2 <= side.barCenterY - 24 + 1e-9);
  assert.ok(deckLeading(side, -1) >= 59 - 1e-9, "the card behind clears the side inset");
});

const DUO_CLOSED = () => deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 0, 55, "arc", { side: "right", inset: 84 });
const DUO_OPEN = () => deckGeometry(951, 669, 0, 34, 84, "ios", "redesigned", 0, 55, "arc", { side: "right", inset: 84 });
const frame = (g: ReturnType<typeof deckGeometry>) => ({ width: g.cardWidth, height: g.cardHeight, top: g.cardCenterY - g.cardHeight / 2, bottom: g.cardCenterY + g.cardHeight / 2, left: deckLeading(g, 0), right: deckLeading(g, 0) + g.cardWidth, rowGap: g.barCenterY - 24 - (g.cardCenterY + g.cardHeight / 2) });
const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 0.1, `${label}: ${actual} is not ${expected}`);

test("on a Duo the arc stack fills the band between 110 below the safe top and 40 above the bottom row, centred there, in the screen left of the sensor strip, its cards keeping the screen's aspect", () => {
  assert.deepEqual(DECK_DUO_ARC, { bandTop: 110, barClearance: 40, cardWidthRatio: 0.785, pileEdge: 12, pileTail: 0.5 });
  const closed = frame(DUO_CLOSED());
  near(closed.width, 299.87, "closed width");
  near(closed.height, 436.28, "closed height");
  near(closed.height / closed.width, 678 / 466, "closed aspect");
  near(closed.top, 121.36, "closed top");
  near(closed.bottom, 557.64, "closed bottom");
  near(closed.left, 41.07, "closed left");
  near(closed.right, 340.93, "closed right");
  near(closed.rowGap, 51.36, "closed gap to the bottom row at 609");
  near(382 - closed.right, closed.left, "the closed card is centred in the 382 beside the strip");
  const open = frame(DUO_OPEN());
  near(open.width, 639.69, "open width");
  near(open.height, 450, "open height");
  near(open.height / open.width, 669 / 951, "open aspect");
  near(open.top, 110, "open top");
  near(open.bottom, 560, "open bottom");
  near(open.left, 113.66, "open left");
  near(open.right, 753.34, "open right");
  near(open.rowGap, 40, "open gap to the bottom row at 600");
  near(867 - open.right, open.left, "the open card is centred in the 867 beside the strip");
  assert.ok(closed.top - 28 > 0 && open.top - 28 > 0, "the title row above the card stays on screen");
});

test("on a Duo the pile behind keeps to the room left of the focused card, its edges stepping in from 15: 15, 11 and 7 closed", () => {
  const g = DUO_CLOSED();
  const edge = (relative: number) => deckLeading(g, relative) + (g.cardWidth * (1 - deckPileScale(g, relative))) / 2;
  near(edge(-1), 15, "the card behind");
  near(edge(-2), 11, "the next one");
  assert.ok(edge(-3) < edge(-2) && edge(-3) > 0);
  assert.ok(Math.abs(g.spacing - g.cardWidth * DECK_ARC.step) < 1e-9, "the spacing keeps its share of the card");
});

test("on a Duo the cards beyond the focused one run on under the strip, their title rows stop at it, and a tap on the strip lands on no card", () => {
  const closed = DUO_CLOSED();
  assert.equal(closed.cardsRight, 382);
  assert.equal(closed.cardsLeft, 0);
  assert.ok(deckLeading(closed, 1) + closed.cardWidth > 382, "the next card runs on under the strip");
  assert.ok(Math.abs(deckLeading(closed, 1) + deckVisibleWidth(closed, 1, true) - 382) < 1e-9, "but its title row stops at the strip");
  assert.equal(deckCardAt(closed, 3, 1, 420, closed.cardCenterY), -1, "a tap on the strip lands on no card");
  assert.equal(deckCardAt(closed, 3, 1, 190, closed.cardCenterY), 1, "a tap on the focused card finds it");
  assert.equal(deckCardAt(closed, 3, 1, 190, closed.cardCenterY - closed.cardHeight / 2 - 2), -1, "just above it finds nothing");
  const open = DUO_OPEN();
  assert.equal(open.cardsRight, 867);
  assert.equal(deckCardAt(open, 3, 1, 400, 112), 1);
});

test("the Duo band ignores the header height, as the Duo draws no header, and a pose with no strip keeps the plain stack", () => {
  assert.deepEqual(deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "right", inset: 84 }), DUO_CLOSED());
  const plain = deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", null);
  assert.ok(Math.abs(plain.cardWidth - 466 * DECK_ARC.cardWidthRatio) < 1e-9);
});

test("a strip on the leading side mirrors it: the stack starts at the strip, and the screen's other side keeps no extra margin", () => {
  const g = deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "left", inset: 84 });
  const right = deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "right", inset: 84 });
  assert.equal(g.cardsLeft, 84);
  assert.equal(g.cardsRight, 466);
  assert.ok(Math.abs(deckLeading(g, 0) - 84 - deckLeading(right, 0)) < 1e-9);
  assert.ok(deckLeading(g, -1) >= 84, "the card behind clears the strip");
});

test("with no strip the stack keeps the whole screen, so a plain iPhone upright and on its side lays out as before", () => {
  const upright = deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  const side = deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", 48, 55, "arc");
  assert.deepEqual([upright.cardsLeft, upright.cardsRight, side.cardsLeft, side.cardsRight], [0, 402, 0, 852]);
  assert.ok(Math.abs(deckLeading(side, 0) - Math.max((852 - side.spacing) / 2 - side.cardWidth * DECK_ARC.focusNudge, 59 + side.cardWidth * DECK_ARC.peek)) < 1e-9);
  assert.ok(Math.abs(side.cardWidth - Math.min(852 * DECK_ARC.cardWidthRatio, (393 - 21 - 11 + 11 - 67 + 24 - (48 + 21 + 20)) / (393 / 852))) < 1e-9);
  assert.deepEqual(deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc", null), upright);
});

test("on a Duo a curtain of the deck's backdrop covers the strip from 32 points before it to the screen edge, fading in across those 32, and mirrors for a strip on the left", () => {
  assert.equal(DECK_STRIP_CURTAIN.ramp, 32);
  const closed = deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "right", inset: 84 });
  assert.deepEqual(deckCurtain(closed), { left: 350, width: 116, fade: "leading", ramp: 32 });
  const open = deckGeometry(951, 669, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "right", inset: 84 });
  assert.deepEqual(deckCurtain(open), { left: 835, width: 116, fade: "leading", ramp: 32 });
  const left = deckGeometry(466, 678, 0, 34, 84, "ios", "redesigned", 48, 55, "arc", { side: "left", inset: 84 });
  assert.deepEqual(deckCurtain(left), { left: 0, width: 116, fade: "trailing", ramp: 32 });
  assert.ok(deckLeading(closed, 0) + closed.cardWidth <= 350, "the focused card ends before the curtain starts");
});

test("the curtain follows the card growing to the page or shrinking from it on the card's own scale progress: whole at rest, gone at full size, with nothing in between that jumps", () => {
  assert.equal(deckCurtainOpacity(-1, 0), 1, "no card expanded: the curtain is whole, whatever the progress");
  assert.equal(deckCurtainOpacity(-1, 0.3), 1);
  assert.equal(deckCurtainOpacity(2, 1), 1, "a card at its deck size");
  assert.equal(deckCurtainOpacity(2, 0), 0, "a card at the page's size");
  assert.equal(deckCurtainOpacity(2, 0.25), 0.25);
  assert.equal(deckCurtainOpacity(2, 1.04), 1, "a spring's overshoot never brightens it");
  assert.equal(deckCurtainOpacity(2, -0.02), 0);
  let last = 0;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const now = deckCurtainOpacity(0, p);
    assert.ok(now >= last - 1e-12 && now - last <= 0.0101, `steady at ${p.toFixed(2)}`);
    last = now;
  }
});

test("with no strip there is no curtain, so a plain iPhone keeps its deck", () => {
  for (const g of [deckGeometry(402, 874, 62, 34, 0, "ios", "redesigned", 48, 55, "arc"), deckGeometry(852, 393, 0, 21, 59, "ios", "redesigned", 48, 55, "arc"), deckGeometry(412, 915, 48, 24)]) {
    assert.equal(deckCurtain(g), null);
    assert.deepEqual([g.cardsLeft, g.cardsRight], [0, g.width]);
  }
});
