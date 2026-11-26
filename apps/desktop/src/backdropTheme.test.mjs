import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { themedBackdropTheme, treatmentBackdropTheme, WINDOW_BACKDROP_CAPABILITY } from "./backdropTheme.ts";
import { baseLine, baseStops, GRAIN_POINTS, FILM_GRAIN_POINTS, overlayLine, swatchColors } from "./shims/web/gl/themeSwatch.ts";
import { createMacBackdrops, settleBackdrops, settleCrossFades } from "./platform/mac/macGlass.ts";

const PURPLE = [0.45, 0.3, 0.5, 1, 0.6, 0.45, 0.3, 1, 0.2, 0.3, 0.6, 0.8];

test("a themed profile's native backdrop paints the same under colour, gradients and grain the shell painted", () => {
  const size = { width: 300, height: 860 };
  const theme = themedBackdropTheme({ colors: PURPLE, opacity: 0.9, underlayAlpha: 0.4, grain: 0.3, texture: "sand", angle: 160, dark: true }, size);
  const [under, base, overlay, grain] = theme.layers;
  assert.equal(under.kind, "fill");
  assert.equal(under.opacity, 1);
  assert.equal(under.color[3], 1);
  assert.equal(base.kind, "gradient");
  const line = baseLine(size.width, size.height, 160);
  assert.deepEqual(base.start, [+line.x1.toFixed(5), +line.y1.toFixed(5)]);
  assert.deepEqual(base.end, [+line.x2.toFixed(5), +line.y2.toFixed(5)]);
  assert.equal(base.stops.length, baseStops(swatchColors(PURPLE)).length);
  assert.equal(base.opacity, 0.9);
  assert.ok(base.stops.every(({ color }) => color[4] === 0 && color.slice(0, 4).every((v) => v >= 0 && v <= 1)));
  const overLine = overlayLine(size.width, size.height, 160);
  assert.deepEqual(overlay.start, [+overLine.x1.toFixed(5), +overLine.y1.toFixed(5)]);
  assert.equal(overlay.stops[0].color[3], 0);
  assert.deepEqual(grain, { kind: "grain", texture: "sand", opacity: 0.3, points: GRAIN_POINTS });
  assert.equal(themedBackdropTheme({ colors: PURPLE.slice(0, 8), opacity: 1, underlayAlpha: 0, dark: false }, size).layers.length, 2);
  assert.equal(themedBackdropTheme({ colors: PURPLE, opacity: 1, underlayAlpha: 0, dark: false }, size).layers[1].start.length, 2);
});

test("a stock profile's native backdrop paints the window treatment and the preset film grain", () => {
  const theme = treatmentBackdropTheme({ dark: true, tintColor: "#7a4f8a", grainOpacity: 0.09, grainScale: 1 });
  const [base, tint, grain] = theme.layers;
  assert.deepEqual(base, { kind: "fill", color: [0, 0, 0, 0.4, 0], opacity: 1 });
  assert.equal(tint.kind, "gradient");
  assert.deepEqual([tint.start, tint.end], [[0.5, 0], [0.5, 1]]);
  assert.equal(tint.opacity, 0.5);
  assert.ok(tint.stops.every(({ color }) => color[4] === 1 && color[3] === 0.36));
  assert.deepEqual(grain, { kind: "grain", texture: "film", opacity: 0.09, points: FILM_GRAIN_POINTS });
  assert.equal(treatmentBackdropTheme({ dark: false, grainOpacity: 0 }).layers.length, 2);
  assert.equal(treatmentBackdropTheme({ dark: false, grainOpacity: 0.1, grainScale: 2 }).layers[2].points, FILM_GRAIN_POINTS * 2);
  assert.equal(treatmentBackdropTheme({ dark: false }).layers[0].color[3], 0.8);
});

test("the Mac backdrop registry sends each layer's theme with its ancestors' opacity and keeps measuring through fades", async () => {
  const sent = [];
  const frames = [];
  const fadesAsked = [];
  let fading = true;
  const element = {};
  const backdrops = createMacBackdrops({
    send: (regions) => (sent.push(regions), Promise.resolve()),
    measure: () => ({ x: 0, y: 0, width: 300, height: 800 }),
    frame: (run) => frames.push(run),
    timeout: () => 0,
    clearTimeout: () => {},
    watch: () => () => {},
    watchMotion: () => () => {},
    animating: (_layers, fades) => (fadesAsked.push(fades), fades && fading),
    opacity: () => 0.5,
  });
  backdrops.add(element, "windowTreatment", (size) => themedBackdropTheme({ colors: PURPLE, opacity: 1, underlayAlpha: 0, dark: true }, size));
  frames.splice(0).forEach((run) => run());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].material, "windowTreatment");
  assert.equal(sent[0][0].theme.opacity, 0.5);
  assert.ok(sent[0][0].theme.layers.length >= 3);
  assert.equal(fadesAsked.at(-1), true, "a themed backdrop follows opacity fades");
  assert.equal(frames.length, 1, "a fading themed backdrop keeps asking for frames");
  fading = false;
  const plain = createMacBackdrops({
    send: (regions) => (sent.push(regions), Promise.resolve()),
    measure: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    frame: (run) => run(),
    timeout: () => 0,
    clearTimeout: () => {},
    watch: () => () => {},
    watchMotion: () => () => {},
    animating: (_layers, fades) => (fadesAsked.push(fades), false),
  });
  plain.add({}, "liquid");
  assert.equal(fadesAsked.at(-1), false);
  assert.equal(sent.at(-1)[0].theme, undefined);
});

