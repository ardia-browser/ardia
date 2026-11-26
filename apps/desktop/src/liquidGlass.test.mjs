import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

class FakeTarget {
  listeners = new Map();
  addEventListener(type, handler, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const once = typeof options === "object" && options?.once;
    const wrapped = once ? (event) => (this.listeners.get(type)?.delete(wrapped), handler(event)) : handler;
    this.listeners.get(type).add(wrapped);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  dispatchEvent(event) {
    let prevented = false;
    const full = { preventDefault: () => (prevented = true), target: this, ...event };
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(full);
    return !prevented;
  }
  get listenerCount() {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

const targets = [];
const tracked = (target) => {
  targets.push(target);
  return target;
};
const listenerTotal = () => targets.reduce((sum, target) => sum + target.listenerCount, 0);

globalThis.Node = class Node extends FakeTarget {
  static TEXT_NODE = 3;
  static DOCUMENT_POSITION_FOLLOWING = 4;
};
globalThis.Element = class Element extends globalThis.Node {};
globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
globalThis.SVGSVGElement = class SVGSVGElement extends globalThis.Element {};
globalThis.HTMLImageElement = class HTMLImageElement extends globalThis.HTMLElement {};
globalThis.HTMLVideoElement = class HTMLVideoElement extends globalThis.HTMLElement {};

const glContexts = [];
const uploadFailures = { left: 0 };
const glErrors = [];
const allocationErrors = [];
let hitStack = null;
const lit = [];
let shownLight = 0;
let snapshotWalks = 0;
let colourReads = 0;

const constants = new Proxy({}, { get: (_, key) => (typeof key === "string" && /^[A-Z0-9_]+$/.test(key) ? key.length : undefined) });
function fakeGl(canvas) {
  const gl = new Proxy(
    { canvas, texSubImage2D: () => {
        if (uploadFailures.left > 0) {
          uploadFailures.left--;
          throw new DOMException("tainted", "SecurityError");
        }
      }, getError: () => glErrors.shift() ?? constants.NO_ERROR, texStorage2D: () => {
        if (allocationErrors.length) glErrors.push(allocationErrors.shift());
      }, getUniformLocation: (_, name) => ({ name }), uniform4f: (location, a, b, c, d) => {
        if (location?.name === "uLight") shownLight = d;
      }, isContextLost: () => false, getProgramParameter: () => true, getShaderParameter: () => true, getExtension: () => null, getAttribLocation: () => 0, checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === "string" && /^[A-Z0-9_]+$/.test(key)) return constants[key];
        return () => ({});
      },
    },
  );
  glContexts.push(gl);
  return gl;
}
function fake2d(canvas) {
  return new Proxy(
    { canvas, drawImage: (source) => {
        if (source?.gl) lit.push({ canvas, light: shownLight });
      }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getImageData: () => ({ data: new Uint8ClampedArray([128, 64, 32, 255]) }), measureText: () => ({ width: 1, fontBoundingBoxAscent: 1, fontBoundingBoxDescent: 1 }) },
    { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true },
  );
}

class FakeElement extends globalThis.HTMLElement {
  constructor(tag, rect = { left: 0, top: 0, width: 0, height: 0 }) {
    super();
    this.tagName = tag.toUpperCase();
    this.rect = rect;
    this.children = [];
    this.childNodes = this.children;
    this.parentElement = null;
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.clientLeft = 0;
    this.clientTop = 0;
  }
  get offsetWidth() {
    return this.rect.width;
  }
  get offsetHeight() {
    return this.rect.height;
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(other) {
    for (let node = other; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  compareDocumentPosition() {
    return 0;
  }
  hasAttribute() {
    return false;
  }
  matches() {
    return false;
  }
  closest() {
    return null;
  }
}
class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.width = 300;
    this.height = 150;
  }
  getContext(kind) {
    if (kind === "webgl2") return (this.gl ??= fakeGl(this));
    return (this.ctx2d ??= fake2d(this));
  }
}
globalThis.HTMLCanvasElement = FakeCanvas;
const images = [];
class FakeImage extends FakeElement {
  constructor() {
    super("img");
    this.complete = false;
    this.naturalWidth = 0;
    this.src = "";
    this.currentSrc = "";
    images.push(this);
  }
}
globalThis.HTMLImageElement = FakeImage;
globalThis.Image = FakeImage;

const canvases = [];
const body = new FakeElement("body", { left: 0, top: 0, width: 800, height: 600 });
const documentElement = tracked(new FakeElement("html", { left: 0, top: 0, width: 800, height: 600 }));
documentElement.appendChild(body);
documentElement.lang = "en";
documentElement.className = "";
globalThis.document = Object.assign(tracked(new FakeTarget()), {
  body,
  documentElement,
  createElement: (tag) => {
    if (tag !== "canvas") return new FakeElement(tag);
    const canvas = tracked(new FakeCanvas());
    canvases.push(canvas);
    return canvas;
  },
  createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
  elementsFromPoint: () => hitStack ?? [],
});
const media = [];
const timers = [];
const runTimers = () => {
  const due = timers.splice(0);
  for (const run of due) run?.();
};
const window = tracked(new FakeTarget());
Object.assign(window, {
  devicePixelRatio: 1,
  innerWidth: 800,
  innerHeight: 600,
  scrollX: 0,
  scrollY: 0,
  setTimeout: (run) => timers.push(run),
  clearTimeout: (id) => (timers[id - 1] = null),
  matchMedia: () => {
    const query = tracked(new FakeTarget());
    query.matches = false;
    media.push(query);
    return query;
  },
});
globalThis.window = window;
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
globalThis.getComputedStyle = (element) => {
  if (element === body) snapshotWalks++;
  if (element?.tagName === "BODY" || element?.tagName === "DIV") colourReads++;
  return new Proxy(
    { borderTopLeftRadius: "8px", backgroundColor: "rgb(120, 60, 90)", color: "rgb(0, 0, 0)", position: "static", display: "block", visibility: "visible", opacity: "1", overflow: "visible", zIndex: "auto", pointerEvents: "none", colorScheme: "light", backgroundImage: "none", borderTopWidth: "0px", borderTopStyle: "none", clipPath: "none", backgroundClip: "border-box" },
    { get: (target, key) => (key in target ? target[key] : "none") },
  );
};

let frames = [];
let frameRequests = 0;
globalThis.requestAnimationFrame = (callback) => {
  frameRequests++;
  frames.push(callback);
  return frames.length;
};
globalThis.cancelAnimationFrame = () => {};
let now = 1000;
const runFrames = (limit = 50) => {
  for (let i = 0; i < limit && frames.length; i++) {
    const due = frames;
    frames = [];
    now += 16;
    for (const callback of due) callback(now);
  }
};

const observers = { mutation: 0 };
globalThis.MutationObserver = class {
  constructor() {
    this.live = false;
  }
  observe() {
    if (!this.live) observers.mutation++;
    this.live = true;
  }
  disconnect() {
    if (this.live) observers.mutation--;
    this.live = false;
  }
};
const intersections = [];
globalThis.IntersectionObserver = class {
  constructor(callback) {
    this.callback = callback;
    intersections.push(this);
  }
  observe() {
    watched.intersection++;
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {
    watched.intersection = Math.max(0, watched.intersection - 1);
  }
};
const watched = { intersection: 0, resize: 0 };
globalThis.ResizeObserver = class {
  observe() {
    watched.resize++;
  }
  disconnect() {
    watched.resize = Math.max(0, watched.resize - 1);
  }
};
globalThis.Path2D = class {};
globalThis.DOMMatrix = class {};
globalThis.location = { href: "chrome://ardia/", origin: "chrome://ardia" };

const { getGlassEngine } = await import("../../../third_party/liquid-glass/engine.ts");
const { drawDom } = await import("../../../third_party/liquid-glass/dom-snapshot.ts");
const { attachGlass, mountGlass, invalidateLiquidGlass, liquidGlassMoving } = await import("./shims/web/liquidGlass.tsx");
const { backdropKeyOf, GLASS_OPTICS, glassGlow } = await import("./shims/web/liquidGlassOptics.ts");
const { glassAppearanceSupported, nativeLiquidGlass, webLiquidGlassAllowed } = await import("./liquidGlassSupport.ts");

function mountTile(left = 20) {
  const box = () => ({ left, top: 40, width: 60, height: 40 });
  const outer = new FakeElement("div", box());
  const frame = new FakeElement("div", box());
  const host = new FakeElement("div", box());
  const canvas = new FakeCanvas();
  body.appendChild(outer);
  outer.appendChild(frame);
  frame.appendChild(host);
  host.appendChild(canvas);
  const ready = [];
  const look = { current: { optics: GLASS_OPTICS.light.clear, tint: undefined } };
  const glass = mountGlass(host, canvas, canvas.getContext("2d"), look, (value) => ready.push(value));
  return { glass, ready, canvas, outer, host, look };
}

const pageListeners = () => window.listenerCount + document.listenerCount + documentElement.listenerCount + media.reduce((sum, query) => sum + query.listenerCount, 0);
const settle = () => new Promise((done) => queueMicrotask(done));

const tahoe = { bootstrap: { nativeModules: { ArdiaGlassEffect: { isLiquidGlass: true } } } };
const preTahoe = { bootstrap: { glassPanels: true, nativeModules: { ArdiaGlassEffect: { isLiquidGlass: false } } } };
const linux = { bootstrap: { glassPanels: true } };
const windows = { bootstrap: { glassPanels: false } };

const popover = { bootstrap: { windowKind: "popover", surface: "popover" } };

test("macOS 26 hands glass to NSGlassEffectView: WebGL is off however its native registry answers, and nothing is probed", () => {
  const probes = [];
  const probe = () => (probes.push(1), true);
  for (const host of [tahoe, { bootstrap: { ...tahoe.bootstrap, utility: {} } }, { bootstrap: { ...tahoe.bootstrap, glassPanels: false } }]) {
    assert.equal(nativeLiquidGlass(host), true);
    assert.equal(webLiquidGlassAllowed(host, true), false, "no WebGL glass on Tahoe, in a utility window, while the native reply is held or after it says unavailable");
    assert.equal(glassAppearanceSupported(host, probe, true), true);
  }
  for (const host of [popover, { bootstrap: {} }, undefined]) {
    assert.equal(webLiquidGlassAllowed(host, true), false, "a Mac window that does not say it is pre-Tahoe never opens the WebGL gate");
    assert.equal(glassAppearanceSupported(host, probe, true), false);
  }
  assert.equal(probes.length, 0, "Tahoe, or a Mac window that does not say, never creates a WebGL2 context to ask");
  assert.equal(glContexts.length, 0, "importing the glass creates no WebGL2 context");
  assert.equal(canvases.length, 0, "importing the glass creates no canvas");
  const chrome = readFileSync(new URL("./shims/web/chrome.tsx", import.meta.url), "utf8");
  assert.match(chrome, /enabled=\{scrolled === false && webLiquidGlassAllowed\(ardiaHost\)\}/, "GlassEffect gates WebGL on the synchronous bootstrap flag alone");
  assert.match(chrome, /tahoe && nativeGlassBehindWindow\(\)\);/, "only Tahoe registers GlassEffect with the native registry, scrolled pinned tiles and utility windows included");
  assert.match(readFileSync(new URL("./platform/nativeGlass.mac.ts", import.meta.url), "utf8"), /NATIVE_GLASS_PLATFORM = true/);
  const layer = readFileSync(new URL("./shims/web/liquidGlass.tsx", import.meta.url), "utf8");
  assert.match(layer, /const ctx = enabled \? surface\?\.getContext\("2d"\) : null;/, "a disabled layer never touches a canvas or the engine");
  assert.match(layer, /\{enabled \? <canvas /, "a disabled layer renders no canvas");
});

test("Linux, Windows and pre-Tahoe Macs offer Liquid Glass when WebGL2 works, and keep it off without it", () => {
  for (const [host, mac] of [[preTahoe, true], [linux, false], [windows, false]]) {
    assert.equal(nativeLiquidGlass(host), false);
    assert.equal(webLiquidGlassAllowed(host, mac), true);
    assert.equal(glassAppearanceSupported(host, () => true, mac), true);
    assert.equal(glassAppearanceSupported(host, () => false, mac), false);
  }
});

test("a mounted surface comes back after repeated context loss, holds no page listener while lost and none once every surface is gone", async () => {
  await settle();
  assert.equal(pageListeners(), 0, "nothing listens before the first surface");
  const { glass, ready } = mountTile();
  assert.ok(glass);
  runFrames();
  assert.deepEqual(ready, [true], "the surface reached WebGL");
  const listeners = listenerTotal();
  const watching = observers.mutation;
  for (let round = 0; round < 3; round++) {
    const gl = canvases.find((canvas) => canvas.gl === glContexts.at(-1));
    const allowed = gl.dispatchEvent({ type: "webglcontextlost" });
    assert.equal(allowed, false, "context loss is prevented so the browser may restore it");
    assert.equal(ready.at(-1), false, "a lost context hands the surface back to CSS");
    assert.equal(pageListeners(), 0, `round ${round}: no window or document listener while the context is lost`);
    assert.equal(observers.mutation, 0, `round ${round}: no theme observer while the context is lost`);
    assert.deepEqual(watched, { intersection: 0, resize: 0 }, `round ${round}: the surface observes nothing while the context is lost`);
    gl.dispatchEvent({ type: "webglcontextrestored" });
    runFrames();
    assert.equal(ready.at(-1), true, `round ${round}: the surface is drawn with WebGL again`);
    assert.equal(listenerTotal(), listeners, `round ${round}: global listeners stay at ${listeners}`);
    assert.equal(observers.mutation, watching, `round ${round}: observers stay at ${watching}`);
  }
  glass.stop();
  await settle();
  assert.equal(pageListeners(), 0, "no window or document listener once every surface is gone");
  assert.equal(observers.mutation, 0, "no observer once every surface is gone");
  assert.deepEqual(watched, { intersection: 0, resize: 0 });
});

test("moving an unpressed mouse over the page asks for no frame", () => {
  const { glass } = mountTile();
  runFrames();
  const before = frameRequests;
  for (let i = 0; i < 20; i++) window.dispatchEvent({ type: "pointermove", pointerType: "mouse", clientX: 10 + i, clientY: 30, pointerId: 1 });
  documentElement.dispatchEvent({ type: "pointerleave" });
  assert.equal(frameRequests - before, 0);
  glass.stop();
});

test("a backdrop change re-reads the surface colour and retakes the page picture at once", () => {
  const { glass } = mountTile();
  runFrames();
  const walks = snapshotWalks;
  const reads = colourReads;
  invalidateLiquidGlass();
  runFrames();
  assert.ok(snapshotWalks > walks, "the page picture is taken again inside the 120 ms cache");
  assert.ok(colourReads > reads, "the surface colour is read again");
  assert.notEqual(backdropKeyOf({ tintColor: "#aa0000" }, true), backdropKeyOf({ tintColor: "#00aa00" }, true), "a new profile tint in the same appearance changes the key");
  glass.stop();
});

test("one surface whose upload fails falls back to CSS alone and the shared frame keeps drawing the rest", () => {
  const first = mountTile();
  const second = mountTile();
  runFrames();
  assert.equal(first.ready.at(-1), true);
  assert.equal(second.ready.at(-1), true);
  uploadFailures.left = 1;
  invalidateLiquidGlass();
  assert.doesNotThrow(() => runFrames());
  const states = [first.ready.at(-1), second.ready.at(-1)].sort();
  assert.deepEqual(states, [false, true], "the failing surface is back on CSS and the other is still WebGL");
  first.glass.stop();
  second.glass.stop();
});

test("a scroll inside the 120 ms picture cache still retakes the picture once the cache window ends", () => {
  const { glass } = mountTile();
  runFrames();
  runTimers();
  runFrames();
  const walks = snapshotWalks;
  window.dispatchEvent({ type: "scroll" });
  runFrames();
  assert.equal(snapshotWalks, walks, "a scroll right after a picture reuses it");
  runTimers();
  runFrames();
  assert.ok(snapshotWalks > walks, "the trailing invalidation takes a fresh picture of what scrolled in");
  glass.stop();
  runTimers();
});

test("a texture the GPU cannot allocate (GL_OUT_OF_MEMORY) leaves that surface on CSS instead of calling it drawn", () => {
  allocationErrors.push(constants.OUT_OF_MEMORY);
  const failing = mountTile();
  runFrames();
  assert.equal(failing.ready.includes(true), false, "the surface never claimed a WebGL frame");
  const next = mountTile(100);
  runFrames();
  assert.equal(next.ready.at(-1), true, "the engine keeps drawing other surfaces");
  failing.glass.stop();
  next.glass.stop();
});

test("a press lights only the surface it began on, even when the pointer moves onto another before the next frame", () => {
  const pressed = mountTile(20);
  const other = mountTile(100);
  runFrames();
  lit.length = 0;
  window.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 7, pointerType: "mouse", clientX: 50, clientY: 60, target: body });
  window.dispatchEvent({ type: "pointermove", pointerId: 7, pointerType: "mouse", clientX: 130, clientY: 60, target: body });
  runFrames(10);
  const lights = (canvas) => lit.filter((entry) => entry.canvas === canvas && entry.light > 0).length;
  assert.ok(lights(pressed.canvas) > 0, "the pressed surface takes the light");
  assert.equal(lights(other.canvas), 0, "the surface the held pointer moved onto stays unlit");
  window.dispatchEvent({ type: "pointerup", pointerId: 7, pointerType: "mouse", target: body });
  runFrames();
  pressed.glass.stop();
  other.glass.stop();
});

const lose = () => canvases.find((canvas) => canvas.gl === glContexts.at(-1));

test("a surface that mounts while the context is lost waits for the restore and then draws with WebGL", async () => {
  await settle();
  const first = mountTile();
  runFrames();
  const gl = lose();
  gl.dispatchEvent({ type: "webglcontextlost" });
  const made = canvases.length;
  assert.equal(getGlassEngine(), null, "no engine is built against a lost GPU");
  assert.equal(canvases.length, made, "and no canvas or context is made for it");
  const latecomer = mountTile(100);
  assert.equal(latecomer.glass, null);
  const canvas = new FakeCanvas();
  latecomer.host.appendChild(canvas);
  const ready = [];
  const attachment = attachGlass(latecomer.host, canvas, canvas.getContext("2d"), latecomer.look, (value) => ready.push(value));
  assert.equal(attachment.mounted(), false, "the latecomer waits on CSS");
  gl.dispatchEvent({ type: "webglcontextrestored" });
  assert.equal(attachment.mounted(), true, "the restore attaches it");
  runFrames();
  assert.equal(ready.at(-1), true, "the latecomer is drawn with WebGL");
  assert.equal(first.ready.at(-1), true, "the surface that was there before is back too");
  attachment.stop();
  first.glass.stop();
  await settle();
});

test("an earlier, unrelated GL error never fails a healthy surface's new texture", () => {
  glErrors.push(constants.INVALID_OPERATION, constants.INVALID_VALUE);
  const healthy = mountTile();
  runFrames();
  assert.equal(healthy.ready.at(-1), true);
  healthy.glass.stop();
});

test("a press on overlapping glass lights the one stacked on top, not the one later in the document", () => {
  const top = mountTile(20);
  const below = mountTile(20);
  runFrames();
  lit.length = 0;
  hitStack = [top.outer, body, documentElement];
  window.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 9, pointerType: "mouse", clientX: 50, clientY: 60, target: body });
  runFrames(10);
  hitStack = null;
  const lights = (canvas) => lit.filter((entry) => entry.canvas === canvas && entry.light > 0).length;
  assert.ok(lights(top.canvas) > 0, "the glass on top takes the light");
  assert.equal(lights(below.canvas), 0, "the glass beneath it stays unlit");
  window.dispatchEvent({ type: "pointerup", pointerId: 9, pointerType: "mouse", target: body });
  runFrames();
  top.glass.stop();
  below.glass.stop();
});

