import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOATING_BAR_PLACE, floatingBarCenter } from "../../lib/deckGeometry.ts";
import { floatingBarClearance, floatingPillClearance, materialPillClearance, pageBarClearance, shownBarClearance, toastBottom, toastDragDismisses, toastPlace, toastSideInset } from "./placement.ts";

const base = { keyboardLift: null, safeBottom: 24, barClearance: 64, hostBottomY: 2400 / 2.75, barTopY: null, covered: false, gap: 8 };

const MATERIAL_BAR = { inset: 8, height: 64 };
const PILL = 30;
const MATERIAL_PILL = 36;

test("over the deck the toast sits a gap above the bar's measured top, whatever the phone", () => {
  assert.equal(toastBottom({ ...base, hostBottomY: 872, barTopY: 700 }), 180);
  assert.equal(toastBottom({ ...base, hostBottomY: 915, barTopY: 760 }), 163);
});

test("with no deck bar it clears the system area and the page bar, and the keyboard wins when it is up", () => {
  assert.equal(toastBottom(base), 88);
  assert.equal(toastBottom({ ...base, barTopY: 860, hostBottomY: 872 }), 88);
  assert.equal(toastBottom({ ...base, keyboardLift: 300, barTopY: 700, hostBottomY: 872 }), 308);
});

test("with the keyboard up the toast moves to the top of the screen, 4 points under the status bar, as both apps place it", () => {
  assert.deepEqual(toastPlace({ ...base, safeTop: 48, keyboardLift: 300 }), { top: 52 });
  assert.deepEqual(toastPlace({ ...base, safeTop: 48 }), { bottom: 88 });
  assert.deepEqual(toastPlace({ ...base, safeTop: 48, keyboardLift: 300, covered: true }), { top: 52 });
});

test("a toast drags away past 24 points or on a fling projected past 40, and springs back otherwise", () => {
  assert.equal(toastDragDismisses(25, 0), true);
  assert.equal(toastDragDismisses(10, 100), true);
  assert.equal(toastDragDismisses(10, 50), false);
  assert.equal(toastDragDismisses(-30, 0), false);
});

test("over a page the toast clears the floating bar by 64 points, and Android's Material You bar, 8 above the safe area and 64 tall, by its top plus a gap (#3339)", () => {
  assert.equal(pageBarClearance(null, 64, 8), 64);
  assert.equal(pageBarClearance(MATERIAL_BAR, 64, 8), 80);
  assert.equal(toastBottom({ ...base, barClearance: pageBarClearance(MATERIAL_BAR, 64, 8) }), 104);
});

test("over a page with the floating bar the toast's bottom sits one gap above the bar's top, never on it", () => {
  const android = { ...base, safeBottom: 0, barClearance: floatingBarClearance(floatingBarCenter(0, "android"), FLOATING_BAR_PLACE.control, 8, 0) };
  assert.equal(toastBottom(android), 45.5 + 24 + 8);
  const buttons = { ...base, safeBottom: 48, barClearance: floatingBarClearance(floatingBarCenter(48, "android"), FLOATING_BAR_PLACE.control, 8, 48) };
  assert.equal(toastBottom(buttons), 48 + 8 + 24 + 24 + 8);
  const iPhone = { ...base, safeBottom: 34, barClearance: floatingBarClearance(floatingBarCenter(34, "ios"), FLOATING_BAR_PLACE.control, 8, 34) };
  assert.equal(toastBottom(iPhone), 45.5 + 24 + 8);
});

test("with the floating bar collapsed to the host pill the toast drops to one gap above the pill, whose bottom stays where the bar's was", () => {
  const center = floatingBarCenter(0, "android");
  const geometry = { full: floatingBarClearance(center, FLOATING_BAR_PLACE.control, 8, 0), pill: floatingPillClearance(center, FLOATING_BAR_PLACE.control, PILL, 8, 0) };
  const pillTop = center - FLOATING_BAR_PLACE.control / 2 + PILL;
  assert.equal(toastBottom({ ...base, safeBottom: 0, barClearance: shownBarClearance(geometry, "pill") }), pillTop + 8);
  assert.equal(toastBottom({ ...base, safeBottom: 0, barClearance: shownBarClearance(geometry, "full") }), center + 24 + 8);
  assert.ok(shownBarClearance(geometry, "pill")! < shownBarClearance(geometry, "full")!);
  const iPhoneCenter = floatingBarCenter(34, "ios");
  const iPhonePill = floatingPillClearance(iPhoneCenter, FLOATING_BAR_PLACE.control, PILL, 8, 34);
  assert.equal(toastBottom({ ...base, safeBottom: 34, barClearance: iPhonePill }), iPhoneCenter - 24 + PILL + 8);
});

test("with Material You's bar collapsed to its pill the toast sits one gap above the pill, 8 above the safe area and 36 tall", () => {
  const geometry = { full: pageBarClearance(MATERIAL_BAR, 0, 8), pill: materialPillClearance(MATERIAL_BAR, MATERIAL_PILL, 8) };
  assert.equal(toastBottom({ ...base, barClearance: shownBarClearance(geometry, "pill") }), 24 + 8 + 36 + 8);
  assert.equal(toastBottom({ ...base, barClearance: shownBarClearance(geometry, "full") }), 24 + 8 + 64 + 8);
});

test("with the page bar scrolled away the toast sits one gap above the safe area, and a design with no pill keeps the full bar's clearance", () => {
  assert.equal(shownBarClearance({ full: 64, pill: 46 }, "gone"), null);
  assert.equal(toastBottom({ ...base, barClearance: shownBarClearance({ full: 64, pill: 46 }, "gone") }), 24 + 8);
  assert.equal(shownBarClearance({ full: 64, pill: null }, "pill"), 64);
});

test("with a full sheet in front (Settings, Library, Archive, Spaces) the toast sits one gap above the safe area, whatever bar is behind it", () => {
  assert.equal(toastBottom({ ...base, covered: true }), 24 + 8);
  assert.equal(toastBottom({ ...base, covered: true, barTopY: 700, hostBottomY: 872 }), 24 + 8);
  assert.equal(toastBottom({ ...base, covered: true, safeBottom: 0 }), 8);
  assert.equal(toastBottom({ ...base, covered: true, barClearance: pageBarClearance(MATERIAL_BAR, 0, 8) }), 24 + 8);
});

test("the card spans the bar's width: its edges sit at the bar's side inset, past the wider safe side", () => {
  assert.equal(toastSideInset(24, 0), 24);
  assert.equal(toastSideInset(16, 44), 60);
});
