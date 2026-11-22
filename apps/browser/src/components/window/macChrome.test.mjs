import assert from "node:assert/strict";
import { test } from "node:test";
const { layout } = await import("../ui/theme.ts");
const { HEADER_TOOLS, headerToggleXIn } = await import("./dockMotion.ts");
const headerToggleX = (windowFullScreen) => headerToggleXIn({ windowFullScreen, pageFullScreen: false, controlsRow: false });
const { NO_TOOLBAR, toolbarGeometry } = await import("./geometry.ts");

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
  assert.deepEqual(toolbarGeometry({ sidebarButton: true }), { sidebarButton: 21, back: 56, forward: 92, reload: 127, urlLeft: 145, trailing: 0, cardRadius: 0 });
  assert.deepEqual(toolbarGeometry({ sidebarButton: false }), { sidebarButton: null, back: 21, forward: 57, reload: 92, urlLeft: 110, trailing: 0, cardRadius: 0 });
  assert.deepEqual(NO_TOOLBAR, { sidebarButton: null, back: 21, forward: 21, reload: 21, urlLeft: 8, trailing: 0, cardRadius: 0 });
  assert.equal(toolbarGeometry({ sidebarButton: true, trailing: 129 }).trailing, 129);
  assert.equal(toolbarGeometry({ sidebarButton: true, cardRadius: 10 }).cardRadius, 10);
});