test("leaving the window lets go of a press, so its light does not stick", () => {
  const tile = mountTile();
  runFrames();
  window.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 11, pointerType: "mouse", clientX: 50, clientY: 60, target: body });
  runFrames(5);
  lit.length = 0;
  window.dispatchEvent({ type: "blur" });
  runFrames(200);
  const last = lit.filter((entry) => entry.canvas === tile.canvas).at(-1);
  assert.ok(last, "the glass is drawn again as its light fades");
  assert.ok(last.light < 1 / 255, `the light fades below one 8-bit level after the window loses focus (${last.light})`);
  tile.glass.stop();
});

test("an image that fails to load releases every snapshot callback waiting on it", () => {
  const root = new FakeElement("div", { left: 0, top: 0, width: 100, height: 100 });
  const picture = new FakeImage();
  picture.rect = { left: 10, top: 10, width: 20, height: 20 };
  picture.currentSrc = "https://example.invalid/favicon.png";
  root.appendChild(picture);
  const pageCanvas = new FakeCanvas();
  const before = images.length;
  drawDom(pageCanvas.getContext("2d"), root, { origin: { left: 0, top: 0 }, onStale: () => {} });
  const copy = images.slice(before).find((image) => image !== picture && image.listenerCount > 0);
  assert.ok(copy, "the snapshot waits on its own copy of the image");
  copy.dispatchEvent({ type: "error" });
  assert.equal(copy.listenerCount, 0, "a failed image keeps no listener, and with it no surface's callback");
});

