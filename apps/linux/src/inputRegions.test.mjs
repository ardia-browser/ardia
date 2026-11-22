import assert from "node:assert/strict";
import test from "node:test";
import { createInputRegions, REVEAL_DEADLINE_MS, subtract } from "./inputRegions.ts";
import { holeClipPath, holesOf, localHoles, pagesAbove, paintersBeneath, PAGE_CORNER_RADIUS, separateHoles, windowCornerRadii } from "./pageHoles.ts";

function node(rect, { children = [], pointer = true } = {}) {
  const element = { rect, children, pointer, isConnected: true, parent: null };
  for (const child of children) child.parent = element;
  element.contains = (other) => {
    for (let at = other; at; at = at.parent) if (at === element) return true;
    return false;
  };
  return element;
}

function harness({ send = true, animating = false } = {}) {
  const sent = [];
  const replies = [];
  const concealed = new Set();
  const microtasks = [];
  const frames = [];
  const timers = new Map();
  const pagesSeen = [];
  const areasSeen = [];
  let frame = 0;
  let timer = 0;
  const errors = [];
  const registry = createInputRegions({
    send: send ? (regions) => {
      sent.push(regions);
      return new Promise((resolve, reject) => replies.push({ resolve, reject }));
    } : null,
    viewport: () => ({ width: 1000, height: 800 }),
    rectOf: (element) => element.rect,
    receivesPointer: (element) => element.pointer,
    watch: () => () => {},
    animating: () => animating,
    conceal: (element, hidden) => void (hidden ? concealed.add(element) : concealed.delete(element)),
    microtask: (run) => microtasks.push(run),
    frame: (run) => frames.push(run),
    frameTime: () => frame,
    timeout: (run) => {
      timers.set(++timer, run);
      return timer;
    },
    clearTimeout: (handle) => timers.delete(handle),
    pagesChanged: (pages) => {
      pagesSeen.push(pages.map((page) => page.rect));
      areasSeen.push(pages);
    },
    report: (error) => errors.push(error),
  });
  const settle = async () => {
    while (microtasks.length) microtasks.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const nextFrame = async () => {
    frame++;
    const due = frames.splice(0);
    for (const run of due) run();
    await settle();
  };
  const fireTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const run of due) run();
  };
  return { registry, sent, replies, concealed, pagesSeen, areasSeen, settle, nextFrame, fireTimers, errors };
}

const page = node({ x: 200, y: 50, width: 700, height: 700 });
const sidebarMenu = () => node({ x: 10, y: 10, width: 150, height: 200 });
const pageMenu = () => node({ x: 300, y: 100, width: 240, height: 300 });

test("rect subtraction leaves the pieces around a hole", () => {
  assert.deepEqual(subtract({ x: 0, y: 0, width: 100, height: 100 }, { x: 25, y: 25, width: 50, height: 50 }), [
    { x: 0, y: 0, width: 100, height: 25 },
    { x: 0, y: 75, width: 100, height: 25 },
    { x: 0, y: 25, width: 25, height: 50 },
    { x: 75, y: 25, width: 25, height: 50 },
  ]);
  assert.deepEqual(subtract({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }), [{ x: 0, y: 0, width: 10, height: 10 }]);
  assert.deepEqual(subtract({ x: 0, y: 0, width: 10, height: 10 }, { x: -5, y: -5, width: 30, height: 30 }), []);
});

test("page holes are rounded rects cut from the layer with the even-odd rule", () => {
  assert.equal(holeClipPath({ width: 100, height: 80 }, []), "");
  const path = holeClipPath({ width: 100, height: 80 }, [{ x: 10, y: 20, width: 50, height: 40 }]);
  assert.match(path, /^path\(evenodd, "M0 0H100V80H0Z M22 20H48A12 12 0 0 1 60 32V48A12 12 0 0 1 48 60H22A12 12 0 0 1 10 48V32A12 12 0 0 1 22 20Z"\)$/);
  assert.match(holeClipPath({ width: 100, height: 80 }, [{ x: 0, y: 0, width: 10, height: 10 }]), /A5 5 /);
  assert.deepEqual(localHoles({ x: 100, y: 50, width: 400, height: 400 }, { x: 2, y: 2 }, [{ x: 200, y: 150, width: 100, height: 100 }, { x: 900, y: 0, width: 10, height: 10 }]), [{ x: 50, y: 50, width: 50, height: 50 }]);
});

