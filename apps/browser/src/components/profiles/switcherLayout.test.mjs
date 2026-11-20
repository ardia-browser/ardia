import assert from "node:assert/strict";
import { test } from "node:test";
import { switcherIcons } from "./switcherLayout.ts";
import { profileSwitcher } from "./tokens.ts";

const { dotCell, iconCell } = profileSwitcher;
const saved = ["🐶", "🏠", "💼", "🎮", "📚", "🎵", "✈️", "☕️", "🌿", "⭐️"];
const allIcons = saved.length * iconCell;

test("every icon shows when the whole row of icons fits", () => {
  assert.deepEqual(switcherIcons(saved, true, allIcons, 3), saved);
});

test("when the icons don't fit, the other profiles fall back to dots and the active one keeps its icon", () => {
  const icons = switcherIcons(saved, true, allIcons - 1, 3);
  assert.deepEqual(icons, saved.map((icon, i) => (i === 3 ? icon : null)));
});

test("the active profile's icon follows the switch", () => {
  const icons = switcherIcons(saved, true, allIcons - 1, 0);
  assert.equal(icons[0], "🐶");
  assert.equal(icons.filter(Boolean).length, 1);
});

test("all dots when even one icon among dots doesn't fit", () => {
  const oneIcon = (saved.length - 1) * dotCell + iconCell;
  assert.equal(switcherIcons(saved, true, oneIcon, 3)[3], "🎮");
  assert.deepEqual(switcherIcons(saved, true, oneIcon - 1, 3), saved.map(() => null));
});

test("an active profile without an icon stays a dot", () => {
  const withBlank = saved.map((icon, i) => (i === 3 ? null : icon));
  assert.deepEqual(switcherIcons(withBlank, true, allIcons - iconCell, 3), saved.map(() => null));
});

test("icons off means dots, whatever the room", () => {
  assert.deepEqual(switcherIcons(saved, false, 10_000, 3), saved.map(() => null));
});
