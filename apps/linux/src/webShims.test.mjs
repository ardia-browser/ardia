import assert from "node:assert/strict";
import test from "node:test";

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
  assert.equal(nearestMeadowPoster(1.6, false)?.file, "dawn-laptop-1917.webp");
  assert.equal(nearestMeadowPoster(2, false)?.file, "dawn-wide-1766.webp");
  assert.equal(nearestMeadowPoster(3, false)?.file, "dawn-wider-2196.webp");
  assert.equal(nearestMeadowPoster(1, false)?.file, "dawn-mid-1600.webp");
  assert.equal(nearestMeadowPoster(1.6, true)?.file, "morning-laptop-1493.webp");
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
