import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { DEFAULT_LOOK } = await import("../../lib/themeLook.ts");
const { setActiveLook } = await import("../../lib/activeLook.ts");
const { SIDEBAR_FIELD_CONTROL, sidebarFieldToolbarRow } = await import("./geometry.ts");

test("sidebar URL controls use concentric button metrics and keep both edge insets", () => {
  const look = { ...DEFAULT_LOOK, radii: { ...DEFAULT_LOOK.radii, chrome: 14 } };
  setActiveLook(look);
  try {
    assert.equal(SIDEBAR_FIELD_CONTROL.box, 24);
    assert.equal(SIDEBAR_FIELD_CONTROL.inset, 5);
    assert.equal(SIDEBAR_FIELD_CONTROL.radius, 9);
    const row = sidebarFieldToolbarRow();
    assert.equal(row.fieldButton, 24);
    assert.equal(row.fieldButtonRadius, 9);
    assert.equal(row.extensionButton, 24);
    assert.equal(row.fieldTrailingInset, 0);
    assert.equal(sidebarFieldToolbarRow(), row);
    const toolbar = readFileSync(new URL("../toolbar/Toolbar.tsx", import.meta.url), "utf8");
    assert.match(toolbar, /value=\{sidebarFieldToolbarRow\(\)\}/);
    assert.match(toolbar, /paddingRight: SIDEBAR_FIELD_CONTROL\.inset/);
    assert.match(toolbar, /paddingRight: row\.fieldTrailingInset \?\? space\.xs/);
    const field = readFileSync(new URL("./SidebarField.tsx", import.meta.url), "utf8");
    assert.match(field, /box=\{SIDEBAR_FIELD_CONTROL\.box\}/);
    assert.match(field, /radius=\{SIDEBAR_FIELD_CONTROL\.radius\}/);
  } finally {
    setActiveLook(DEFAULT_LOOK);
  }
});