test("only the window's root backdrop is painted natively; Peek and Little Ardia keep their shell paint", () => {
  const shaders = readFileSync(new URL("./shims/shaders.tsx", import.meta.url), "utf8");
  assert.match(shaders, /const nativeTheme = nativeThemeAvailable && backdropRoot;/);
  assert.match(shaders, /if \(behindGlass && nativeTheme\) return <View ref=\{layer\} pointerEvents="none" style=\{style\} \/>;/);
  const root = readFileSync(new URL("./rootBackdropUi.tsx", import.meta.url), "utf8");
  assert.match(root, /<NativeBackdropRoot\.Provider value=\{true\}>/);
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /components\/ui\/index\.ts"\)\}\\0\$\{here\("\.\.\/browser\/src\/App\.tsx"\)\}`, here\("\.\/src\/rootBackdropUi\.tsx"\)/);
  assert.match(readFileSync(new URL("./ProfileTintTimeline.tsx", import.meta.url), "utf8"), /import \{ WindowBackdrop \} from "\.\/rootBackdropUi";/);
  for (const overlay of ["../../browser/src/components/peek/PeekOverlay.tsx", "./PeekOverlay.tsx", "../../browser/src/components/littleArdia/LittleArdiaWindow.tsx"]) {
    const source = readFileSync(new URL(overlay, import.meta.url), "utf8");
    assert.doesNotMatch(source, /NativeBackdropRoot|rootBackdropUi/, `${overlay} must keep painting its backdrop in the shell`);
  }
  assert.ok(!/rootBackdropUi/.test(vite.split("\n").filter((line) => /PeekOverlay|LittleArdia/.test(line)).join("\n")));
  assert.equal(WINDOW_BACKDROP_CAPABILITY, "shell.windowBackdrop");
});

test("a profile cross-fade keeps the bottom theme opaque so no vibrancy shows through mid-swipe", () => {
  const rect = { x: 0, y: 0, width: 300, height: 800 };
  const theme = (opacity) => ({ layers: [], opacity });
  const regions = [{ rect, material: "windowTreatment", theme: theme(0.5) }, { rect, material: "windowTreatment", theme: theme(0.5) }];
  const settled = settleCrossFades(regions, [true, true]);
  assert.equal(settled[0].theme.opacity, 1);
  assert.equal(settled[1].theme.opacity, 0.5);
  assert.equal(settleCrossFades(regions, [false, false])[0].theme.opacity, 0.5, "a plain stack keeps its own opacities");
  assert.equal(settleCrossFades([{ rect, material: "liquid", theme: theme(0.3) }, { rect: { ...rect, x: 10 }, material: "liquid", theme: theme(0.3) }], [true, true])[0].theme.opacity, 0.3, "different rects are separate stacks");
  assert.equal(settleCrossFades([{ rect, material: "liquid", theme: theme(0.8) }, { rect, material: "liquid", theme: theme(0.7) }], [true, true])[0].theme.opacity, 1);
  assert.deepEqual(settleCrossFades([{ rect, material: "liquid" }], [false]), [{ rect, material: "liquid" }]);
});

test("with three or more profiles the hidden ones drop out before the bottom of the cross-fade is pinned", () => {
  const rect = { x: 0, y: 0, width: 300, height: 800 };
  const theme = (opacity, hue) => ({ layers: [{ kind: "fill", color: [hue, 0, 0, 1, 0], opacity: 1 }], opacity });
  const entry = (opacity, hue) => ({ region: { rect, material: "windowTreatment", theme: theme(opacity, hue) }, additive: true });
  const settled = settleBackdrops([entry(0, 0.1), entry(0.5, 0.2), entry(0.5, 0.3)]);
  assert.equal(settled.length, 2, "the inactive first profile is not drawn");
  assert.equal(settled[0].theme.layers[0].color[0], 0.2, "the outgoing profile, not the inactive one, sits at the bottom");
  assert.equal(settled[0].theme.opacity, 1);
  assert.equal(settled[1].theme.opacity, 0.5);
  assert.deepEqual(settleBackdrops([entry(0, 0.1), entry(0, 0.2)]), []);
});

test("two identical half-opaque themes add up instead of collapsing to one half-opaque layer", () => {
  const rect = { x: 0, y: 0, width: 300, height: 800 };
  const same = () => ({ region: { rect, material: "windowTreatment", theme: { layers: [{ kind: "fill", color: [0.4, 0.2, 0.5, 1, 0], opacity: 1 }], opacity: 0.5 } }, additive: true });
  const settled = settleBackdrops([same(), same()]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].theme.opacity, 1);
  const plain = { region: { rect, material: "liquid" }, additive: false };
  assert.deepEqual(settleBackdrops([plain, plain]), [{ rect, material: "liquid" }]);
});
