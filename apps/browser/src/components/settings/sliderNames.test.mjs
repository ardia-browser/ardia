import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));
await import("../../test-native/index.ts");
const { AmountSlider, LightnessBar, Slider } = await import("./ThemeControls.tsx");

const findTrack = (node) => {
  if (!node || typeof node !== "object") return null;
  if (typeof node.type === "function" && node.type.name === "Track") return node;
  for (const child of [].concat(node.props?.children ?? [])) {
    const found = findTrack(child);
    if (found) return found;
  }
  return null;
};

function adjustableOf(render) {
  const outer = mount(render);
  const track = findTrack(outer.value);
  assert.ok(track, "the control draws a slider track");
  return mount(() => track.type(track.props)).value.props;
}

test("every settings slider tells VoiceOver what it adjusts", () => {
  const amount = adjustableOf(() => AmountSlider({ label: "Tab corners", value: 0.5, onChange: () => {} }));
  assert.equal(amount.accessibilityRole, "adjustable");
  assert.equal(amount.accessibilityLabel, "Tab corners");
  assert.deepEqual(amount.accessibilityValue, { min: 0, max: 100, now: 50 });

  const slider = adjustableOf(() => Slider({ label: "Intensity", value: 0.2, onChange: () => {} }));
  assert.equal(slider.accessibilityLabel, "Intensity");
});

test("the theme editor's brightness bar names which colour it changes once there are several", () => {
  const stop = (x) => ({ x, y: 0.5, color: { h: 0, s: 0, l: 0.5 } });
  const bar = (stops, index) => adjustableOf(() => LightnessBar({ theme: { stops }, index, onChange: () => {} }));
  assert.equal(bar([stop(0.2)], 0).accessibilityLabel, "Brightness");
  assert.equal(bar([stop(0.2), stop(0.6)], 1).accessibilityLabel, "Colour 2 brightness");
});
