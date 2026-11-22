import assert from "node:assert/strict";
import test from "node:test";
import { ANDROID_MENU_SIZES, IPHONE_MENU_SIZES, menuAt, menuHeight, menuOnTrigger, menuShrink, tallestMenuPage } from "./menuPlace.ts";

const { row: MENU_ROW, heading: MENU_HEADING, divider: MENU_DIVIDER, padding: MENU_PADDING } = IPHONE_MENU_SIZES;

const host = { x: 0, y: 0, width: 392, height: 873 };

test("a tap menu's corner sits on its trigger's matching corner and covers it: top-right on the ··· near the right edge, top-left on a button near the left", () => {
  const more = { x: 336, y: 66, width: 44, height: 44 };
  assert.deepEqual(menuOnTrigger(more, host, host, 250, 272, 8), { left: 130, top: 66, height: 272, origin: "right top" });
  const left = { x: 16, y: 66, width: 120, height: 44 };
  assert.deepEqual(menuOnTrigger(left, host, host, 250, 272, 8), { left: 16, top: 66, height: 272, origin: "left top" });
});

test("with no room below, a tap menu opens upward with its bottom on the trigger's bottom", () => {
  const picker = { x: 270, y: 700, width: 100, height: 26 };
  assert.deepEqual(menuOnTrigger(picker, host, host, 250, 314, 8), { left: 120, top: 412, height: 314, origin: "right bottom" });
});

test("a menu too tall for either way keeps clear of the edges, and the host's origin is taken off", () => {
  const row = { x: 16, y: 400, width: 360, height: 52 };
  assert.equal(menuOnTrigger(row, host, host, 250, 900, 8).top, 8);
  assert.equal(menuOnTrigger({ x: 16, y: 300, width: 100, height: 40 }, { ...host, y: 24 }, { ...host, y: 24 }, 250, 200, 8).top, 276);
});

test("a menu's height counts its rows, headings and dividers", () => {
  assert.equal(menuHeight([{ heading: "Archive" }, { label: "a" }, { label: "b" }, "divider", { label: "c" }]), MENU_PADDING + MENU_HEADING + MENU_ROW * 3 + MENU_DIVIDER);
});

test("on Android a group break is an 8 dp gap between 48 dp rows, so the menu's height counts the gap instead of iPhone's 9-point divider band", () => {
  assert.equal(ANDROID_MENU_SIZES.divider, 8);
  const items = [{ heading: "Archive" }, { label: "a" }, "divider", { label: "b" }, { label: "Send", children: [{ label: "1" }, "divider", { label: "2" }] }] as const;
  assert.equal(menuHeight(items, ANDROID_MENU_SIZES), 16 + 36 + 48 * 3 + 8);
  assert.equal(tallestMenuPage(items, ANDROID_MENU_SIZES), 16 + 36 + 48 * 3 + 8);
  assert.equal(tallestMenuPage([{ label: "Send", children: [{ label: "1" }, "divider", { label: "2" }, { label: "3" }, { label: "4" }] }] as const, ANDROID_MENU_SIZES), 48 + 16 + 48 * 4 + 8);
});

const room = { x: 0, y: 40, width: 392, height: 793 };

test("a long-press menu opens at the finger, down and to the right when it fits", () => {
  assert.deepEqual(menuAt({ x: 60, y: 300 }, host, room, 250, 200, 8), { left: 60, top: 300, height: 200, origin: "left top" });
});

test("near the right or bottom edge it opens back toward the screen from the finger", () => {
  assert.deepEqual(menuAt({ x: 340, y: 760 }, host, room, 250, 200, 8), { left: 90, top: 544, height: 200, origin: "right bottom" });
});

test("a menu wider or taller than the room left keeps clear of the bars and the screen's edges", () => {
  const spot = menuAt({ x: 5, y: 50 }, host, room, 250, 790, 8);
  assert.equal(spot.left, 8);
  assert.equal(spot.top, 48);
});

test("a tap menu never runs under the system bars", () => {
  const button = { x: 346, y: 760, width: 44, height: 44 };
  assert.deepEqual(menuOnTrigger(button, host, room, 250, 200, 8), { left: 140, top: 604, height: 200, origin: "right bottom" });
  assert.equal(menuOnTrigger({ ...button, y: 44 }, host, room, 250, 200, 8).top, 44);
  assert.equal(menuOnTrigger({ ...button, y: 100 }, host, room, 250, 900, 8).top, 48);
});