const isMoveCheck = (run) => !!run && String(run).includes("movedSinceDrawn()");
const moveChecks = () => timers.filter(isMoveCheck).length;
const runMoveChecks = () => {
  const due = timers.filter(isMoveCheck);
  for (let i = 0; i < timers.length; i++) if (isMoveCheck(timers[i])) timers[i] = null;
  for (const run of due) run();
};
const slideTile = ({ host, outer }, dx, dy = 0) => {
  for (const node of [outer, outer.children[0], host]) node.rect = { ...node.rect, left: node.rect.left + dx, top: node.rect.top + dy };
};
const settledTile = () => {
  const tile = mountTile();
  runFrames();
  runTimers();
  runFrames();
  return tile;
};

test("glass that slides into view keeps retaking its picture while it moves, with no event to say so, and goes quiet once still", () => {
  const tile = settledTile();
  assert.equal(moveChecks(), 0, "glass that stayed put leaves no move check behind");
  slideTile(tile, 70);
  intersections.at(-1).callback([{ isIntersecting: true }]);
  runFrames();
  slideTile(tile, 70);
  runFrames();
  const entered = snapshotWalks;
  runMoveChecks();
  runFrames();
  assert.ok(snapshotWalks > entered, "the picture is taken again where the glass slid on to");
  runMoveChecks();
  runFrames();
  const settled = snapshotWalks;
  runMoveChecks();
  runFrames();
  assert.equal(snapshotWalks, settled, "once still, it takes no further picture");
  assert.equal(moveChecks(), 0, "and no move check is left running");
  tile.glass.stop();
});