test("each hole takes its slot's own corner radii: a side panel square under its header and rounded below, a page 12 all round", () => {
  const panel = { x: 600, y: 40, width: 300, height: 500, radii: { upperLeft: 0, upperRight: 0, lowerRight: 10, lowerLeft: 10 } };
  const path = holeClipPath({ width: 1000, height: 800 }, [panel, { x: 10, y: 20, width: 50, height: 40 }]);
  assert.equal(path, 'path(evenodd, "M0 0H1000V800H0Z M600 40H900V530A10 10 0 0 1 890 540H610A10 10 0 0 1 600 530V40Z M22 20H48A12 12 0 0 1 60 32V48A12 12 0 0 1 48 60H22A12 12 0 0 1 10 48V32A12 12 0 0 1 22 20Z")');
  assert.match(holeClipPath({ width: 100, height: 100 }, [{ x: 0, y: 0, width: 8, height: 40, radii: { upperLeft: 30, upperRight: 0, lowerRight: 0, lowerLeft: 0 } }]), /M4 0H8V40H0V4A4 4 0 0 1 4 0Z/);
  assert.deepEqual(localHoles({ x: 100, y: 0, width: 1000, height: 800 }, { x: 2, y: 2 }, [panel]), [{ x: 250, y: 20, width: 150, height: 250, radii: { upperLeft: 0, upperRight: 0, lowerRight: 5, lowerLeft: 5 } }]);
});

test("a slot registered with its corner radii hands them to the hole painter, which repaints when they change", async () => {
  const h = harness({ send: false });
  let radii = { upperLeft: 0, upperRight: 0, lowerRight: 10, lowerLeft: 10 };
  const panel = node({ x: 600, y: 40, width: 300, height: 500 });
  const corners = () => radii;
  h.registry.setPage(page, true);
  h.registry.setPage(panel, true, corners);
  await h.settle();
  assert.deepEqual(h.areasSeen.at(-1).map((area) => area.radii ?? null), [null, radii]);
  const seen = h.areasSeen.length;
  h.registry.setPage(panel, true, corners);
  h.registry.refresh();
  await h.settle();
  assert.equal(h.areasSeen.length, seen);
  radii = { ...radii, lowerRight: 0 };
  h.registry.refresh();
  await h.settle();
  assert.equal(h.areasSeen.length, seen + 1);
  assert.deepEqual(h.areasSeen.at(-1)[1].radii, radii);
});

test("a tab swapped for another in the same place reaches the hole painter, so the new slot's own backgrounds open", async () => {
  const h = harness({ send: false });
  const first = node({ x: 200, y: 50, width: 700, height: 700 });
  const second = node({ x: 200, y: 50, width: 700, height: 700 });
  h.registry.setPage(first, true);
  await h.settle();
  const seen = h.areasSeen.length;
  h.registry.setPage(second, true);
  h.registry.setPage(first, false);
  await h.settle();
  assert.equal(h.areasSeen.length, seen + 1);
  assert.equal(h.areasSeen.at(-1)[0].slot, second);
});

test("without the host capability nothing is sent or hidden, but page areas still reach the hole painter", async () => {
  const h = harness({ send: false });
  h.registry.setPage(page, true);
  const stop = h.registry.addOverlay(pageMenu());
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.concealed.size, 0);
  assert.deepEqual(h.pagesSeen, [[page.rect]]);
  assert.equal(h.registry.overlayAt(310, 110), true);
  stop();
});

test("an overlay over a page stays hidden until the send that includes it resolves", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  await h.settle();
  h.replies.shift().resolve();
  await h.settle();
  const menu = pageMenu();
  h.registry.addOverlay(menu);
  assert.equal(h.sent.length, 1, "the region is sent from the mount microtask, not a later frame");
  await h.settle();
  assert.equal(h.concealed.has(menu), true);
  assert.deepEqual(h.sent.at(-1), { pages: [page.rect], overlays: [menu.rect] });
  h.replies.shift().resolve();
  await h.settle();
  assert.equal(h.concealed.has(menu), false);
});

test("an overlay away from pages is sent but never hidden", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  const menu = sidebarMenu();
  h.registry.addOverlay(menu);
  await h.settle();
  assert.equal(h.concealed.size, 0);
  assert.deepEqual(h.sent.at(-1).overlays, [menu.rect]);
});