test("the tallest page of a menu counts a submenu's back row and its children", () => {
  const items = [{ label: "a" }, { label: "Send to Device", children: [{ label: "1" }, { label: "2" }, { label: "3" }] }];
  assert.equal(tallestMenuPage(items), MENU_ROW + MENU_PADDING + MENU_ROW * 3);
});

test("a menu taller than the safe room is cut to it, top and bottom inside the room, so its rows scroll instead of running off the screen", () => {
  const landscape = { x: 0, y: 0, width: 873, height: 392 };
  const safe = { x: 0, y: 24, width: 873, height: 344 };
  const tall = MENU_PADDING + MENU_ROW * 9 + MENU_DIVIDER;
  const held = menuAt({ x: 400, y: 300 }, landscape, safe, 250, tall, 8);
  assert.ok(held.top >= 24 + 8);
  assert.ok(held.top + held.height <= 368 - 8);
  assert.equal(held.height, 344 - 16);
  const tapped = menuOnTrigger({ x: 16, y: 300, width: 44, height: 44 }, landscape, safe, 250, tall, 8);
  assert.ok(tapped.top >= 24 + 8);
  assert.ok(tapped.top + tapped.height <= 368 - 8);
  const short = menuAt({ x: 400, y: 100 }, landscape, safe, 250, 200, 8);
  assert.equal(short.height, 200);
});

test("a tap menu's corner sits exactly on its trigger's corner even when the trigger sits inside the screen margin, as the deck's ··· does under the status bar", () => {
  const safe = { x: 0, y: 31, width: 392, height: 818 };
  const more = { x: 336, y: 33.6, width: 44, height: 44 };
  const spot = menuOnTrigger(more, host, safe, 250, 272, 8);
  assert.equal(spot.top, 33.6);
  assert.equal(spot.left + 250, 380);
});

test("a picker's menu lines its trailing edge up with the row's value when the trigger asks for it, opening above when there is no room below", () => {
  const row = { x: 16, y: 700, width: 360, height: 52 };
  const spot = menuOnTrigger(row, host, host, 250, 314, 8, undefined, { trailing: true, inset: 16 });
  assert.equal(spot.left + 250, 360);
  assert.equal(spot.top + spot.height, 752);
  assert.equal(spot.origin, "right bottom");
});

test("with no room below the finger, a long-press menu ends 16 pt above it instead of covering it", () => {
  const spot = menuAt({ x: 60, y: 800 }, host, host, 250, 200, 8);
  assert.equal(spot.top + spot.height, 800 - 16);
});

test("with no room below, a long-press menu ends 16 pt above the pressed control when that is higher than the finger, so it never covers the tabs button or its bar", () => {
  const tabsButton = { x: 16, y: 770, width: 48, height: 48 };
  const spot = menuAt({ x: 40, y: 794 }, host, host, 250, 300, 8, undefined, { control: tabsButton });
  assert.equal(spot.top + spot.height, 770 - 16);
  const card = { x: 20, y: 200, width: 280, height: 560 };
  const onCard = menuAt({ x: 40, y: 700 }, host, host, 250, 300, 8, undefined, { control: card });
  assert.equal(onCard.top + onCard.height, 700 - 16);
});

test("a long-press menu stays off a bar below it: opening down, it ends above the bar's top, or turns upward when it can't", () => {
  const bar = 800;
  const down = menuAt({ x: 40, y: 400 }, host, host, 250, 300, 8, undefined, { floor: bar });
  assert.ok(down.top + down.height <= bar - 8);
  assert.equal(down.top, 400);
  const mid = menuAt({ x: 40, y: 560 }, host, host, 250, 300, 8, undefined, { floor: bar });
  assert.equal(mid.top + mid.height, 560 - 16);
});

test("a closing tap menu shrinks to its trigger's size, never past it", () => {
  assert.deepEqual(menuShrink({ x: 336, y: 66, width: 44, height: 44 }, 250, 272), { x: 44 / 250, y: 44 / 272 });
  assert.deepEqual(menuShrink({ x: 16, y: 700, width: 360, height: 52 }, 250, 40), { x: 1, y: 1 });
});
