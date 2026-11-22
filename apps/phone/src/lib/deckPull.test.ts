import assert from "node:assert/strict";
import test from "node:test";
import { DECK, deckGeometry, deckLeading, deckPileScale } from "./deckGeometry.ts";
import { DECK_PULL, deckCardAt, pullBarGlyphs, pullBarShift, pullClearsBar, pullLands, pullPagePose, pullRise, pullShrink, pullSpeed, pullTarget, pullTuck, stackPullTarget } from "./deckPull.ts";

const g = deckGeometry(440, 956, 62, 34, 0, "ios", "redesigned", 48, 55);
const target = stackPullTarget(g, "t8", 8, 7, 0);
const near = (actual: number, expected: number, slack = 1e-6) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} is not ${expected}`);

test("the shrink is spread over a third of the screen's height of travel, so a flick lets go while the page is still moving: its bottom edge rises in step with the finger and reaches the card's as the travel runs out", () => {
  near(target.reach, g.height - (g.cardCenterY + g.cardHeight / 2));
  near(target.pull, g.height * DECK_PULL.travelShare);
  assert.ok(target.pull > 300);
  for (const travel of [0, 10, 40, 75, 200, target.pull]) {
    const pose = pullPagePose(target, pullShrink(travel, target.pull));
    near(pose.y + (g.height * pose.scale) / 2, g.height - (travel * target.reach) / target.pull, 1e-6);
  }
  near(pullPagePose(target, pullShrink(target.pull, target.pull)).scale * g.width, g.cardWidth);
});

test("the other cards wait behind the page, smaller than it, and slide out to their own places as the landing reveals them", () => {
  const behind = { x: 220, y: 500 };
  const slot = { x: -40, y: 515 };
  assert.deepEqual(pullTuck(behind, slot, 0), { x: 220, y: 500, scale: DECK_PULL.tuckScale });
  assert.deepEqual(pullTuck(behind, slot, 1), { x: -40, y: 515, scale: 1 });
  assert.deepEqual(pullTuck(behind, slot, -1), pullTuck(behind, slot, 0));
  const half = pullTuck(behind, slot, 0.5);
  near(half.x, 90);
  near(half.scale, (1 + DECK_PULL.tuckScale) / 2);
});

test("the pull is aimed at the card's own frame: the page's width only ever falls, toward the card's and never below it, and its centre only ever moves toward the card's, however far the finger goes", () => {
  let last = pullPagePose(target, 0);
  for (let travel = 1; travel <= 700; travel += 1) {
    const pose = pullPagePose(target, pullShrink(travel, target.reach));
    assert.ok(pose.scale <= last.scale + 1e-12);
    assert.ok(pose.scale * g.width >= g.cardWidth - 1e-9);
    assert.ok(pose.x >= last.x - 1e-12 && pose.x <= target.centerX + 1e-9);
    assert.ok(pose.y <= Math.max(last.y, target.centerY) + 1e-9);
    last = pose;
  }
  near(last.scale * g.width, g.cardWidth);
  near(last.x, target.centerX);
  assert.ok(last.y < target.centerY && last.y > target.centerY - DECK_PULL.overshoot * target.reach - 1e-9);
  const landingOvershoot = pullPagePose(target, 1.06);
  near(landingOvershoot.scale * g.width, g.cardWidth);
});

test("at the end of the pull the page is exactly its card: the card's width, centre and corner", () => {
  const pose = pullPagePose(target, 1);
  near(pose.scale * g.width, g.cardWidth);
  near(pose.x, deckLeading(g, 1) + g.cardWidth / 2);
  near(pose.y, g.cardCenterY);
  assert.equal(pose.corner, DECK.cardRadius);
  const rest = pullPagePose(target, 0);
  assert.deepEqual(rest, { x: g.width / 2, y: g.height / 2, scale: 1, corner: g.screenCorner });
});

test("past the card the pull goes on with resistance, never jumps, and stops short of a limit", () => {
  const at = pullShrink(target.reach, target.reach);
  const just = pullShrink(target.reach + 1, target.reach);
  assert.equal(at, 1);
  assert.ok(just > at && just - at < 1 / target.reach + 1e-9);
  let last = at;
  for (let travel = target.reach; travel < 900; travel += 20) {
    const now = pullShrink(travel, target.reach);
    assert.ok(now >= last);
    last = now;
  }
  assert.ok(last < 1 + DECK_PULL.overshoot);
  assert.equal(pullShrink(-30, target.reach), 0);
  assert.ok(pullPagePose(target, last).corner === DECK.cardRadius);
});

test("the swipe commits on distance or on a real flick, as Safari's does, and a drag back down always returns", () => {
  assert.equal(pullLands(DECK_PULL.landsTravel, 0), true);
  assert.equal(pullLands(DECK_PULL.landsTravel - 1, 0), false);
  assert.equal(pullLands(38, -400), false);
  assert.equal(pullLands(78, -140), false);
  assert.equal(pullLands(128, -210), true);
  assert.equal(pullLands(30, -1200), true);
  assert.equal(pullLands(4, -1200), false);
  assert.equal(pullLands(200, DECK_PULL.back), false);
  assert.equal(pullLands(200, DECK_PULL.back - 1), true);
});

test("the landing starts from the finger's speed, in the pull's own units, and a wild speed is capped", () => {
  near(pullSpeed(-target.reach, target.reach), 1);
  near(pullSpeed(target.reach / 2, target.reach), -0.5);
  assert.equal(pullSpeed(-1e6, target.reach), DECK_PULL.maxSpeed);
  assert.equal(pullSpeed(1e6, target.reach), -DECK_PULL.maxSpeed);
});

test("the browsing bar's glyphs fade with how far the page's bottom edge has risen, and are gone before the swipe can commit", () => {
  assert.equal(pullBarGlyphs(0), 1);
  assert.equal(pullBarGlyphs(DECK_PULL.glyphsFadeFrom), 1);
  assert.equal(pullBarGlyphs(DECK_PULL.glyphsGoneAt), 0);
  assert.equal(pullBarGlyphs(400), 0);
  near(pullBarGlyphs((DECK_PULL.glyphsFadeFrom + DECK_PULL.glyphsGoneAt) / 2), 0.5);
  assert.ok(DECK_PULL.glyphsGoneAt < DECK_PULL.landsTravel);
  near(pullRise(target, 0.5), target.reach / 2);
  assert.equal(pullRise(target, -0.2), 0);
});

test("the deck's bar takes over only once the page's bottom edge is above the bar, and gives it back a little lower so a resting finger can't flip it", () => {
  const barTop = 69.5;
  assert.equal(pullClearsBar(barTop, barTop, false), false);
  assert.equal(pullClearsBar(barTop + DECK_PULL.barClearance, barTop, false), true);
  assert.equal(pullClearsBar(barTop, barTop, true), true);
  assert.equal(pullClearsBar(barTop + DECK_PULL.barClearance - DECK_PULL.barReturnSlack - 1, barTop, true), false);
});

test("the bar's shapes move to the deck bar's place as the page rises and are there when the deck's bar takes over", () => {
  const barTop = 69.5;
  assert.equal(pullBarShift(0, barTop, 0.5), 0);
  near(pullBarShift((barTop + DECK_PULL.barClearance) / 2, barTop, 14.5), 7.25);
  assert.equal(pullBarShift(barTop + DECK_PULL.barClearance, barTop, 14.5), 14.5);
  assert.equal(pullBarShift(300, barTop, 14.5), 14.5);
});

test("a grid tile high on the screen is a target too, and a tile at the very bottom still leaves room to pull", () => {
  const tile = pullTarget("t1", 440, 956, { centerX: 114, centerY: 420, width: 197, height: 428 }, 13, 55);
  near(tile.reach, 956 - (420 + 214));
  const pose = pullPagePose(tile, 1);
  near(pose.scale * 440, 197);
  near(pose.x, 114);
  near(pose.y, 420);
  const low = pullTarget("t2", 440, 956, { centerX: 114, centerY: 760, width: 197, height: 428 }, 13, 55);
  assert.equal(low.reach, DECK_PULL.minReach);
});

test("a tap on the deck while it lands finds the card at the tap's place where the cards come to rest, the right-hand card winning where two overlap, and nothing above or below the cards", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `t${index}`);
  const hit = { ids, scroll: 7, g };
  const front = deckLeading(g, 0);
  assert.equal(deckCardAt(hit, front + g.cardWidth / 2, g.cardCenterY), "t7");
  assert.equal(deckCardAt(hit, deckLeading(g, -1) + 2, g.cardCenterY), "t6");
  assert.equal(deckCardAt(hit, deckLeading(g, 1) + 2, g.cardCenterY), "t8");
  assert.equal(deckCardAt(hit, front + g.cardWidth / 2, g.cardCenterY - g.cardHeight), null);
  assert.equal(deckCardAt(hit, front + g.cardWidth / 2, g.cardCenterY + g.cardHeight), null);
  assert.equal(deckCardAt({ ids: [], scroll: 0, g }, front + 10, g.cardCenterY), null);
  const arc = deckGeometry(440, 956, 62, 34, 0, "ios", "redesigned", 48, 55, "arc");
  const scale = deckPileScale(arc, -1);
  assert.ok(scale < 1);
  const edge = deckLeading(arc, -1) + (arc.cardWidth * (1 - scale)) / 2;
  const arcHit = { ids, scroll: 7, g: arc };
  assert.equal(deckCardAt(arcHit, edge + 2, arc.cardCenterY), "t6");
  assert.notEqual(deckCardAt(arcHit, edge - 2, arc.cardCenterY), "t6");
});