test("the reveal deadline shows an overlay whose send never resolves, and a failed send shows it at once", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  const menu = pageMenu();
  h.registry.addOverlay(menu);
  await h.settle();
  assert.equal(h.concealed.has(menu), true);
  h.fireTimers();
  assert.equal(h.concealed.has(menu), false);
  assert.ok(REVEAL_DEADLINE_MS <= 200);

  const failing = harness();
  failing.registry.setPage(page, true);
  const other = pageMenu();
  failing.registry.addOverlay(other);
  await failing.settle();
  failing.replies.shift().reject(Object.assign(new Error("unknown"), { code: "ERR_UNKNOWN_CALL" }));
  await failing.settle();
  assert.equal(failing.concealed.has(other), false);
  assert.equal(failing.errors.length, 1);
});

test("sends coalesce to one in flight, and a closed overlay is released by the next send", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  const first = sidebarMenu();
  const stopFirst = h.registry.addOverlay(first);
  await h.settle();
  assert.equal(h.sent.length, 1);
  await h.nextFrame();
  first.rect = { ...first.rect, x: 20 };
  h.registry.refresh();
  await h.settle();
  first.rect = { ...first.rect, x: 30 };
  h.registry.refresh();
  await h.settle();
  assert.equal(h.sent.length, 1, "later regions wait for the one in flight");
  h.replies.shift().resolve();
  await h.settle();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].overlays[0].x, 30, "only the latest queued regions go out");
  h.replies.shift().resolve();
  await h.nextFrame();
  stopFirst();
  await h.settle();
  assert.deepEqual(h.sent.at(-1), { pages: [page.rect], overlays: [] });
  h.replies.shift().resolve();
  await h.nextFrame();
  h.registry.refresh();
  await h.settle();
  assert.equal(h.sent.length, 3, "unchanged regions are not sent again");
});

test("an ordinary change sends at most once per frame; a new overlay over a page goes out at once", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  await h.settle();
  h.replies.shift().resolve();
  await h.settle();
  const side = sidebarMenu();
  h.registry.addOverlay(side);
  await h.settle();
  assert.equal(h.sent.length, 1, "same frame as the page send: deferred");
  await h.nextFrame();
  assert.equal(h.sent.length, 2);
  h.replies.shift().resolve();
  await h.settle();
  h.registry.addOverlay(pageMenu());
  await h.settle();
  assert.equal(h.sent.length, 3);
});

test("a page an overlay hosts is cut out of the overlay, and hit shapes take the boxes that receive the pointer", async () => {
  const h = harness();
  const peekPage = node({ x: 300, y: 100, width: 400, height: 500 });
  const peek = node({ x: 250, y: 60, width: 500, height: 600 }, { children: [peekPage] });
  h.registry.setPage(page, true);
  h.registry.setPage(peekPage, true);
  h.registry.addOverlay(peek);
  const card = node({ x: 20, y: 300, width: 260, height: 90 });
  const wrapper = node({ x: 0, y: 0, width: 1000, height: 800 }, { pointer: false, children: [node({ x: 0, y: 0, width: 1000, height: 800 }, { pointer: false, children: [card] })] });
  h.registry.addOverlay(wrapper, "hit");
  await h.settle();
  const { overlays } = h.sent.at(-1);
  assert.ok(overlays.every((rect) => !(rect.x < 700 && rect.x + rect.width > 300 && rect.y < 600 && rect.y + rect.height > 100)), "the peek's own page stays page input");
  assert.equal(overlays.reduce((sum, rect) => sum + rect.width * rect.height, 0), 500 * 600 - 400 * 500 + 260 * 90);
  assert.deepEqual(overlays.at(-1), card.rect);
  assert.equal(h.registry.overlayAt(500, 300), false);
  assert.equal(h.registry.overlayAt(260, 70), true);
});

test("hidden pages leave the page list, and an overlay already shown stays shown when it moves over a page", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  const menu = pageMenu();
  h.registry.addOverlay(menu);
  await h.settle();
  h.replies.shift().resolve();
  await h.nextFrame();
  assert.equal(h.concealed.has(menu), false);
  menu.rect = { ...menu.rect, x: menu.rect.x - 6, width: menu.rect.width + 12 };
  h.registry.refresh();
  await h.settle();
  assert.equal(h.concealed.has(menu), false, "a scale-in growth stays shown");
  h.replies.shift()?.resolve();
  await h.nextFrame();
  menu.rect = { ...menu.rect, x: 600 };
  h.registry.refresh();
  await h.settle();
  assert.equal(h.concealed.has(menu), false, "a jump onto unreserved page area keeps a shown overlay on screen");
  assert.deepEqual(h.sent.at(-1).overlays, [menu.rect], "and its new region goes out at once");
  h.registry.setPage(page, false);
  await h.settle();
  while (h.replies.length) {
    h.replies.shift().resolve();
    await h.nextFrame();
  }
  assert.deepEqual(h.sent.at(-1).pages, []);
});

