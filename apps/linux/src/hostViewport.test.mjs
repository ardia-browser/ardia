import assert from "node:assert/strict";
import test from "node:test";
import { STACKED_PAGE, tabViewport, watchTabViewport } from "./hostViewport.ts";

const GLOBALS = ["window", "document", "getComputedStyle", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver"];
const box = (x, y, width, height) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height });

function stage({ width = 1280, height = 800, elementFromPoint, querySelector = () => null, getAnimations }) {
  const previous = Object.fromEntries(GLOBALS.map((key) => [key, globalThis[key]]));
  const frames = [];
  const events = { window: new EventTarget(), document: new EventTarget(), visual: new EventTarget() };
  let mutated = () => {};
  let disconnected = false;
  globalThis.window = Object.assign(events.window, { innerWidth: width, innerHeight: height, visualViewport: events.visual });
  globalThis.document = Object.assign(events.document, { documentElement: {}, hidden: false, querySelector, elementFromPoint, ...(getAnimations ? { getAnimations } : {}) });
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected = true; } };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.MutationObserver = class { constructor(callback) { mutated = callback; } observe() {} disconnect() {} };
  return {
    events,
    frames,
    disconnected: () => disconnected,
    mutate: () => {
      mutated([]);
      frames.shift()?.();
    },
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

const cover = (overlays = []) => ({
  overlayAt: (x, y) => overlays.some(({ rect }) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height),
  overlayElements: () => overlays.map(({ element }) => element),
});

test("a page viewport is a plain rect that follows scroll, visual zoom and document visibility", () => {
  let rect = box(200, 50, 800, 600);
  const element = { isConnected: true, parentElement: null, getBoundingClientRect: () => rect, contains: () => false };
  const s = stage({ elementFromPoint: () => element });
  try {
    const updates = [];
    const stop = watchTabViewport(element, () => true, (update) => updates.push(update), cover());
    assert.deepEqual(updates.at(-1), { rect: { x: 200, y: 50, width: 800, height: 600 }, visible: true });
    rect = box(250, 50, 800, 600);
    s.events.window.dispatchEvent(new Event("scroll"));
    assert.equal(updates.at(-1).rect.x, 250);
    rect = box(250, 50, 720, 600);
    s.events.visual.dispatchEvent(new Event("resize"));
    assert.equal(updates.at(-1).rect.width, 720);
    document.hidden = true;
    s.events.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(updates.at(-1).visible, false);
    document.hidden = false;
    s.events.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(updates.at(-1).visible, true);
    assert.ok(updates.every((update) => !("occlusions" in update)));
    stop();
    assert.equal(s.disconnected(), true);
    const count = updates.length;
    s.events.window.dispatchEvent(new Event("scroll"));
    assert.equal(updates.length, count);
  } finally {
    s.restore();
  }
});

test("a registered overlay over a page keeps it shown; anything else covering it, or a hidden ancestor, hides it", () => {
  const page = { isConnected: true, parentElement: null, getBoundingClientRect: () => box(190, 47, 1083, 846), contains: (node) => node === page };
  const menu = { element: {}, rect: { x: 180, y: 40, width: 260, height: 400 } };
  const sheet = {};
  let over = page;
  const s = stage({ elementFromPoint: (x, y) => (x < 440 && y < 440 ? sheet : over) });
  try {
    const overlays = [menu];
    const updates = [];
    const stop = watchTabViewport(page, () => true, (update) => updates.push(update), cover(overlays));
    assert.equal(updates.at(-1).visible, true);
    overlays.length = 0;
    s.mutate();
    assert.equal(updates.at(-1).visible, false);
    overlays.push(menu);
    over = sheet;
    s.mutate();
    assert.equal(updates.at(-1).visible, false);
    over = page;
    globalThis.getComputedStyle = () => ({ display: "block", visibility: "hidden", opacity: "1" });
    s.mutate();
    assert.equal(updates.at(-1).visible, false);
    stop();
  } finally {
    s.restore();
  }
});

test("a page partly under a page stacked above it stays shown, as the source under Peek's card does; one wholly under it is hidden", () => {
  const page = { isConnected: true, parentElement: null, getBoundingClientRect: () => box(190, 50, 1241, 841), contains: (node) => node === page };
  const peekPage = { closest: (selector) => (selector === STACKED_PAGE ? peekPage : null) };
  const sheet = { closest: () => null };
  const scrim = { element: {}, rect: { x: 190, y: 9, width: 1241, height: 882 } };
  let hit = () => peekPage;
  const s = stage({ width: 1440, height: 900, elementFromPoint: (x, y) => hit(x, y) });
  try {
    const overlays = [scrim];
    const updates = [];
    const coverage = { overlayAt: (x, y) => x < 267 || x >= 1354 || y < 96 || y >= 833 ? cover(overlays).overlayAt(x, y) : false, overlayElements: () => overlays.map(({ element }) => element) };
    const stop = watchTabViewport(page, () => true, (update) => updates.push(update), coverage);
    assert.equal(updates.at(-1).visible, true, "corners under the scrim and the middle under the peek page keep the source live");
    overlays.length = 0;
    s.mutate();
    assert.equal(updates.at(-1).visible, false, "with every point under another page, the page is hidden");
    hit = (x) => (x > 600 && x < 1000 ? peekPage : sheet);
    overlays.push(scrim);
    s.mutate();
    assert.equal(updates.at(-1).visible, true);
    overlays.length = 0;
    s.mutate();
    assert.equal(updates.at(-1).visible, false, "a plain shell element over a corner still hides it");
    stop();
  } finally {
    s.restore();
  }
});

test("an open extension popup's outside-click layer over the page keeps the page shown", () => {
  const page = { isConnected: true, parentElement: null, getBoundingClientRect: () => box(190, 47, 763, 1026), contains: (node) => node === page };
  const dismiss = { contains: (node) => node === dismiss };
  let open = true;
  const s = stage({ width: 953, height: 1080, elementFromPoint: () => (open ? dismiss : {}), querySelector: (selector) => (open && selector === '[data-testid="ardia-extension-popup-dismiss"]' ? dismiss : null) });
  try {
    const updates = [];
    const stop = watchTabViewport(page, () => true, (update) => updates.push(update), cover());
    assert.equal(updates.at(-1).visible, true);
    open = false;
    s.mutate();
    assert.equal(updates.at(-1).visible, false);
    stop();
  } finally {
    s.restore();
  }
});

test("an idle page is not measured again, and an animation on an ancestor or a registered overlay is followed once per frame until it ends", async () => {
  let x = 200;
  let measured = 0;
  const page = { isConnected: true, parentElement: null, getBoundingClientRect: () => { measured++; return box(x, 47, 763, 900); }, contains: (node) => node === page };
  const card = { contains: (node) => node === card };
  let running = null;
  const s = stage({ width: 1280, height: 1000, elementFromPoint: () => page, getAnimations: () => (running ? [{ playState: "running", effect: { target: running } }] : []) });
  try {
    const updates = [];
    const stop = watchTabViewport(page, () => true, (update) => updates.push(update), cover([{ element: card, rect: { x: 0, y: 0, width: 0, height: 0 } }]));
    assert.equal(measured, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(measured, 1);
    assert.equal(s.frames.length, 0);
    for (const target of [{ contains: (node) => node === page }, card]) {
      running = target;
      document.dispatchEvent(new Event("transitionrun"));
      assert.equal(s.frames.length, 1);
      for (const next of [180, 160, 140]) {
        x = next;
        s.frames.shift()();
        assert.equal(s.frames.length, 1);
        assert.equal(updates.at(-1).rect.x, next);
      }
      running = null;
      x = 120;
      s.frames.shift()();
      assert.equal(updates.at(-1).rect.x, 120);
      assert.equal(s.frames.length, 0);
    }
    const settled = measured;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(measured, settled);
    stop();
  } finally {
    s.restore();
  }
});

test("a page rect off the window or not finite is reported hidden", () => {
  const size = { width: 1280, height: 800 };
  assert.deepEqual(tabViewport({ x: 10, y: 10, width: 100, height: 100 }, size, true), { rect: { x: 10, y: 10, width: 100, height: 100 }, visible: true });
  assert.equal(tabViewport({ x: 1300, y: 10, width: 100, height: 100 }, size, true).visible, false);
  assert.deepEqual(tabViewport({ x: Number.NaN, y: 0, width: 1, height: 1 }, size, true), { rect: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
  assert.equal(tabViewport({ x: 10, y: 10, width: 100, height: 100 }, size, false).visible, false);
});

test("while the auto-hide toolbar slides the page group, the page keeps one size from the first frame to the last", async () => {
  const { TOOLBAR_SLIDE } = await import("./hostViewport.ts");
  const { takeUpdateCounts } = await import("../../browser/src/state/telemetry/updateCounts.ts");
  const { setConsentPeriod } = await import("../../browser/src/state/telemetry/consentPeriod.ts");
  setConsentPeriod(true, "toolbar-slide-test");
  takeUpdateCounts();
  const window = { width: 1018, height: 800 };
  const pane = box(9, 60, 1000, 731);
  const room = 41 - 20;
  const hostSize = ({ rect }) => {
    const top = Math.min(Math.max(rect.y, 0), window.height);
    const bottom = Math.min(Math.max(rect.y + rect.height, top), window.height);
    return `${rect.width}x${bottom - top}`;
  };
  for (const glide of [
    { name: "hide", layout: { top: pane.top + 20, bottom: pane.bottom }, slide: (t) => room * (1 - t) },
    { name: "show", layout: { top: pane.top + 41, bottom: pane.bottom + room }, slide: (t) => -room * (1 - t) },
  ]) {
    let shift = glide.slide(0);
    const group = { matches: (selector) => selector === TOOLBAR_SLIDE, parentElement: { getBoundingClientRect: () => pane } };
    const page = {
      isConnected: true,
      parentElement: null,
      closest: (selector) => (selector === TOOLBAR_SLIDE ? group : null),
      getBoundingClientRect: () => box(pane.x, glide.layout.top + shift, pane.width, glide.layout.bottom - glide.layout.top),
      contains: (node) => node === page,
    };
    const s = stage({ ...window, elementFromPoint: () => page });
    globalThis.getComputedStyle = (node) => ({ display: "block", visibility: "visible", opacity: "1", transform: node === group ? `matrix(1, 0, 0, 1, 0, ${shift})` : "none" });
    try {
      const updates = [];
      const stop = watchTabViewport(page, () => true, (update) => updates.push(update), cover());
      for (let frame = 1; frame <= 10; frame++) {
        shift = glide.slide(frame / 10);
        s.mutate();
      }
      assert.deepEqual([...new Set(updates.map(hostSize))], [`${pane.width}x${Math.min(glide.layout.bottom, pane.bottom) - glide.layout.top}`], glide.name);
      assert.ok(updates.every((update) => update.visible), glide.name);
      assert.ok(takeUpdateCounts().toolbar_slide_frames_held > 0, `${glide.name}: the held frames are counted`);
      stop();
    } finally {
      s.restore();
    }
  }
  setConsentPeriod(false, null);
});

test("a page that stops drawing because shell UI covers it is reported once, and a page hidden any other way or sampled off the window is not", async () => {
  const { watchPageBelowShell } = await import("./shims/web/HostWebView.tsx");
  const page = { isConnected: true, parentElement: null, getBoundingClientRect: () => box(200, 50, 800, 600), contains: () => false };
  const toolbar = {};
  let hit = page;
  const s = stage({ elementFromPoint: () => hit });
  try {
    let wanted = true;
    let covered = 0;
    const regions = { setPage() {}, refresh() {}, dropPage() {}, ...cover() };
    const stop = watchPageBelowShell(page, regions, () => wanted, () => null, undefined, () => covered++);
    hit = toolbar;
    s.mutate();
    s.mutate();
    assert.equal(covered, 1);
    hit = page;
    s.mutate();
    wanted = false;
    s.mutate();
    wanted = true;
    s.mutate();
    document.hidden = true;
    s.events.document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false;
    s.events.document.dispatchEvent(new Event("visibilitychange"));
    hit = null;
    s.mutate();
    hit = page;
    s.mutate();
    page.isConnected = false;
    s.mutate();
    assert.equal(covered, 1);
    stop();
  } finally {
    s.restore();
  }
});

test("a page that only just overlaps the window's bottom edge is hidden but not counted as covered by shell UI beside it", async () => {
  const { watchPageBelowShell } = await import("./shims/web/HostWebView.tsx");
  let rect = box(200, 50, 800, 600);
  const page = { isConnected: true, parentElement: null, getBoundingClientRect: () => rect, contains: () => false };
  const shell = {};
  const s = stage({ height: 800, elementFromPoint: (x, y) => (y >= 800 ? null : y >= rect.top && y < rect.bottom ? page : shell) });
  try {
    let covered = 0;
    const hidden = [];
    const regions = { setPage: (_slot, visible) => hidden.push(!visible), refresh() {}, dropPage() {}, ...cover() };
    const stop = watchPageBelowShell(page, regions, () => true, () => null, undefined, () => covered++);
    rect = box(200, 795, 800, 600);
    s.mutate();
    assert.deepEqual(hidden, [true]);
    assert.equal(covered, 0);
    stop();
  } finally {
    s.restore();
  }
});
