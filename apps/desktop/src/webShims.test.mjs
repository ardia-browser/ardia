import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const frames = new Map();
let nextFrame = 1;
const reported = [];
const windowListeners = new Map();
const documentListeners = new Map();
globalThis.document = { hidden: false, addEventListener: (type, listener) => documentListeners.set(type, listener) };
globalThis.window = {
  innerHeight: 800,
  addEventListener: (type, listener) => windowListeners.set(type, listener),
  removeEventListener: () => {},
};
globalThis.requestAnimationFrame = (callback) => {
  frames.set(nextFrame, callback);
  return nextFrame++;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.reportError = (error) => reported.push(error);
globalThis.HTMLIFrameElement ??= class {};

const { subscribeFrames } = await import("./shims/web/gl/clock.ts");
const { paletteColors, PALETTES } = await import("./shims/web/gl/colors.ts");
const { trackHover } = await import("./shims/web/motion/hover.ts");
const { isSoftwareRenderer, MEADOW_POSTERS, MEADOW_POSTER_URLS, meadowToneOf, nearestMeadowPoster } = await import("./shims/web/gl/meadow.ts");
const { backdropFragment, haloFragment, powerUpFragment } = await import("./shims/web/gl/sources.ts");
const { materialFill } = await import("./shims/web/materials.ts");
const { colorRoles } = await import("../../browser/src/components/ui/tokens.ts");
const { parseColor } = await import("./shims/web/chrome.tsx");
const { frameSubscription, measuredSize, MIN_FRAME_INTERVAL, stepAnimation, wantsFrames } = await import("./shims/web/gl/viewClock.ts");

function runFrame(now) {
  const pending = [...frames];
  frames.clear();
  for (const [, callback] of pending) callback(now);
}

test("a ticker that throws is reported and the frame loop keeps animating every other view", () => {
  const ticks = [];
  const stopBroken = subscribeFrames(() => {
    throw new Error("broken view");
  });
  const stopHealthy = subscribeFrames((dt) => ticks.push(dt));
  runFrame(1000);
  runFrame(1016);
  runFrame(1032);
  assert.equal(ticks.length, 3);
  assert.equal(reported.length, 3);
  assert.equal(frames.size, 1);
  stopBroken();
  stopHealthy();
  runFrame(1048);
  assert.equal(frames.size, 0);
});

test("palette names only match the palettes themselves, never properties every object inherits", () => {
  assert.equal(paletteColors(["pink"]).length, PALETTES.pink.length);
  assert.equal(paletteColors(["toString"]), null);
  assert.equal(paletteColors(["constructor"]), null);
  assert.equal(paletteColors(["__proto__"]), null);
  assert.deepEqual(paletteColors(["#FF0000"]), [[1, 0, 0, 1]]);
});

function hoverNode(rect) {
  return { isConnected: true, getBoundingClientRect: () => rect, closest: () => null };
}

function hoverEntry(node, calls, label) {
  return { node: () => node, enter: () => (e) => calls.push(`${label} enter ${e.nativeEvent.clientX},${e.nativeEvent.clientY}`), leave: () => () => calls.push(`${label} leave`), inside: false };
}

test("a hover area that appears under a pointer that has stopped moving gets its enter right away, and its leave once the pointer goes", () => {
  const box = { left: 100, top: 100, right: 200, bottom: 150, width: 100, height: 50 };
  const point = (x, y) => ({ clientX: x, clientY: y, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  windowListeners.get("pointermove")(point(120, 110));
  const calls = [];
  const stopFirst = trackHover(hoverEntry(hoverNode(box), calls, "first"));
  assert.deepEqual(calls, ["first enter 20,10"]);
  const stopAway = trackHover(hoverEntry(hoverNode({ ...box, left: 300, right: 400 }), calls, "away"));
  assert.deepEqual(calls, ["first enter 20,10"]);
  windowListeners.get("pointermove")(point(130, 112));
  assert.deepEqual(calls, ["first enter 20,10"]);
  windowListeners.get("pointermove")(point(320, 112));
  assert.deepEqual(calls, ["first enter 20,10", "first leave", "away enter 20,12"]);
  stopFirst();
  stopAway();
});

test("a sidebar row gets its leave when the pointer goes straight into a page, from the leave the host sends the shell when the page takes the pointer", () => {
  const box = { left: 0, top: 100, right: 240, bottom: 130, width: 240, height: 30 };
  const point = (x, y) => ({ clientX: x, clientY: y, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  windowListeners.get("pointermove")(point(200, 110));
  const calls = [];
  const stop = trackHover(hoverEntry(hoverNode(box), calls, "row"));
  assert.deepEqual(calls, ["row enter 200,10"]);
  documentListeners.get("mouseout")({ relatedTarget: { tagName: "DIV" } });
  assert.deepEqual(calls, ["row enter 200,10"]);
  documentListeners.get("mouseout")({ relatedTarget: null });
  assert.deepEqual(calls, ["row enter 200,10", "row leave"]);
  stop();
});

test("the meadow starts on the poster the Mac picks for the window's shape, dawn normally and morning with reduced motion", () => {
  assert.equal(nearestMeadowPoster(1.6, false)?.file, "dawn-laptop-1920.webp");
  assert.equal(nearestMeadowPoster(2, false)?.file, "dawn-wide-1920.webp");
  assert.equal(nearestMeadowPoster(3, false)?.file, "dawn-wider-2400.webp");
  assert.equal(nearestMeadowPoster(1, false)?.file, "dawn-mid-1600.webp");
  assert.equal(nearestMeadowPoster(1.6, true)?.file, "morning-laptop-1625.webp");
  assert.deepEqual(Object.keys(MEADOW_POSTER_URLS).sort(), MEADOW_POSTERS.map((poster) => poster.file).sort());
  for (const url of Object.values(MEADOW_POSTER_URLS)) assert.match(url, /\/packages\/shaders\/ios\/Meadow\/(dawn|morning)-[a-z]+-\d+\.webp$/);
});

test("the meadow reports the text tone and halo the scene sets, and the opening tone until it has set one", () => {
  assert.deepEqual(meadowToneOf("dark", "0.42", false), { tone: "dark", halo: 0.42 });
  assert.deepEqual(meadowToneOf("light", "", true), { tone: "light", halo: 0 });
  assert.deepEqual(meadowToneOf(undefined, "", true), { tone: "dark", halo: 0 });
  assert.deepEqual(meadowToneOf(undefined, "nope", false), { tone: "light", halo: 0 });
  assert.deepEqual(meadowToneOf("sepia", "1", false), { tone: "light", halo: 1 });
});

test("a software renderer keeps the meadow on its still poster instead of drawing the scene on the CPU", () => {
  assert.equal(isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"), true);
  assert.equal(isSoftwareRenderer("llvmpipe (LLVM 19.1.7, 256 bits)"), true);
  assert.equal(isSoftwareRenderer("ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir ACO), OpenGL ES 3.2)"), false);
  assert.equal(isSoftwareRenderer("Mesa Intel(R) UHD Graphics 620 (KBL GT2)"), false);
});

test("the PowerUp and Halo shaders never call pow where ANGLE's D3D11 backend returns NaN for a zero or negative base", () => {
  const halo = haloFragment;
  const power = powerUpFragment;
  assert.doesNotMatch(halo, /pow\(w,/);
  assert.match(halo, /vec4 w2 = w \* w;\s*w = w2 \* w2;/);
  assert.doesNotMatch(power, /pow\(lms,/);
  assert.match(power, /lms = lms \* lms \* lms;/);
  assert.doesNotMatch(power, /pow\(-2\.0 \* t \+ 2\.0,/);
  assert.match(power, /float u2 = u \* u;\s*return 1\.0 - u2 \* u2 \* 0\.5;/);
  assert.doesNotMatch(power, /pow\(abs\(crossPos/);
  assert.match(power, /float bend = \(1\.0 - b2 \* b2 \* b\) \* -0\.0500000007;/);
  for (const division of power.matchAll(/[^\n]*\/ edge[^\n]*/g)) assert.match(division[0], /edge > 0\.0 \?/);
  assert.match(power, /\/ edge/);
  for (const source of [halo, power, backdropFragment]) {
    for (const call of source.matchAll(/pow\(([^,]+),/g)) assert.match(call[1], /^(2\.0|a|ac|abs\([^)]*\))$/, `pow(${call[1]}, …) may see a base of zero or below`);
  }
});

test("a GL view sizes its canvas from the first layout instead of waiting at 300 by 150 for the resize observer", () => {
  assert.deepEqual(measuredSize(200, 100, 2), { css: [200, 100], pixels: [400, 200] });
  assert.deepEqual(measuredSize(100.4, 50.2, 1.5), { css: [100.4, 50.2], pixels: [151, 75] });
  assert.deepEqual(measuredSize(80, 40, 0), { css: [80, 40], pixels: [80, 40] });
  assert.equal(measuredSize(0, 100, 2), null);
  assert.equal(measuredSize(100, 0, 2), null);
});

test("an animated GL view holds its clock at zero until it has a size, then plays every frame and stops on the last one", () => {
  const clock = { css: [0, 0], time: 0, started: false, pending: 0 };
  assert.equal(stepAnimation(clock, 0.5, 1), "unmeasured");
  assert.equal(stepAnimation(clock, 0.5, 1), "unmeasured");
  assert.deepEqual([clock.time, clock.started, clock.pending], [0, false, 0]);
  clock.css = [120, 60];
  assert.equal(stepAnimation(clock, 0.5, 1), "draw");
  assert.deepEqual([clock.time, clock.started], [0, true]);
  assert.equal(stepAnimation(clock, 0.001, 1), "skip");
  assert.equal(clock.time, 0);
  assert.equal(stepAnimation(clock, MIN_FRAME_INTERVAL, 1), "draw");
  assert.ok(Math.abs(clock.time - (0.001 + MIN_FRAME_INTERVAL)) < 1e-9);
  assert.equal(stepAnimation(clock, 5, 1), "finish");
  assert.equal(clock.time, 1);
});

test("an onscreen GL view with no size holds no frame subscription, and takes one only once it is measured", () => {
  let subscribed = 0;
  let unsubscribed = 0;
  const frames = frameSubscription(() => {
    subscribed++;
    return () => unsubscribed++;
  });
  const clock = { css: [0, 0], done: false };
  const sync = (visible) => frames.sync(wantsFrames(visible, clock.css, clock.done));
  sync(true);
  sync(true);
  assert.equal(frames.active(), false);
  assert.equal(subscribed, 0);
  clock.css = [0, 40];
  sync(true);
  assert.equal(frames.active(), false);
  clock.css = [120, 40];
  sync(true);
  sync(true);
  assert.deepEqual([frames.active(), subscribed, unsubscribed], [true, 1, 0]);
  clock.css = [0, 0];
  sync(true);
  assert.deepEqual([frames.active(), subscribed, unsubscribed], [false, 1, 1]);
  clock.css = [120, 40];
  sync(false);
  assert.equal(frames.active(), false);
  sync(true);
  assert.deepEqual([frames.active(), subscribed], [true, 2]);
  clock.done = true;
  sync(true);
  assert.deepEqual([frames.active(), subscribed, unsubscribed], [false, 2, 2]);
});

test("a light toast keeps a light HUD under its dark text, and the HUD close button keeps a dark plate under its white glyph, with or without page glass", () => {
  const over = (top, bottom) => {
    const [r, g, b, a] = parseColor(top);
    return [0, 1, 2].map((i) => [r, g, b][i] * a + bottom[i] * (1 - a));
  };
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const material = (name, dark, opaque) => {
    const fill = materialFill(name, dark);
    if (!opaque) return fill;
    const [r, g, b] = parseColor(fill);
    return `rgba(${r},${g},${b},1)`;
  };
  const light = colorRoles.light;
  const dark = colorRoles.dark;
  const backdrops = [[255, 255, 255], [128, 128, 128], [0, 0, 0]];
  for (const opaque of [false, true]) {
    for (const page of backdrops) {
      const toast = over(material("hudWindow", false, opaque), over(light.toastFill, page));
      assert.ok(contrast(over(light.textPrimary, toast), toast) >= 7, `light toast text over ${page}, opaque ${opaque}`);
      assert.ok(contrast(over(light.textSecondary, toast), toast) >= 3, `light toast secondary text over ${page}, opaque ${opaque}`);
      const darkToast = over(material("hudWindow", true, opaque), over(dark.toastFill, page));
      assert.ok(contrast(over(dark.textPrimary, darkToast), darkToast) >= 7, `dark toast text over ${page}, opaque ${opaque}`);
      const plate = over(light.hudCloseFill, over(material("hudWindow", true, opaque), page));
      assert.ok(contrast(over(light.hudCloseGlyph, plate), plate) >= 4.5, `light HUD close over ${page}, opaque ${opaque}`);
      const darkPlate = over(dark.hudCloseFill, over(material("hudWindow", true, opaque), page));
      assert.ok(contrast(over(dark.hudCloseGlyph, darkPlate), darkPlate) >= 3, `dark HUD close over ${page}, opaque ${opaque}`);
    }
  }
  const lightPlateOnWhite = over(light.hudCloseFill, over(material("hudWindow", false, false), [255, 255, 255]));
  assert.ok(contrast(over(light.hudCloseGlyph, lightPlateOnWhite), lightPlateOnWhite) < 2, "a light HUD material under the white glyph is what the plate's dark scope avoids");
  assert.match(readFileSync(new URL("../../browser/src/components/ui/ButtonKinds.tsx", import.meta.url), "utf8"), /<ThemeOverride theme=\{themeFor\(HUD_PLATE_THEME\)\}>\s*<VisualEffect material="hudWindow"/);
});

test("the folder icon draws FolderIconView's back tab, interior and flap, and tilts the flap open on smoothstep", async () => {
  const art = await import("./shims/web/folderArt.ts");
  const closed = art.folderShapes(0);
  const open = art.folderShapes(1);
  assert.equal(closed.top, 18);
  assert.equal(open.top, 28);
  assert.equal(art.folderShapes(-1).rear, closed.rear);
  assert.equal(art.folderShapes(2).front, open.front);
  assert.match(closed.rear, /^M34 88Q26 88 26 80L26 29Q26 21 /);
  assert.match(closed.front, /^M26 45Q26 36 35 36L87 36Q96 36 96 45/);
  assert.match(open.front, /^M/);
  assert.equal(art.smoothstep(0.5), 0.5);
  assert.ok(art.smoothstep(0.25) < 0.25);
  const half = art.folderShapes(0.5);
  assert.notEqual(half.rear, closed.rear);
  assert.equal(half.top, 23);
  assert.deepEqual(art.FOLDER_PALETTE, { stroke: "#443AFF", face: "#F4F3FF", insideTop: "#BFBCFF", insideBottom: "#8781FF" });
  assert.equal(art.VIEW_BOX, "0.25 -7.75 121.5 121.5");
  const icon = readFileSync(new URL("./shims/web/FolderIcon.tsx", import.meta.url), "utf8");
  for (const prop of ["face", "insideTop", "insideBottom", "stroke"]) assert.doesNotMatch(icon, new RegExp(`${prop}: _`), `${prop} is drawn, not dropped`);
  assert.match(icon, /prefers-reduced-motion/);
  assert.equal(readFileSync(new URL("../../../packages/demo/src/shims/web/folderArt.ts", import.meta.url), "utf8"), readFileSync(new URL("./shims/web/folderArt.ts", import.meta.url), "utf8"), "the demo draws the same folder");
  assert.equal(readFileSync(new URL("../../../packages/demo/src/shims/web/FolderIcon.tsx", import.meta.url), "utf8"), icon, "the demo animates the same folder");
});

test("a repeating Retina tile keeps its 1x point size and other images pass through", async () => {
  const { scaledSource, tiledBackground } = await import("./shims/web/scaledTile.ts");
  const stripes = { uri: "/assets/dev-stripes-dark-ink@2x.png", width: 28, height: 28, scale: 2 };
  assert.deepEqual(tiledBackground(stripes, "repeat", undefined), {
    backgroundImage: 'url("/assets/dev-stripes-dark-ink@2x.png")',
    backgroundPosition: "left top",
    backgroundRepeat: "repeat",
    backgroundSize: "28px 28px",
  });
  assert.equal(tiledBackground(stripes, "cover", undefined), null);
  assert.equal(tiledBackground(stripes, undefined, undefined), null);
  assert.equal(tiledBackground(stripes, "repeat", "#ff0000"), null);
  assert.equal(tiledBackground("/assets/dev-stripes-dark-ink.png", "repeat", undefined), null);
  assert.equal(tiledBackground({ uri: "/a.png", width: 28, height: 28, scale: 1 }, "repeat", undefined), null);
  assert.equal(tiledBackground([stripes], "repeat", undefined), null);
  assert.equal(scaledSource({ uri: "/a@3x.png", width: 0, height: 11, scale: 3 }), null);
  assert.equal(scaledSource({ uri: "", width: 11, height: 11, scale: 3 }), null);
  assert.deepEqual(scaledSource({ uri: "/a@3x.png", width: 11, height: 11, scale: 3, extra: 1 }), { uri: "/a@3x.png", width: 11, height: 11, scale: 3 });
});

test("a bordered view that clips its content draws its border as a ring above the content, the way React Native does", async () => {
  const { borderBoxClip } = await import("./shims/web/motion/borderClip.ts");
  const card = { overflow: "hidden", borderRadius: 12, borderWidth: 2, borderStyle: "solid", borderColor: "#0A84FF" };
  const clip = borderBoxClip(card);
  assert.equal(clip.style.overflow, "clip");
  assert.equal(clip.style.overflowClipMargin, "border-box");
  assert.equal(clip.style.borderTopColor, "transparent");
  assert.equal(clip.style.isolation, "isolate");
  assert.deepEqual(clip.ring, {
    position: "absolute", top: -2, right: -2, bottom: -2, left: -2, boxSizing: "border-box",
    borderStyle: "solid", borderWidth: 2, borderColor: "#0A84FF", pointerEvents: "none", zIndex: 2147483647,
    borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomRightRadius: 12, borderBottomLeftRadius: 12,
  });
  assert.equal(borderBoxClip({ ...card, borderStyle: "dashed", borderTopLeftRadius: 4 }).ring.borderTopLeftRadius, 4);
  assert.equal(borderBoxClip({ ...card, borderStyle: "dashed" }).ring.borderStyle, "dashed");
  assert.equal(borderBoxClip({ ...card, overflow: "visible" }), null);
  assert.equal(borderBoxClip({ overflow: "hidden", borderRadius: 12 }), null);
  assert.equal(borderBoxClip(undefined), null);
  for (const uneven of [{ borderBottomWidth: 1 }, { borderTopColor: "#FF0000" }, { borderColor: undefined }, { borderTopStartRadius: 3 }]) {
    assert.deepEqual(borderBoxClip({ ...card, ...uneven }), { style: { overflow: "clip", overflowClipMargin: "border-box" }, ring: null }, JSON.stringify(uneven));
  }
});

test("web glass keeps the plain backdrop-filter fallback the demo draws, under Wave D's native handoff, with no painted rims", () => {
  const desktop = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const demo = (path) => readFileSync(new URL(`../../../packages/demo/src/${path}`, import.meta.url), "utf8");
  assert.equal(desktop("./shims/web/glassRim.ts"), demo("shims/web/glassRim.ts"));
  const glassOf = (source) => source.slice(source.indexOf("export function GlassEffect("), source.indexOf("\n}\n", source.indexOf("export function GlassEffect(")));
  const shown = glassOf(desktop("./shims/web/chrome.tsx"));
  const web = glassOf(demo("shims/web/chrome.tsx"));
  const layersOf = (body) => body.split("\n").map((line) => line.trim()).filter((line) => /^(<div style=\{|\{tint \? <div style=\{\{ \.\.\.layer, \.\.\.shaped)/.test(line)).map((line) => line.replace(/\{\{ \.\.\.(backdrop\(.*\)), \.\.\.fade \}\}/, "{$1}").replace(/, \.\.\.fade/g, ""));
  assert.equal(layersOf(shown).length, 4);
  assert.deepEqual(layersOf(shown), layersOf(web), "the desktop fallback draws the demo's backdrop, tint and brightened edge");
  for (const body of [shown, web]) assert.doesNotMatch(body, /boxShadow|rgba\(255, ?255, ?255|data-ardia-glass-rim|data-ardia-glass-ring/, "no painted white rim or ring");
  assert.match(shown, /useGlassLook\(frame, \{ material: clear \? "clear" : "regular", tint: glassTint\(tint\), group: group \?\? undefined, appearance: theme \}, tahoe && nativeGlassBehindWindow\(\)\);/, "native Liquid Glass takes over on macOS 26, and only there, scrolled pinned tiles and utility windows included");
  assert.match(shown, /const tahoe = nativeLiquidGlass\(ardiaHost\);/, "the handoff reads the synchronous Tahoe bootstrap flag");
  assert.match(shown, /<View ref=\{frame\} pointerEvents="none" style=\{glassLayer\}>\n\s+<LiquidGlassLayer\n\s+hostRef=\{\(node\) => void \(host\.current = node\)\}\n\s+hostProps=\{GLASS_LAYERS\}/, "the glass layer the native handoff hides holds both the WebGL canvas and the CSS fallback");
  assert.match(desktop("./shims/web/chrome.tsx"), /const GLASS_LAYERS = \{ "data-ardia-glass-layers": "" \};/);
  assert.equal(shown.match(/\{children\}/g)?.length, 2, "hosted content renders in the scrolled and the shaped glass");
  assert.match(desktop("./base.css"), /\[data-ardia-glass-effect\]\[data-ardia-glass="on"\] > \[data-ardia-glass-layers\] \{\n\s+visibility: hidden;/);
});

test("a faded GlassEffect fades only its measured glass layer, and the content it hosts stays opaque", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { GlassEffect, glassFrameStyles } = await import("./shims/web/chrome.tsx");
  const { outer, glassLayer } = glassFrameStyles([{ position: "absolute", top: -1, alignItems: "center" }, { opacity: 0.25 }], 8);
  assert.deepEqual(outer, { position: "absolute", top: -1, alignItems: "center" }, "the hosting frame keeps layout and drops the fade");
  assert.deepEqual(glassLayer, { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: 8, opacity: 0.25 }, "the measured glass layer carries the fade and the radius");
  assert.equal(glassFrameStyles(undefined, 4).glassLayer.opacity, undefined);
  const html = renderToStaticMarkup(createElement(GlassEffect, { cornerRadius: 8, style: { opacity: 0.25 } }, createElement("span", { id: "hosted" }, "Go")));
  const layers = html.indexOf("data-ardia-glass-layers");
  const hosted = html.indexOf('<span id="hosted">');
  assert.ok(html.startsWith("<div data-ardia-glass-layers") && hosted > layers, html);
  let depth = 0;
  let closed = -1;
  for (const tag of html.matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) {
      closed = tag.index;
      break;
    }
  }
  assert.ok(closed > 0 && closed < hosted, "the hosted content sits after the CSS fallback, outside anything the fade or the native handoff hides");
  const source = readFileSync(new URL("./shims/web/chrome.tsx", import.meta.url), "utf8");
  assert.match(source, /<View pointerEvents="none" \{\.\.\.props\} style=\{outer\}>\n\s+<View ref=\{frame\} pointerEvents="none" style=\{glassLayer\}>/);
  assert.match(source, /\/>\n\s+<\/View>\n\s+\{children\}\n\s+<\/View>/, "children are the glass layer's sibling");
});

test("scrolled glass keeps main's frosted surface, fades only its glass layer and renders hosted content beside it", () => {
  const source = readFileSync(new URL("./shims/web/chrome.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function GlassEffect("), source.indexOf("\n}\n", source.indexOf("export function GlassEffect(")));
  const scrolled = body.slice(body.indexOf("  if (scrolled) {"), body.indexOf("\n  }\n", body.indexOf("  if (scrolled) {")));
  assert.match(scrolled, /<View pointerEvents="none" \{\.\.\.props\} style=\{outer\}>\n\s+<View ref=\{frame\} pointerEvents="none" style=\{glassLayer\}>\n\s+<div ref=\{host\} data-ardia-glass-layers="" style=\{scrolledGlassSurface\(theme, clear, cornerRadius\)\}>/);
  assert.match(scrolled, /<\/div>\n\s+<\/View>\n\s+\{children\}\n\s+<\/View>/, "hosted content sits beside the faded scrolled glass");
  assert.doesNotMatch(scrolled, /boxShadow|rgba\(255/, "the scrolled branch paints nothing of its own");
  const surface = source.slice(source.indexOf("function scrolledGlassSurface("), source.indexOf("\n}\n", source.indexOf("function scrolledGlassSurface(")));
  assert.match(surface, /inset 0 1px 0\.5px rgba\(255,255,255,0\.2\), inset 0 0 0 0\.5px rgba\(255,255,255,0\.1\), 0 1px 3px rgba\(0,0,0,0\.26\)/, "dark scrolled glass keeps main's hairline edge");
  assert.match(surface, /inset 0 1px 0\.5px rgba\(255,255,255,0\.82\), inset 0 0 0 0\.5px rgba\(255,255,255,0\.48\), 0 1px 3px rgba\(0,0,0,0\.07\)/, "light scrolled glass keeps main's hairline edge");
});
