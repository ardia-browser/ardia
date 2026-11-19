import assert from "node:assert/strict";
import { test } from "node:test";
const { MIN_URL_FIELD, TOOLBAR_ROWS, extensionsWidthOf, splitExtensionsLimit, splitFieldWidth } = await import("./toolbarRow.ts");
const { toolbarGeometry } = await import("../components/window/geometry.ts");

const PINNED = 6;

const paneIn = (width, geometry, row) => ({ width, urlLeft: geometry.urlLeft, trailing: geometry.trailing, row });
const limitIn = (width, geometry, row) => splitExtensionsLimit(paneIn(width, geometry, row));

function fieldWidth(width, geometry, row) {
  const strip = extensionsWidthOf(Math.min(PINNED, limitIn(width, geometry, row)), row.extensionButton);
  return splitFieldWidth(paneIn(width, geometry, row), strip);
}

test("a split pane keeps a usable address field beside six pinned extensions", () => {
  for (const sidebarButton of [false, true]) {
    const geometry = toolbarGeometry({ sidebarButton, trailing: 0 });
    for (const width of [420, 440, 640, 900]) {
      assert.ok(fieldWidth(width, geometry, TOOLBAR_ROWS.regular) >= MIN_URL_FIELD, `${width} wide, sidebar button ${sidebarButton}`);
    }
  }
});

test("the compact row packs its smaller extension buttons the same way", () => {
  for (const sidebarButton of [false, true]) {
    const geometry = toolbarGeometry({ sidebarButton, trailing: 0 });
    for (const width of [360, 420, 640]) {
      assert.ok(fieldWidth(width, geometry, TOOLBAR_ROWS.compact) >= MIN_URL_FIELD, `${width} wide, sidebar button ${sidebarButton}`);
    }
  }
});

test("room the window controls take at the right edge comes out of the extensions", () => {
  const clear = toolbarGeometry({ sidebarButton: false, trailing: 0 });
  const crowded = toolbarGeometry({ sidebarButton: false, trailing: 140 });
  const row = TOOLBAR_ROWS.regular;
  assert.ok(limitIn(640, crowded, row) < limitIn(640, clear, row));
  assert.ok(fieldWidth(640, crowded, row) >= MIN_URL_FIELD);
});

test("a narrower pane never shows more extensions than a wider one", () => {
  const geometry = toolbarGeometry({ sidebarButton: true, trailing: 0 });
  let last = 0;
  for (let width = 220; width <= 1400; width += 10) {
    const limit = limitIn(width, geometry, TOOLBAR_ROWS.regular);
    assert.ok(limit >= last, `${width} wide`);
    last = limit;
  }
});

test("a pane too narrow for any extension still keeps the overflow button", () => {
  assert.equal(limitIn(220, toolbarGeometry({ sidebarButton: true, trailing: 0 }), TOOLBAR_ROWS.regular), 1);
});

test("a pane wide enough for every extension pins them all", () => {
  assert.ok(limitIn(1200, toolbarGeometry({ sidebarButton: false, trailing: 0 }), TOOLBAR_ROWS.regular) >= PINNED);
});