test("a pager moving settled, visible glass wakes it, and the pager settling retakes the picture where it came to rest", () => {
  const tile = settledTile();
  slideTile(tile, -90);
  runFrames();
  const still = snapshotWalks;
  assert.equal(moveChecks(), 0, "moving with no event and no intersection change arms nothing by itself");
  liquidGlassMoving();
  assert.equal(moveChecks(), 1, "the pager's motion arms one move check");
  liquidGlassMoving();
  assert.equal(moveChecks(), 1, "and only one, however many frames ask");
  runMoveChecks();
  runFrames();
  assert.ok(snapshotWalks > still, "the glass the pager moved retakes its picture");
  runMoveChecks();
  runFrames();
  slideTile(tile, 0.1);
  const beforeSettle = snapshotWalks;
  invalidateLiquidGlass();
  runFrames();
  assert.ok(snapshotWalks > beforeSettle, "the pager's settle takes one clean picture at the resting place, even for a move under the tolerance");
  tile.glass.stop();
  assert.equal(moveChecks(), 0, "a stopped glass leaves no move check");
});

test("subpixel jitter around a rounding edge never keeps the glass redrawing", () => {
  const tile = settledTile();
  for (const node of [tile.outer, tile.outer.children[0], tile.host]) node.rect = { ...node.rect, left: 20.24 };
  invalidateLiquidGlass();
  runFrames();
  const walks = snapshotWalks;
  for (let i = 0; i < 20; i++) {
    for (const node of [tile.outer, tile.outer.children[0], tile.host]) node.rect = { ...node.rect, left: i % 2 ? 20.24 : 20.26 };
    liquidGlassMoving();
    runMoveChecks();
    runFrames();
  }
  assert.equal(snapshotWalks, walks, "a 0.02 px wobble takes no new picture");
  assert.equal(moveChecks(), 0);
  tile.glass.stop();
});

