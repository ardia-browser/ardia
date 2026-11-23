import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../test-native/index.ts");
const { placement } = await import("./VaultMenu.tsx");
const { VAULT_MENU } = await import("./tokens.ts");
const { POPOVER_MARGIN } = await import("../ui/index.ts");

const area = { width: 1200, height: 800 };
const field = (x, width) => ({ rect: { x, y: 100, width, height: 30 } });

test("the fill menu follows the field's width between its minimum and a Safari-like maximum, from the field's leading edge", () => {
  assert.equal(VAULT_MENU.maxWidth, 340);
  assert.equal(VAULT_MENU.minWidth, 280);
  const wide = placement(field(150, 900), 1, area, 200);
  assert.equal(wide.width, VAULT_MENU.maxWidth, "a 900 pt field gets a 340 pt menu");
  assert.equal(wide.left, 150);
  const narrow = placement(field(150, 120), 1, area, 200);
  assert.equal(narrow.width, VAULT_MENU.minWidth, "a 120 pt field still gets the minimum width");
  assert.equal(narrow.left, 150);
  const tiny = placement(field(150, 60), 1, area, 200);
  assert.equal(tiny.width, 280, "a 60 pt code or zip field gets the 280 pt minimum");
  assert.equal(tiny.left, 150);
  const fitting = placement(field(150, 320), 1, area, 200);
  assert.equal(fitting.width, 320);
});

test("near the window's right edge the menu slides left to stay inside, and a zoomed page's field is measured zoomed", () => {
  const edge = placement(field(1100, 90), 1, area, 200);
  assert.equal(edge.left + edge.width, area.width - POPOVER_MARGIN);
  const zoomed = placement(field(100, 200), 1.5, area, 200);
  assert.equal(zoomed.width, 300);
  assert.equal(zoomed.left, 150);
  const tiny = placement(field(10, 900), 1, { width: 280, height: 800 }, 200);
  assert.equal(tiny.width, 280 - 2 * POPOVER_MARGIN, "a window narrower than the minimum gets a menu that fits it");
});