test("an overlay moved by its parent keeps being measured each frame until it settles, and overlayAt reads where it is now", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  const peek = node({ x: -197, y: 0, width: 190, height: 800 });
  h.registry.addOverlay(peek);
  await h.settle();
  await h.nextFrame();
  peek.rect = { x: -150, y: 0, width: 140, height: 800 };
  assert.equal(h.registry.overlayAt(25, 66), false);
  peek.rect = { x: 0, y: 0, width: 230, height: 800 };
  assert.equal(h.registry.overlayAt(25, 66), true);
  for (let frame = 0; frame < 4; frame++) {
    for (const reply of h.replies.splice(0)) reply.resolve();
    await h.settle();
    await h.nextFrame();
  }
  assert.deepEqual(h.sent.at(-1).overlays, [{ x: 0, y: 0, width: 230, height: 800 }]);
});

test("an ungated overlay over a page is never hidden but still sends its region at once", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  await h.settle();
  await h.nextFrame();
  for (const reply of h.replies.splice(0)) reply.resolve();
  await h.settle();
  const panel = pageMenu();
  h.registry.addOverlay(panel, "box", false);
  await h.settle();
  assert.equal(h.concealed.has(panel), false);
  assert.deepEqual(h.sent.at(-1).overlays, [{ x: 300, y: 100, width: 240, height: 300 }]);
});

test("an overlay already on screen whose hit boxes start taking the pointer over a page is sent at once and never hidden", async () => {
  const h = harness();
  h.registry.setPage(page, true);
  await h.settle();
  h.replies.shift().resolve();
  await h.settle();
  const card = node({ x: 220, y: 60, width: 264, height: 110 }, { pointer: false });
  const wrapper = node({ x: 0, y: 0, width: 1000, height: 800 }, { children: [card], pointer: false });
  h.registry.addOverlay(wrapper, "hit");
  await h.settle();
  assert.equal(h.concealed.size, 0, "a fading-in card with no hit boxes is shown");
  card.pointer = true;
  h.registry.refresh();
  await h.settle();
  assert.deepEqual(h.sent.at(-1).overlays, [card.rect], "its boxes go out from the same microtask");
  assert.equal(h.concealed.has(wrapper), false, "a card already on screen is not hidden while its send is in flight");
  h.replies.shift().resolve();
  await h.nextFrame();
  assert.equal(h.concealed.size, 0);
});

function peekTree() {
  const order = ["window", "card", "sourceSlot", "peek", "scrim", "peekCard", "panel", "peekBar", "peekBody", "peekSlot", "peekPopovers"];
  const parent = { card: "window", sourceSlot: "card", peek: "card", scrim: "peek", peekCard: "peek", panel: "peekCard", peekBar: "peekCard", peekBody: "peekCard", peekSlot: "peekBody", peekPopovers: "peekBody" };
  const rects = {
    window: [0, 0, 1440, 900], card: [190, 9, 1241, 882], sourceSlot: [190, 50, 1241, 841], peek: [190, 9, 1241, 882], scrim: [190, 9, 1241, 882],
    peekCard: [258, 58, 1105, 784], panel: [258, 58, 1105, 784], peekBar: [258, 58, 1105, 38], peekBody: [267, 96, 1087, 737], peekSlot: [267, 96, 1087, 737], peekPopovers: [267, 96, 1087, 737],
  };
  const painting = new Set(["window", "card", "scrim", "panel", "peekBody", "peekPopovers"]);
  const contains = (outer, inner) => {
    for (let node = inner; node; node = parent[node]) if (node === outer) return true;
    return false;
  };
  const overlaps = (a, b) => {
    const [ax, ay, aw, ah] = rects[a];
    const [bx, by, bw, bh] = rects[b];
    return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
  };
  const stackOf = (node) => (contains("peek", node) ? "peek" : null);
  return { order, stack: { stackOf, contains }, painter: { contains, overlaps, precedes: (a, b) => order.indexOf(a) < order.indexOf(b), paints: (node) => painting.has(node) } };
}

