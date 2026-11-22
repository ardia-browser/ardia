import assert from "node:assert/strict";
import test from "node:test";
import { commandBarKeyboardTop, commandBarPlacement, commandBarRise, DUO, duoCardBottom, duoCardTop, sidebarFrame, splitCardFrame, splitPanelFrame, toolbarFrame, toolbarLayout, wideCardFrame } from "./duoLayout.ts";

const PORTRAIT = { width: 669, height: 951, insets: { top: 59, bottom: 34, left: 0, right: 0 } };
const LANDSCAPE = { width: 951, height: 669, insets: { top: 0, bottom: 21, left: 59, right: 59 } };

test("main's DuoLayout constants hold, and the page's clearance is the toolbar plus 9 above and below", () => {
  assert.equal(DUO.toolbarClearance, 63);
  assert.equal(DUO.sidebarWidth, 260);
  assert.equal(DUO.cardRadius, 16);
  assert.equal(DUO.commandMaxHeight, 484);
  assert.ok(Object.isFrozen(DUO));
});

test("the card sits 33 down or 4 under the status bar, and its bottom margin is 9 or the home indicator less 20", () => {
  assert.equal(duoCardTop(0), 33);
  assert.equal(duoCardTop(59), 63);
  assert.equal(duoCardBottom(0), 9);
  assert.equal(duoCardBottom(21), 9);
  assert.equal(duoCardBottom(34), 14);
});

test("an open Duo upright gets a 647 by 874 card at 11, 63, the toolbar at 72, and a 260 by 926 sidebar at 11, 11", () => {
  const { width, height, insets } = PORTRAIT;
  const card = wideCardFrame(width, height, insets);
  assert.deepEqual(card, { x: 11, y: 63, width: 647, height: 874 });
  assert.deepEqual(toolbarFrame(card), { x: 11, y: 72, width: 647, height: 45 });
  assert.deepEqual(sidebarFrame(width, height, insets), { x: 11, y: 11, width: 260, height: 926 });
});

test("an open Duo on its side pads the card by the side insets: 811 by 627 at 70, 33, and the sidebar 260 by 649 at 70, 11", () => {
  const { width, height, insets } = LANDSCAPE;
  const card = wideCardFrame(width, height, insets);
  assert.deepEqual(card, { x: 70, y: 33, width: 811, height: 627 });
  assert.deepEqual(toolbarFrame(card), { x: 70, y: 42, width: 811, height: 45 });
  assert.deepEqual(sidebarFrame(width, height, insets), { x: 70, y: 11, width: 260, height: 649 });
});

test("the toolbar centres the address between reload and share, and leaves it the room between the 7-point spacers", () => {
  const bar = toolbarLayout(647);
  assert.equal(bar.leadingEnd, 157);
  assert.equal(bar.trailingStart, 542);
  assert.equal(bar.addressCenterX, 349.5);
  assert.equal(bar.addressMaxWidth, 343);
});

test("the command bar starts 127 under the card top, 35 in from the safe sides, and stops 24 over the keyboard or at 484", () => {
  const upright = commandBarPlacement(PORTRAIT.width, PORTRAIT.insets, commandBarKeyboardTop(PORTRAIT.height, 336));
  assert.deepEqual(upright, { top: 190, left: 35, width: 599, maxHeight: 401 });
  const tall = commandBarPlacement(PORTRAIT.width, PORTRAIT.insets, commandBarKeyboardTop(PORTRAIT.height, 34));
  assert.equal(tall.maxHeight, 484);
  const side = commandBarPlacement(LANDSCAPE.width, LANDSCAPE.insets, commandBarKeyboardTop(LANDSCAPE.height, 21));
  assert.deepEqual(side, { top: 160, left: 94, width: 763, maxHeight: 464 });
  assert.equal(commandBarPlacement(LANDSCAPE.width, LANDSCAPE.insets, 100).maxHeight, 0);
});

test("the command bar fades in from 0.96 scale, and under Reduce Motion only fades", () => {
  assert.deepEqual(commandBarRise(0, false), { opacity: 0, scale: 0.96 });
  assert.deepEqual(commandBarRise(1, false), { opacity: 1, scale: 1 });
  assert.deepEqual(commandBarRise(0, true), { opacity: 0, scale: 1 });
});

test("half open, the card runs edge to edge less 11 and stops 11 over the fold, at least 120 high; the panel fills below the fold", () => {
  const fold = { top: 465.5, bottom: 485.5 };
  assert.deepEqual(splitCardFrame(669, PORTRAIT.insets, fold), { x: 11, y: 63, width: 647, height: 391.5 });
  assert.equal(splitCardFrame(669, PORTRAIT.insets, { top: 100, bottom: 120 }).height, 120);
  assert.deepEqual(splitPanelFrame(669, 951, PORTRAIT.insets, fold), { x: 0, y: 485.5, width: 669, height: 465.5, paddingBottom: 34 });
});
