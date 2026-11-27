import assert from "node:assert/strict";
import { test } from "node:test";
const { layout } = await import("../ui/theme.ts");
const { HEADER_TOOLS, headerToggleXIn } = await import("./dockMotion.ts");
const headerToggleX = (windowFullScreen) => headerToggleXIn({ windowFullScreen, pageFullScreen: false, controlsRow: false });
const { NO_TOOLBAR, toolbarButtonPlacements, toolbarGeometry, toolbarLeadingCorner } = await import("./geometry.ts");

test("the Mac keeps every place laid out around the traffic lights where it was", () => {
  assert.equal(layout.trafficLightsWidth, 78);
  assert.equal(HEADER_TOOLS.toggleX, 97.75);
  assert.equal(headerToggleX(false), 97.75);
  assert.equal(headerToggleX(true), 29);
  for (const state of [{ windowFullScreen: false, pageFullScreen: true, controlsRow: false }, { windowFullScreen: false, pageFullScreen: false, controlsRow: true }]) {
    assert.equal(headerToggleXIn(state), 97.75, "the traffic lights keep their toggle whatever the page or the controls row do");
  }
});

test("the Mac toolbar keeps its buttons and leaves no trailing room", () => {
  assert.deepEqual(toolbarGeometry({ sidebarButton: true }), { sidebarButton: 21, back: 56, forward: 92, reload: 127, urlLeft: 145, trailing: 0, cardRadius: 0, leadingAtCardCorner: false });
  assert.deepEqual(toolbarGeometry({ sidebarButton: false }), { sidebarButton: null, back: 21, forward: 57, reload: 92, urlLeft: 110, trailing: 0, cardRadius: 0, leadingAtCardCorner: false });
  assert.deepEqual(NO_TOOLBAR, { sidebarButton: null, back: 21, forward: 21, reload: 21, urlLeft: 8, trailing: 0, cardRadius: 0, leadingAtCardCorner: false });
  assert.equal(toolbarGeometry({ sidebarButton: true, trailing: 129 }).trailing, 129);
  assert.equal(toolbarGeometry({ sidebarButton: true, cardRadius: 10 }).cardRadius, 10);
});

test("the first toolbar button follows the page-frame corner without shrinking below its other corners", () => {
  const row = { button: 30, center: 21.2, buttonRadius: 7 };
  const hideTabs = toolbarGeometry({ sidebarButton: true, cardRadius: 10, leadingAtCardCorner: true });
  const back = toolbarGeometry({ sidebarButton: false, cardRadius: 10, leadingAtCardCorner: true });
  const thinnerFrame = toolbarGeometry({ sidebarButton: true, cardRadius: 7, leadingAtCardCorner: true });
  const frameSeven = toolbarGeometry({ sidebarButton: true, cardRadius: 12, leadingAtCardCorner: true });
  const rounderPage = toolbarGeometry({ sidebarButton: true, cardRadius: 15, leadingAtCardCorner: true });
  const otherPane = toolbarGeometry({ sidebarButton: false, cardRadius: 10 });
  const hideTabsCorner = toolbarLeadingCorner(hideTabs, row);
  const backCorner = toolbarLeadingCorner(back, row);
  assert.equal(hideTabsCorner.button, "sidebar");
  assert.equal(backCorner.button, "back");
  assert.equal(backCorner.radius, hideTabsCorner.radius);
  assert.equal(hideTabsCorner.radius, row.buttonRadius);
  assert.deepEqual(toolbarLeadingCorner(otherPane, row), { button: null });
  assert.equal(toolbarLeadingCorner(toolbarGeometry({ sidebarButton: false, cardRadius: 0, leadingAtCardCorner: true }), row).radius, row.buttonRadius);
  assert.equal(toolbarLeadingCorner(thinnerFrame, row).radius, row.buttonRadius);
  assert.equal(toolbarLeadingCorner(frameSeven, row).radius, row.buttonRadius);
  assert.equal(Math.round(toolbarLeadingCorner(rounderPage, row).radius * 10) / 10, 8.8);
  assert.equal(toolbarButtonPlacements(hideTabs, row).sidebarButton.hit.topLeftRadius, row.buttonRadius);
  assert.equal(toolbarButtonPlacements(back, row).back.hit.topLeftRadius, backCorner.radius);
  assert.equal(toolbarButtonPlacements(rounderPage, row).sidebarButton.hit.topLeftRadius, toolbarLeadingCorner(rounderPage, row).radius);
  assert.equal(toolbarButtonPlacements(otherPane, row).back.hit.topLeftRadius, undefined);
  const compact = toolbarGeometry({ sidebarButton: true, cardRadius: 18, leadingAtCardCorner: true });
  assert.equal(toolbarLeadingCorner(compact, { button: 22, buttonRadius: 4, center: 14 }).radius, 8);
});