test("inside Peek, the scrim and the card's panel are cut where the peek page shows; popovers after the page and the page's ancestors are not", () => {
  const tree = peekTree();
  const inPeek = tree.order.filter((node) => tree.stack.contains("peek", node) && node !== "peek");
  assert.deepEqual(paintersBeneath("peekSlot", inPeek, tree.painter), ["scrim", "panel"]);
});

test("a page below Peek doesn't cut Peek's own surfaces, and Peek's page still cuts what lies under the whole stack", () => {
  const tree = peekTree();
  const pages = [{ slot: "sourceSlot" }, { slot: "peekSlot" }];
  assert.deepEqual(pagesAbove("panel", pages, tree.stack), [{ slot: "peekSlot" }]);
  assert.deepEqual(pagesAbove("scrim", pages, tree.stack), [{ slot: "peekSlot" }]);
  assert.deepEqual(pagesAbove("card", pages, tree.stack), pages);
  assert.deepEqual(pagesAbove("window", [{ slot: "sourceSlot" }], tree.stack), [{ slot: "sourceSlot" }]);
});

test("a page inside another page's hole adds no hole of its own, so the even-odd rule can't paint the shell back over it", () => {
  const source = { x: 190, y: 50, width: 1241, height: 841 };
  const peek = { x: 267, y: 96, width: 1087, height: 737 };
  assert.deepEqual(separateHoles([source, peek]), { holes: [source], pieces: [] });
  const side = { x: 900, y: 50, width: 531, height: 841 };
  const left = { x: 190, y: 50, width: 700, height: 841 };
  assert.deepEqual(separateHoles([left, side]), { holes: [left, side], pieces: [] });
  const pane = { x: 190, y: 50, width: 600, height: 841 };
  const split = separateHoles([pane, peek]);
  assert.deepEqual(split.holes, [pane]);
  assert.deepEqual(split.pieces, [{ rect: { x: 790, y: 96, width: 564, height: 737 }, radii: [0, 12, 12, 0] }]);
});

test("a page hole is square where it meets a window corner and keeps the card radius elsewhere", () => {
  const window = { width: 1920, height: 1080 };
  const square = { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 };
  const card = { upperLeft: PAGE_CORNER_RADIUS, upperRight: PAGE_CORNER_RADIUS, lowerRight: PAGE_CORNER_RADIUS, lowerLeft: PAGE_CORNER_RADIUS };
  assert.deepEqual(windowCornerRadii({ x: 0, y: 0, width: 1920, height: 1080 }, window), square);
  assert.deepEqual(windowCornerRadii({ x: 0.3, y: -2, width: 1920.4, height: 1082 }, window), square);
  assert.deepEqual(windowCornerRadii({ x: 8, y: 8, width: 1904, height: 1064 }, window), card);
  assert.deepEqual(windowCornerRadii({ x: 240, y: 0, width: 1680, height: 1080 }, window), { ...card, upperRight: 0, lowerRight: 0 });
  assert.deepEqual(windowCornerRadii({ x: 240, y: 40, width: 1680, height: 1040 }, window), { ...card, lowerRight: 0 });
  const slot = {};
  const own = { upperLeft: 4, upperRight: 4, lowerRight: 4, lowerLeft: 4 };
  assert.deepEqual(holesOf([{ slot, rect: { x: 0, y: 0, width: 1920, height: 1080 } }, { slot, rect: { x: 0, y: 0, width: 1920, height: 1080 }, radii: own }], window),
    [{ x: 0, y: 0, width: 1920, height: 1080, radii: square }, { x: 0, y: 0, width: 1920, height: 1080, radii: own }]);
  const fullScreen = holeClipPath(window, holesOf([{ slot, rect: { x: 0, y: 0, width: 1920, height: 1080 } }], window));
  assert.equal(fullScreen, 'path(evenodd, "M0 0H1920V1080H0Z M0 0H1920V1080H0V0Z")');
  assert.doesNotMatch(fullScreen, /A/);
});

