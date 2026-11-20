import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
const { buttonMotion, springSpec, hoverFade, springs, liftSpring, bounceDip, bouncePressMotion, pressReleaseDelay } = await import("./motion.ts");
const { pressMotionNow, setPressMotion } = await import("../../lib/pressMotion.ts");
const { SETTING_SPECS } = await import("../../state/settings/settings.ts");
const { reduceMotionKnown } = await import("./reduceMotion.ts");

await reduceMotionKnown;

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

test("tab rows and tiles answer a press with their pressed fill and never squish", () => {
  for (const file of ["TabPressArea.tsx", "TabRow.tsx"]) assert.doesNotMatch(source(`../sidebar/${file}`), /usePressScaleMotion\(resettable|useSquish|Squish\b/, file);
});

test("folder headers and folder tiles hold still under a press unless pressMotion is bounce", () => {
  for (const file of ["GroupBlock.tsx", "LiveFolderBlock.tsx", "LiveItemRow.tsx", "FolderPanel.tsx", "FolderTile.tsx"]) {
    const text = source(`../sidebar/${file}`);
    assert.doesNotMatch(text, /usePressScaleMotion|PressScale/, file);
    assert.match(text, /useSquish\(/, `${file} reaches a scale only through useSquish, which stays still unless pressMotion is bounce`);
  }
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

test("hover cards, toasts and reload only fade or change state, with no grow, slide or click squish", () => {
  const hoverCard = source("../sidebar/hoverMotion.ts");
  assert.doesNotMatch(hoverCard, /\bscale\b|Animated\.spring|translate[XY]/, "a hover card fades in and out in place");
  assert.match(hoverCard, /duration: HOVER_CARD_FADE_MS, easing: fade/);
  for (const file of ["../sidebar/HoverCard.tsx", "../tabstrip/StripHoverCard.tsx"]) assert.doesNotMatch(source(file), /useHoverCardPlacement|\bscale\b/, file);
  const toast = source("./Toast.tsx");
  assert.doesNotMatch(toast, /Animated\.spring|\bscale\b|translate[XY]|springs\./, "a toast fades in and out in place");
  assert.match(toast, /style=\{\{ opacity: appear \}\}/);
  const reload = source("../toolbar/NavButtons.tsx");
  const reloadGlyph = reload.slice(reload.indexOf("const ReloadGlyph ="), reload.indexOf("export const ReloadButton"));
  const reloadButton = reload.slice(reload.indexOf("export const ReloadButton"), reload.indexOf("export const HistoryButton"));
  assert.ok(reloadGlyph.length > 0 && reloadButton.length > 0);
  assert.doesNotMatch(reloadGlyph, /\bpress\b/, "the reload glyph has no click scale input");
  assert.doesNotMatch(reloadButton, /Animated\.|pressScale|press=/, "a click on reload doesn't squish the glyph");
  assert.doesNotMatch(source("../toolbar/tokens.ts"), /pressScale/);
});

test("the nightly.6 press bounce is opt-in through config.json's pressMotion, and still by default", () => {
  assert.equal(SETTING_SPECS.pressMotion.default, "still");
  assert.equal(SETTING_SPECS.pressMotion.synced, false);
  assert.equal(pressMotionNow(), "still");
  assert.equal(liftSpring(), springs.snappy);
  setPressMotion("bounce");
  try {
    assert.equal(liftSpring(), springs.bouncy);
  } finally {
    setPressMotion("still");
  }
  assert.equal(liftSpring(), springs.snappy);
});

test("pressMotion bounce restores nightly.6's dips, springs and shortest visible press", () => {
  assert.equal(bounceDip(buttonMotion.iconPressScale), 0.9);
  assert.equal(bounceDip(buttonMotion.controlPressScale), 0.97);
  assert.equal(bounceDip(0.98), 0.98);
  assert.deepEqual([bouncePressMotion.rowPressScale, bouncePressMotion.tilePressScale], [0.975, 0.94]);
  assert.ok(overshoot(springSpec.press) < 0.01, "the dip lands without overshoot");
  assert.ok(Math.abs(overshoot(springSpec.release) - 0.13) < 0.02, "the release springs back about 13% past rest");
  assert.equal(pressReleaseDelay(30), 60);
  assert.equal(pressReleaseDelay(200), 0);
  const squish = source("./Squish.tsx");
  assert.match(squish, /usePressMotion\(\) === "bounce" && !!kind/, "rows and tiles squish only in bounce mode");
  assert.match(squish, /return style \? <Animated\.View style=\{style\}>\{children\}<\/Animated\.View> : children;/, "still mode adds no view around a row");
});

test("a row being renamed doesn't squish, so a pressMotion change can't remount its rename field", () => {
  assert.match(source("../sidebar/GroupBlock.tsx"), /useSquish\(renaming \? null : "row"\)/);
});