test("the glass has no flat outline: its edge is a still key light from the top left, and a white pinned tile adds no white slab", () => {
  for (const theme of ["light", "dark"])
    for (const style of ["regular", "clear"]) {
      const optics = GLASS_OPTICS[theme][style];
      assert.ok(optics.borderAlpha <= 0.04, `${theme} ${style}: no uniform 1 px line around the control`);
      assert.ok(optics.rimLean > 0.5 && optics.rimAngle < -Math.PI / 2 && optics.rimAngle > -Math.PI, `${theme} ${style}: the rim is lit from the top left`);
    }
  assert.equal(glassGlow([255, 255, 255, 1]), null, "white (a template icon's fill) gives no glow");
  assert.equal(glassGlow([40, 40, 40, 1]), null, "grey gives no glow");
  assert.match(glassGlow([230, 30, 30, 1]) ?? "", /^rgba\(255,1\d\d,1\d\d,1\)$/, "a saturated colour glows in a lifted tint of itself");
  const chrome = readFileSync(new URL("./shims/web/chrome.tsx", import.meta.url), "utf8");
  assert.match(chrome, /if \(!glass\) return <View \{\.\.\.props\} style=\{\[\{ backgroundColor: outline \? undefined : fill/, "only the non-glass selection paints its fill");
});
