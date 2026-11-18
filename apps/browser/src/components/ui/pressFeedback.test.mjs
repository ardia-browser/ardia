import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
const { buttonMotion, springSpec, hoverFade } = await import("./motion.ts");

function overshoot({ damping }) {
  return damping >= 1 ? 0 : Math.exp((-Math.PI * damping) / Math.sqrt(1 - damping * damping));
}

const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

test("a pressed glyph dips a little and comes back without a bounce", () => {
  assert.deepEqual(Object.keys(buttonMotion).sort(), ["controlPressScale", "iconPressScale"]);
  assert.ok(buttonMotion.iconPressScale >= 0.95 && buttonMotion.iconPressScale < 1);
  assert.ok(buttonMotion.controlPressScale >= 0.98 && buttonMotion.controlPressScale < 1);
  assert.ok(overshoot(springSpec.snappy) < 0.01, "the press spring settles without overshooting");
  assert.match(source("./motion.ts"), /toValue: pressed \? pressedScale : 1, \.\.\.springs\.snappy/);
});

test("sidebar rows, folder headers and tiles hold still under a press", () => {
  for (const file of ["TabPressArea.tsx", "GroupBlock.tsx", "LiveFolderBlock.tsx", "LiveItemRow.tsx", "FolderPanel.tsx", "FolderTile.tsx"])
    assert.doesNotMatch(source(`../sidebar/${file}`), /usePressScaleMotion|PressScale/, file);
});

const USED_ALL_DAY = ["sidebar", "tabstrip", "toolbar", "omnibox", "ntp"];
const USED_ALL_DAY_UI = ["Button.tsx", "ButtonKinds.tsx", "Menu.tsx", "Row.tsx", "ListRow.tsx", "Segmented.tsx", "Field.tsx", "HoverFill.tsx", "HoverSlot.tsx"];
const RARE_LARGER_MOVES = new Set(["sidebar/resizeDrag.ts"]);
const OVERSHOOTS = /\bbouncy\b/;

test("nothing used all day springs past its rest", () => {
  const files = [
    ...USED_ALL_DAY.flatMap((folder) => readdirSync(new URL(`../${folder}/`, import.meta.url), { recursive: true }).map((name) => `${folder}/${name}`)),
    ...USED_ALL_DAY_UI.map((name) => `ui/${name}`),
  ].filter((file) => /\.tsx?$/.test(file) && !RARE_LARGER_MOVES.has(file));
  assert.ok(files.length > 100, `${files.length} files`);
  const bouncing = files.filter((file) => OVERSHOOTS.test(source(`../${file}`)));
  assert.deepEqual(bouncing, [], "springs.bouncy is for rare, larger moves (AGENTS.md, Motion follows how often a thing is used)");
  for (const file of RARE_LARGER_MOVES) assert.match(source(`../${file}`), OVERSHOOTS, `${file} no longer needs its exception`);
});

test("a hover lights at once and fades away", () => {
  assert.ok(hoverFade.show.duration <= 60);
  assert.ok(hoverFade.hide.duration >= 3 * hoverFade.show.duration);
});