test("the shell cuts the same corners the engine clips, at fractional edges, any zoom, window widths that don't divide by it, and a rounded window", () => {
  const engineRadius = (insetX, insetY, windowRadius, own) => {
    if (insetX < 1 && insetY < 1) return { kind: "window", dip: windowRadius };
    if (insetX < windowRadius && insetY < windowRadius) {
      const concentric = windowRadius - (insetX < insetY ? insetX : insetY);
      return { kind: "near", dip: concentric > own ? concentric : own };
    }
    return { kind: "own", dip: own };
  };
  const engineCorners = (rect, widthDip, heightDip, zoom, windowRadius) => {
    const left = Math.min(Math.max(rect.x * zoom, 0), widthDip);
    const top = Math.min(Math.max(rect.y * zoom, 0), heightDip);
    const right = Math.min(Math.max((rect.x + rect.width) * zoom, left), widthDip);
    const bottom = Math.min(Math.max((rect.y + rect.height) * zoom, top), heightDip);
    const insets = { l: Math.floor(left), t: Math.floor(top), r: widthDip - Math.ceil(right), b: heightDip - Math.ceil(bottom) };
    return [engineRadius(insets.l, insets.t, windowRadius, 12), engineRadius(insets.r, insets.t, windowRadius, 12), engineRadius(insets.r, insets.b, windowRadius, 12), engineRadius(insets.l, insets.b, windowRadius, 12)];
  };
  const shellExpects = (corner, zoom) => (corner.kind === "window" ? 0 : corner.kind === "near" ? corner.dip / zoom : 12);
  let checked = 0;
  for (const [widthDip, heightDip] of [[800, 600], [1000, 700], [1001, 667], [997, 613]]) {
    for (const zoom of [0.5, 0.8, 1, 1.25, 2, 2.5, 3]) {
      const window = { width: widthDip / zoom, height: heightDip / zoom };
      for (const windowRadius of [0, 12, 19, 24]) {
        const frame = { upperLeft: windowRadius, upperRight: windowRadius, lowerRight: windowRadius, lowerLeft: windowRadius };
        for (const edge of [0, 0.2, 0.3, 0.4, 0.5, 0.75, 0.99, 1, 1.2, 2, 3, 8, 25]) {
          const css = edge / zoom;
          const rect = { x: css, y: css, width: window.width - 2 * css, height: window.height - 2 * css };
          const engine = engineCorners(rect, widthDip, heightDip, zoom, windowRadius);
          const shell = windowCornerRadii(rect, window, 12, zoom, frame);
          const got = [shell.upperLeft, shell.upperRight, shell.lowerRight, shell.lowerLeft];
          engine.forEach((corner, index) => assert.ok(Math.abs(got[index] - shellExpects(corner, zoom)) < 1e-9, `corner ${index} at ${edge} DIP, zoom ${zoom}, ${widthDip}x${heightDip}, radius ${windowRadius}: ${got[index]} vs ${JSON.stringify(corner)}`));
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000);
  const ring = (radius) => ({ upperLeft: radius, upperRight: radius, lowerRight: radius, lowerLeft: radius });
  const atThreeHundred = windowCornerRadii({ x: 1 / 3, y: 1 / 3, width: 1000 / 3 - 2 / 3, height: 700 / 3 - 2 / 3 }, { width: 1000 / 3, height: 700 / 3 }, 12, 3, ring(24));
  assert.ok(Math.abs(atThreeHundred.upperLeft * 3 - 23) < 1e-9, "the hole is the engine's 23 DIP at 300 %, not 36");
  const atHalf = windowCornerRadii({ x: 16, y: 16, width: 1600 - 32, height: 1200 - 32 }, { width: 1600, height: 1200 }, 12, 0.5, ring(19));
  assert.equal(atHalf.upperLeft * 0.5, 12, "the hole is the engine's 12 DIP at 50 %, not 11");
  const third = { width: 1000 / 3, height: 700 / 3 };
  assert.equal(windowCornerRadii({ x: 0, y: 0, width: 998.25 / 3, height: 700 / 3 }, third, 12, 3).upperRight, 12, "998.25 of 1000 DIP is inset, as the engine says");
  for (const windowRadius of [12, 19, 24]) {
    const frame = { upperLeft: windowRadius, upperRight: windowRadius, lowerRight: windowRadius, lowerLeft: windowRadius };
    for (const inset of [0, 1, 2, 3, 8]) {
      const radii = windowCornerRadii({ x: inset, y: inset, width: 800 - 2 * inset, height: 600 - 2 * inset }, { width: 800, height: 600 }, 12, 1, frame);
      assert.equal(radii.upperLeft, inset === 0 ? 0 : inset < windowRadius ? Math.max(12, windowRadius - inset) : 12, `inset ${inset} at radius ${windowRadius}`);
    }
  }
});
