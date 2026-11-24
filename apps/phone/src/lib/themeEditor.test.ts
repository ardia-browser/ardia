import assert from "node:assert/strict";
import { test } from "node:test";
import { padColor, startingTheme, withTexture } from "@ardia/core/src/theme.ts";
import { demoTheme, dialAngle, editedLook, keptReadable, lightnessSteps, padPoint, padWedges, rainbow, stepped, stopAt, turnedStop } from "./themeEditor.ts";

const blue = startingTheme("#4691C3");

test("a touch on the pad lands inside the circle, a touch past its edge on the edge", () => {
  assert.deepEqual(padPoint(116, 116, 232), { x: 0.5, y: 0.5 });
  const outside = padPoint(232, 116, 232);
  assert.deepEqual(outside, { x: 1, y: 0.5 });
  const corner = padPoint(232, 232, 232);
  assert.ok(Math.abs(Math.hypot(corner.x - 0.5, corner.y - 0.5) - 0.5) < 1e-9);
});

test("a touch picks the colour under it, within the knob's reach, else none", () => {
  const first = blue.stops[0]!;
  assert.equal(stopAt(blue, first.x * 232 + 10, first.y * 232, 232, 25), 0);
  assert.equal(stopAt(blue, 228, 228, 232, 25), -1);
});

test("the direction dial reads clockwise from up and snaps to each 45° notch within 4°", () => {
  assert.equal(dialAngle(0, -10, 4, 45), 0);
  assert.equal(dialAngle(10, 0, 4, 45), 90);
  assert.equal(dialAngle(0, 10, 4, 45), 180);
  assert.equal(dialAngle(-10, 0, 4, 45), 270);
  const near = (degrees: number) => dialAngle(Math.sin((degrees * Math.PI) / 180), -Math.cos((degrees * Math.PI) / 180), 4, 45);
  assert.equal(near(138), 135);
  assert.equal(near(150), 150);
  assert.equal(near(359), 0);
});

test("turning a colour for VoiceOver moves its hue and keeps its brightness", () => {
  const turned = turnedStop(blue, 0, 1 / 24);
  assert.notDeepEqual(turned.stops[0]!.color, blue.stops[0]!.color);
  assert.deepEqual(turned.stops[1], blue.stops[1]);
  assert.equal(turnedStop(blue, 5, 1 / 24), blue);
});

test("stepping a slider stays between 0 and 1 in hundredths", () => {
  assert.equal(stepped(0.95, 0.1), 1);
  assert.equal(stepped(0.05, -0.1), 0);
  assert.equal(stepped(0.5, 0.1), 0.6);
});

test("picking a texture with no noise sets the noise to a half, as on the Mac", () => {
  assert.equal(withTexture(blue, "sand").grain, 0.5);
  assert.equal(withTexture({ ...blue, grain: 0.2 }, "tweed").grain, 0.2);
});

test("a theme with separate light and dark looks edits the one shown", () => {
  assert.deepEqual(editedLook(blue, true), { theme: blue, editsDark: null });
  const split = { ...blue, dark: { ...blue, stops: [blue.stops[0]!], angle: 20 } };
  const dark = editedLook(split, true);
  assert.equal(dark.editsDark, true);
  assert.equal(dark.theme.stops.length, 1);
  assert.equal(dark.theme.dark, undefined);
  assert.equal(editedLook({ ...split, mode: "light" }, true).editsDark, false);
});

test("a look too dark for black text is kept dark, and says so", () => {
  const night = { ...blue, translucency: 0, mode: "light" as const, stops: blue.stops.map((s) => ({ ...s, color: { r: 0.05, g: 0.05, b: 0.1, a: 1 } })) };
  assert.equal(keptReadable(night, true), true);
  assert.equal(keptReadable(blue, false), false);
  assert.equal(keptReadable(blue, true), false);
});

test("the pad draws its hue wheel from the Mac's pad colours, and the bar every brightness of the stop", () => {
  const wedges = padWedges(4, 100);
  assert.equal(wedges.length, 4);
  assert.match(wedges[0]!.path, /^M 50 50 L /);
  const wheel = rainbow(7);
  assert.equal(wheel[0], wheel[6]);
  const steps = lightnessSteps({ x: 1, y: 0.5 }, 24);
  assert.equal(steps[0], "#000000");
  assert.equal(steps[23], "#FFFFFF");
  assert.equal(padColor(1, 0.5).r, 1);
});

test("the demo launch's custom theme is the native port's: three colours, sand noise, 225°", () => {
  const demo = demoTheme();
  assert.equal(demo.stops.length, 3);
  assert.equal(demo.texture, "sand");
  assert.equal(demo.angle, 225);
});
