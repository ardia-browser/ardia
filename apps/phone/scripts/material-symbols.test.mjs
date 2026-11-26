import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../assets/material-symbols.json", import.meta.url), "utf8"));
const mapped = Object.entries(manifest.javascript);

const SHARED_ON_PURPOSE = {
  eyeglasses: ["eyeglasses", "eyeglassesThin"],
  computer: ["macMini", "macStudio"],
};

test("every symbol Android draws has pinned Material artwork", () => {
  const missing = mapped.filter(([, icon]) => !manifest.icons[icon]?.paths.length);
  assert.deepEqual(missing, []);
});

test("no pinned Material artwork is left unused", () => {
  const used = new Set(mapped.map(([, icon]) => icon));
  assert.deepEqual(Object.keys(manifest.icons).filter((icon) => !used.has(icon)), []);
});

test("two symbols share Material artwork only when they mean the same thing", () => {
  const byIcon = new Map();
  for (const [symbol, icon] of mapped) byIcon.set(icon, [...(byIcon.get(icon) ?? []), symbol]);
  const shared = Object.fromEntries([...byIcon].filter(([, symbols]) => symbols.length > 1).map(([icon, symbols]) => [icon, symbols.sort()]));
  assert.deepEqual(shared, SHARED_ON_PURPOSE);
});

test("the Material You row, Default Browser and Collapse Bottom Bar keep their own meanings", () => {
  assert.equal(manifest.javascript.paintbrushFill, "brush_fill1");
  assert.equal(manifest.javascript.safariFill, "open_in_browser");
  assert.equal(manifest.javascript.platterBottomArrowDown, "bottom_panel_close");
  assert.equal(manifest.javascript.handDrawFill, "swipe");
});
