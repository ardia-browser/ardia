import assert from "node:assert/strict";
import test from "node:test";
import { AFTERIMAGE_MS, GLASS_MAX_REGIONS, STABLE_FRAMES, createGlassRegions, offPagePieces } from "./glassRegions.ts";

const RADII = { upperLeft: 10, upperRight: 10, lowerRight: 10, lowerLeft: 10 };
const PAGE = { x: 0, y: 0, width: 1000, height: 800 };

function node(geometry, parent = null) {
  const element = { geometry, parent, attributes: {} };
  element.contains = (other) => {
    for (let at = other; at; at = at.parent) if (at === element) return true;
    return false;
  };
  return element;
}

function harness({ available = true, send = true, behindWindow = false } = {}) {
  const holes = [];
  const sent = [];
  const replies = [];
  const frames = [];
  const timers = new Map();
  const ghosts = [];
  let timer = 0;
  const errors = [];
  const running = new Set();
  const availability = [];
  const glass = createGlassRegions(
    {
      send: send ? (update) => {
        sent.push(update);
        return new Promise((resolve, reject) => replies.push({ update, resolve, reject }));
      } : null,
      measure: (element) => element.geometry,
      apply: (element, translucent) => void (element.attributes.glass = translucent ? "on" : "off"),
      afterimage: (element, geometry) => {
        const ghost = { element, geometry, removed: false };
        ghosts.push(ghost);
        return () => void (ghost.removed = true);
      },
      watch: () => () => {},
      animating: (element) => [...running].some((target) => target.contains(element)),
      frame: (run) => frames.push(run),
      timeout: (run, ms) => {
        timers.set(++timer, { run, ms });
        return timer;
      },
      clearTimeout: (handle) => timers.delete(handle),
      report: (error) => errors.push(error),
      availability: (value) => availability.push(value),
      holes: (next) => holes.push(next),
    },
    available,
    { behindWindow },
  );
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      const pending = frames.splice(0);
      for (const run of pending) run();
    }
  };
  const settle = () => new Promise(setImmediate);
  const accept = async (index = replies.length - 1, ids) => {
    const { update, resolve } = replies[index];
    resolve({ generation: update.generation, available: true, accepted: ids ?? update.regions.map((region) => region.id) });
    await settle();
  };
  return { glass, sent, replies, frames, tick, settle, accept, timers, ghosts, errors, running, availability, holes };
}

const menu = (x = 100) => ({ rect: { x, y: 100, width: 240, height: 160 }, radii: RADII, opacity: 1 });

test("a panel turns translucent only once its region for the current stable geometry is applied and presented", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  h.glass.add(panel);
  assert.equal(panel.attributes.glass, "off");
  h.tick(STABLE_FRAMES + 1);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].regions.map((r) => [r.rect, r.radii, r.blur, r.opacity]), [[menu().rect, RADII, 24, 1]]);
  assert.equal(panel.attributes.glass, "off");
  await h.accept();
  assert.equal(panel.attributes.glass, "off", "applied is not presented");
  h.glass.presented(h.sent[0].generation);
  assert.equal(panel.attributes.glass, "on");
});

test("a move turns the panel opaque at once and it stays opaque until the new geometry is presented", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent[0].generation);
  assert.equal(panel.attributes.glass, "on");
  panel.geometry = menu(140);
  h.glass.refresh();
  h.tick();
  assert.equal(panel.attributes.glass, "off");
  assert.equal(h.sent.length, 2);
  await h.accept();
  h.glass.presented(h.sent[1].generation);
  assert.equal(panel.attributes.glass, "off", "not stable yet");
  h.tick(STABLE_FRAMES);
  assert.equal(panel.attributes.glass, "on");
  h.glass.motion(panel);
  assert.equal(panel.attributes.glass, "off", "an animation starting on it turns it opaque before it moves");
});

test("an old presentation never reveals a newer geometry, and rejection or no presentation keeps it opaque", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  const first = h.sent[0].generation;
  panel.geometry = menu(150);
  h.glass.refresh();
  h.tick();
  await h.accept(0);
  h.glass.presented(first);
  h.tick(STABLE_FRAMES);
  assert.equal(panel.attributes.glass, "off");
  h.replies[1].reject(new Error("refused"));
  await h.settle();
  h.tick(STABLE_FRAMES);
  assert.equal(panel.attributes.glass, "off");
  assert.equal(h.errors.length, 1);
});

test("panels over no page, hidden, fully transparent, nested, refused or beyond the limit stay opaque", async () => {
  const h = harness();
  h.glass.setPages([{ x: 400, y: 0, width: 600, height: 800 }]);
  const off = node({ rect: { x: 0, y: 0, width: 200, height: 100 }, radii: RADII, opacity: 1 });
  const hidden = node(null);
  const faded = node({ ...menu(500), opacity: 0 });
  const outer = node(menu(500));
  const inner = node(menu(520), outer);
  const refused = node(menu(600));
  for (const element of [off, hidden, faded, outer, inner, refused]) h.glass.add(element);
  h.tick(STABLE_FRAMES + 1);
  assert.equal(h.sent.at(-1).regions.length, 2);
  const [outerId, refusedId] = h.sent.at(-1).regions.map((r) => r.id);
  await h.accept(h.replies.length - 1, [outerId]);
  h.glass.presented(h.sent.at(-1).generation);
  assert.deepEqual([off, hidden, faded, outer, inner, refused].map((e) => e.attributes.glass), ["off", "off", "off", "on", "off", "off"]);
  assert.ok(refusedId);
  const many = harness();
  many.glass.setPages([PAGE]);
  for (let i = 0; i < GLASS_MAX_REGIONS + 3; i++) many.glass.add(node({ rect: { x: i, y: 0, width: 5, height: 5 }, radii: RADII, opacity: 1 }));
  many.tick(STABLE_FRAMES + 1);
  assert.equal(many.sent.at(-1).regions.length, GLASS_MAX_REGIONS);
});

test("static ancestor opacity is sent, and an opacity change is a geometry change", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node({ ...menu(), opacity: 0.5 });
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  assert.equal(h.sent[0].regions[0].opacity, 0.5);
  await h.accept();
  h.glass.presented(h.sent[0].generation);
  assert.equal(panel.attributes.glass, "on");
  panel.geometry = { ...menu(), opacity: 0.9 };
  h.glass.refresh();
  h.tick();
  assert.equal(panel.attributes.glass, "off");
});

test("a translucent panel that disappears leaves an afterimage until its removal is presented or a deadline passes", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  const remove = h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent[0].generation);
  remove();
  assert.equal(h.ghosts.length, 1);
  h.tick();
  assert.equal(h.sent.at(-1).regions.length, 0);
  await h.accept();
  assert.equal(h.ghosts[0].removed, false);
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(h.ghosts[0].removed, true);
  const other = node(menu());
  h.glass.add(other);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent.at(-1).generation);
  other.geometry = null;
  h.glass.refresh();
  h.tick();
  assert.equal(h.ghosts.length, 2);
  const deadline = [...h.timers.values()].find((t) => t.ms === AFTERIMAGE_MS);
  deadline.run();
  assert.equal(h.ghosts[1].removed, true);
});

test("losing availability turns panels opaque; without the capability nothing is sent", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent[0].generation);
  assert.equal(panel.attributes.glass, "on");
  h.glass.setAvailable(false);
  assert.equal(panel.attributes.glass, "off");
  const off = harness({ available: false });
  off.glass.setPages([PAGE]);
  const quiet = node(menu());
  off.glass.add(quiet);
  off.tick(STABLE_FRAMES + 1);
  assert.equal(off.sent.length, 0);
  assert.equal(quiet.attributes.glass, "off");
});

async function shown(h, panel) {
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(panel.attributes.glass, "on");
}

test("a region that leaves the submitted set loses its acceptance, so coming back waits for a new ack and presentation", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  await shown(h, panel);
  h.glass.setPages([{ x: 600, y: 0, width: 400, height: 800 }]);
  h.tick();
  assert.equal(h.sent.at(-1).regions.length, 0);
  assert.equal(panel.attributes.glass, "off");
  await h.accept();
  h.glass.presented(h.sent.at(-1).generation);
  h.glass.setPages([PAGE]);
  h.tick(STABLE_FRAMES + 1);
  assert.equal(h.sent.at(-1).regions.length, 1);
  assert.equal(panel.attributes.glass, "off", "the old acceptance is gone");
  await h.accept();
  assert.equal(panel.attributes.glass, "off", "acked but not presented");
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(panel.attributes.glass, "on");
});

test("a running animation on the panel or an ancestor keeps it opaque; one inside it does not", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const wrapper = node(null);
  const panel = node(menu(), wrapper);
  const spinner = node(null, panel);
  h.running.add(wrapper);
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent.at(-1).generation);
  h.tick(STABLE_FRAMES + 3);
  assert.equal(panel.attributes.glass, "off", "unchanged frames are not enough while an ancestor animates");
  assert.ok(h.frames.length > 0, "it keeps checking while the animation runs");
  h.running.delete(wrapper);
  h.running.add(spinner);
  h.tick(STABLE_FRAMES + 1);
  assert.equal(panel.attributes.glass, "on");
  h.running.add(panel);
  h.glass.refresh();
  h.tick();
  assert.equal(panel.attributes.glass, "off");
});

test("a presentation newer than anything this registry sent is ignored", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  h.glass.presented(50);
  assert.equal(h.glass.status().presented, 0);
  const panel = node(menu());
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  assert.equal(panel.attributes.glass, "off");
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(panel.attributes.glass, "on");
});

test("a panel accepted after a refusal, at the same geometry, waits for its own presentation", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  h.glass.add(panel);
  h.tick(STABLE_FRAMES + 1);
  await h.accept(0, []);
  h.glass.presented(h.sent[0].generation);
  h.tick(3);
  assert.equal(h.sent.length, 1);
  assert.equal(panel.attributes.glass, "off");
  h.glass.add(node(menu(400)));
  h.tick();
  assert.equal(h.sent.length, 2);
  await h.accept();
  assert.equal(panel.attributes.glass, "off", "the old refusal can't stand in for a presentation");
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(panel.attributes.glass, "on");
});

test("availability changes are announced so panels mounted while glass was off can register", () => {
  const h = harness({ available: false });
  h.glass.setAvailable(true);
  h.glass.setAvailable(true);
  h.glass.setAvailable(false);
  assert.deepEqual(h.availability, [true, false]);
});

test("a panel pushed past the limit turns opaque in the same flush that drops its region", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const early = node(null);
  h.glass.add(early);
  const panels = [];
  for (let i = 0; i < GLASS_MAX_REGIONS; i++) {
    const panel = node({ rect: { x: i * 10, y: 0, width: 5, height: 5 }, radii: RADII, opacity: 1 });
    panels.push(panel);
    h.glass.add(panel);
  }
  const late = panels.at(-1);
  h.tick(STABLE_FRAMES + 1);
  await h.accept();
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(late.attributes.glass, "on");
  early.geometry = menu();
  h.glass.flushNow();
  const regions = h.sent.at(-1).regions;
  assert.equal(regions.length, GLASS_MAX_REGIONS);
  assert.ok(!regions.some((r) => r.rect.x === late.geometry.rect.x), "the last panel is past the limit");
  assert.equal(late.attributes.glass, "off", "opaque before its native backdrop can go");
});

test("transitions and animations inside a panel don't count as its motion", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(menu());
  const row = node(null, panel);
  await shown(h, panel);
  h.glass.motion(row);
  assert.equal(panel.attributes.glass, "on");
  assert.equal(h.glass.status().panels[0].stable, STABLE_FRAMES);
  const wrapper = node(null);
  panel.parent = wrapper;
  h.glass.motion(wrapper);
  assert.equal(panel.attributes.glass, "off", "an ancestor starting to move does");
});

test("a translucent panel stays translucent while other panels' regions come and go, as a submenu does", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const menuPanel = node(menu());
  await shown(h, menuPanel);
  const states = [];
  const record = () => states.push(menuPanel.attributes.glass);
  const submenu = node(menu(360));
  const remove = h.glass.add(submenu);
  for (let i = 0; i <= STABLE_FRAMES; i++) {
    h.tick();
    record();
  }
  await h.accept();
  record();
  assert.equal(submenu.attributes.glass, "off", "the new submenu waits for its own presentation");
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(submenu.attributes.glass, "on");
  remove();
  h.tick();
  record();
  await h.accept();
  record();
  h.glass.presented(h.sent.at(-1).generation);
  record();
  assert.deepEqual([...new Set(states)], ["on"]);
});

test("a device scale change is a geometry change", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node({ ...menu(), scale: 1 });
  await shown(h, panel);
  panel.geometry = { ...menu(), scale: 1.5 };
  h.glass.refresh();
  h.tick();
  assert.equal(panel.attributes.glass, "off");
  h.tick(STABLE_FRAMES);
  await h.accept();
  assert.equal(panel.attributes.glass, "off", "the rescaled region waits for its presentation");
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(panel.attributes.glass, "on");
});

test("with behind-window glass a panel over the sidebar, toolbar or empty space is sent and turns translucent", async () => {
  const h = harness({ behindWindow: true });
  h.glass.setPages([PAGE]);
  const sidebar = node({ rect: { x: 1010, y: 20, width: 120, height: 40 }, radii: RADII, opacity: 1 });
  h.glass.add(sidebar);
  h.tick(STABLE_FRAMES + 1);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].regions.map((region) => region.rect), [sidebar.geometry.rect]);
  await h.accept();
  h.glass.presented(h.sent[0].generation);
  assert.equal(sidebar.attributes.glass, "on");
  assert.equal(h.glass.behindWindow(), true);
});

test("without behind-window glass a panel over no page still stays opaque", () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const sidebar = node({ rect: { x: 1010, y: 20, width: 120, height: 40 }, radii: RADII, opacity: 1 });
  h.glass.add(sidebar);
  h.tick(STABLE_FRAMES + 1);
  assert.deepEqual(h.sent.flatMap((update) => update.regions), []);
  assert.equal(sidebar.attributes.glass, "off");
  assert.equal(h.glass.behindWindow(), false);
});

test("a panel's look travels with its region and a restyle resends without dropping the glass", async () => {
  const h = harness({ behindWindow: true });
  const pin = node(menu());
  h.glass.add(pin, undefined, { material: "clear", tint: "rgba(255,255,255,0.2)", group: "group-r1", appearance: "dark", ignored: true });
  h.tick(STABLE_FRAMES + 1);
  assert.deepEqual(
    h.sent[0].regions.map(({ material, tint, group, appearance, ignored }) => ({ material, tint, group, appearance, ignored })),
    [{ material: "clear", tint: "rgba(255,255,255,0.2)", group: "group-r1", appearance: "dark", ignored: undefined }],
  );
  await h.accept();
  h.glass.presented(h.sent[0].generation);
  assert.equal(pin.attributes.glass, "on");
  h.glass.restyle(pin, { material: "clear", tint: "rgba(0,0,0,0.1)", group: "group-r1", appearance: "dark" });
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].regions[0].tint, "rgba(0,0,0,0.1)");
  assert.equal(pin.attributes.glass, "on");
  h.glass.restyle(pin, { material: "clear", tint: "rgba(0,0,0,0.1)", group: "group-r1", appearance: "dark" });
  h.tick();
  assert.equal(h.sent.length, 2);
});

test("a panel without a look sends only its geometry", () => {
  const h = harness({ behindWindow: true });
  h.glass.add(node(menu()));
  h.tick(STABLE_FRAMES + 1);
  assert.deepEqual(Object.keys(h.sent[0].regions[0]).sort(), ["blur", "id", "opacity", "radii", "rect"]);
});

test("native behind-window glass publishes holes only while it is presented and off every page", async () => {
  const h = harness({ behindWindow: true });
  const pill = node(menu(1200));
  const remove = h.glass.add(pill);
  h.tick(STABLE_FRAMES + 2);
  await h.accept();
  assert.deepEqual(h.holes.at(-1) ?? [], []);
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(pill.attributes.glass, "on");
  assert.deepEqual(h.holes.at(-1), [{ slot: pill, rect: menu(1200).rect, radii: RADII }]);
  h.glass.setPages([{ x: 1100, y: 0, width: 600, height: 800 }]);
  assert.deepEqual(h.holes.at(-1), []);
  h.glass.setPages([]);
  assert.equal(h.holes.at(-1).length, 1);
  const count = h.holes.length;
  h.glass.setPages([]);
  assert.equal(h.holes.length, count, "unchanged holes are not republished");
  remove();
  assert.deepEqual(h.holes.at(-1), []);
});

test("a pill that straddles a page edge keeps the hole for the slice AppKit mounts behind the window", () => {
  const rect = { x: 200, y: 100, width: 100, height: 40 };
  const pieces = offPagePieces(rect, RADII, [{ x: 250, y: 0, width: 800, height: 800 }]);
  assert.deepEqual(pieces, [{ rect: { x: 200, y: 100, width: 50, height: 40 }, radii: { upperLeft: 10, upperRight: 0, lowerRight: 0, lowerLeft: 10 } }]);
  assert.deepEqual(offPagePieces(rect, RADII, []), [{ rect, radii: RADII }]);
  assert.deepEqual(offPagePieces(rect, RADII, [{ x: 0, y: 0, width: 1000, height: 800 }]), []);
});

test("a scrolling glass region leaves AppKit until it settles, then comes back", async () => {
  const h = harness({ behindWindow: true });
  const scroller = node(null);
  const pill = node(menu(1200), scroller);
  h.glass.add(pill);
  h.tick(STABLE_FRAMES + 2);
  await h.accept();
  h.glass.presented(h.sent.at(-1).generation);
  assert.equal(h.sent.at(-1).regions.length, 1);
  h.glass.motion(scroller, true);
  pill.geometry = menu(1210);
  h.tick(1);
  assert.equal(pill.attributes.glass, "off");
  assert.equal(h.sent.at(-1).regions.length, 0, "the moving region was still submitted to AppKit");
  await h.accept();
  h.tick(STABLE_FRAMES + 2);
  assert.equal(h.sent.at(-1).regions.length, 1, "the settled region never came back");
  assert.equal(h.sent.at(-1).regions[0].rect.x, 1210);
});

test("a slice too narrow for its rounded corner cuts no hole, so no hole can spill past the native outline", () => {
  const rect = { x: 200, y: 100, width: 100, height: 40 };
  assert.deepEqual(offPagePieces(rect, RADII, [{ x: 206, y: 0, width: 800, height: 800 }]), []);
  assert.deepEqual(offPagePieces(rect, RADII, [{ x: 220, y: 0, width: 800, height: 800 }]).map((piece) => piece.rect.width), [20]);
  const square = { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 };
  assert.deepEqual(offPagePieces(rect, square, [{ x: 203, y: 0, width: 800, height: 800 }]).map((piece) => piece.rect.width), [3]);
});

const sized = (width = 240, height = 160, x = 100, y = 100) => ({ rect: { x, y, width, height }, radii: RADII, opacity: 1 });

function resize(h, panel, geometry) {
  panel.geometry = geometry;
  h.glass.refresh();
  h.tick();
}

test("a panel that grows or shrinks in place keeps its glass while the new region is sent, presented and settles", async () => {
  for (const next of [sized(240, 320), sized(240, 80), sized(300, 160)]) {
    const h = harness();
    h.glass.setPages([PAGE]);
    const panel = node(sized());
    await shown(h, panel);
    const states = [];
    const record = () => states.push(panel.attributes.glass);
    resize(h, panel, next);
    record();
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.sent.at(-1).regions[0].rect, next.rect);
    await h.accept();
    record();
    h.glass.presented(h.sent.at(-1).generation);
    record();
    h.tick(STABLE_FRAMES);
    record();
    assert.deepEqual([...new Set(states)], ["on"]);
    assert.equal(h.glass.status().panels[0].applied.key, JSON.stringify([[100, 100, next.rect.width, next.rect.height], [10, 10, 10, 10], 1, 1]));
    resize(h, panel, sized(next.rect.width, next.rect.height, 140));
    assert.equal(panel.attributes.glass, "off", "a move after the resize settles still turns it opaque");
  }
});

test("rapid resizes before presentation keep the glass and settle on the final region", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(sized());
  await shown(h, panel);
  const states = [];
  for (const height of [180, 200, 220, 240]) {
    resize(h, panel, sized(240, height));
    states.push(panel.attributes.glass);
  }
  await h.accept(1);
  states.push(panel.attributes.glass);
  await h.accept();
  states.push(panel.attributes.glass);
  assert.equal(h.sent.at(-1).regions[0].rect.height, 240);
  h.glass.presented(h.sent.at(-1).generation);
  h.tick(STABLE_FRAMES);
  states.push(panel.attributes.glass);
  assert.deepEqual([...new Set(states)], ["on"]);
  const status = h.glass.status().panels[0];
  assert.equal(status.applied.generation, h.sent.at(-1).generation);
  assert.equal(status.geometry.rect.height, 240);
  resize(h, panel, sized(240, 240, 100, 130));
  assert.equal(panel.attributes.glass, "off");
});

test("a resize that also moves, animates, is interrupted by motion or uses behind-window glass turns the panel opaque", async () => {
  for (const moved of [sized(260, 160, 110), sized(240, 200, 100, 90)]) {
    const h = harness();
    h.glass.setPages([PAGE]);
    const panel = node(sized());
    await shown(h, panel);
    resize(h, panel, moved);
    assert.equal(panel.attributes.glass, "off");
  }
  const animated = harness();
  animated.glass.setPages([PAGE]);
  const growing = node(sized());
  await shown(animated, growing);
  animated.running.add(growing);
  resize(animated, growing, sized(240, 200));
  assert.equal(growing.attributes.glass, "off");
  const interrupted = harness();
  interrupted.glass.setPages([PAGE]);
  const panel = node(sized());
  await shown(interrupted, panel);
  resize(interrupted, panel, sized(240, 200));
  assert.equal(panel.attributes.glass, "on");
  interrupted.glass.motion(panel);
  assert.equal(panel.attributes.glass, "off");
  await interrupted.accept();
  interrupted.glass.presented(interrupted.sent.at(-1).generation);
  assert.equal(panel.attributes.glass, "off", "motion cleared the resize, so it waits to settle again");
  interrupted.tick(STABLE_FRAMES);
  assert.equal(panel.attributes.glass, "on");
  const behind = harness({ behindWindow: true });
  const pill = node(sized());
  await shown(behind, pill);
  resize(behind, pill, sized(240, 200));
  assert.equal(pill.attributes.glass, "off");
});

test("a resize whose new region is refused, fails to send or falls past the limit turns the panel opaque", async () => {
  const refused = harness();
  refused.glass.setPages([PAGE]);
  const panel = node(sized());
  await shown(refused, panel);
  resize(refused, panel, sized(240, 200));
  assert.equal(panel.attributes.glass, "on");
  await refused.accept(refused.replies.length - 1, []);
  assert.equal(panel.attributes.glass, "off");
  refused.glass.presented(refused.sent.at(-1).generation);
  refused.tick(STABLE_FRAMES);
  assert.equal(panel.attributes.glass, "off");

  const failed = harness();
  failed.glass.setPages([PAGE]);
  const other = node(sized());
  await shown(failed, other);
  resize(failed, other, sized(240, 200));
  assert.equal(other.attributes.glass, "on");
  failed.replies.at(-1).reject(new Error("gone"));
  await failed.settle();
  assert.equal(other.attributes.glass, "off", "a failed update can't leave glass over the stale native rect");
  assert.equal(failed.errors.length, 1);

  const crowded = harness();
  crowded.glass.setPages([PAGE]);
  const early = node(null);
  crowded.glass.add(early);
  const panels = [];
  for (let i = 0; i < GLASS_MAX_REGIONS; i++) {
    const item = node(sized(5, 5, i * 10, 0));
    panels.push(item);
    crowded.glass.add(item);
  }
  const late = panels.at(-1);
  crowded.tick(STABLE_FRAMES + 1);
  await crowded.accept();
  crowded.glass.presented(crowded.sent.at(-1).generation);
  assert.equal(late.attributes.glass, "on");
  early.geometry = menu();
  late.geometry = sized(5, 9, late.geometry.rect.x, 0);
  crowded.glass.flushNow();
  assert.ok(!crowded.sent.at(-1).regions.some((r) => r.rect.x === late.geometry.rect.x));
  assert.equal(late.attributes.glass, "off");
});

test("a panel that shrinks to nothing still leaves an afterimage", async () => {
  const h = harness();
  h.glass.setPages([PAGE]);
  const panel = node(sized());
  await shown(h, panel);
  resize(h, panel, null);
  assert.equal(panel.attributes.glass, "off");
  assert.equal(h.ghosts.length, 1);
  assert.deepEqual(h.ghosts[0].geometry, sized());
});

test("an in-flight refusal or failure clears resize preservation even when a newer resize is queued", async () => {
  const refused = harness();
  refused.glass.setPages([PAGE]);
  const panel = node(sized());
  await shown(refused, panel);
  resize(refused, panel, sized(240, 200));
  resize(refused, panel, sized(240, 240));
  assert.equal(panel.attributes.glass, "on");
  await refused.accept(1, []);
  assert.equal(panel.attributes.glass, "off");

  const revertedRefused = harness();
  revertedRefused.glass.setPages([PAGE]);
  const backPanel = node(sized());
  await shown(revertedRefused, backPanel);
  resize(revertedRefused, backPanel, sized(240, 200));
  resize(revertedRefused, backPanel, sized());
  revertedRefused.tick(STABLE_FRAMES);
  await revertedRefused.accept(1, []);
  assert.equal(backPanel.attributes.glass, "off", "reverted size cannot stay translucent via stale applied baseline after refusal");

  const failed = harness();
  failed.glass.setPages([PAGE]);
  const other = node(sized());
  await shown(failed, other);
  resize(failed, other, sized(240, 200));
  resize(failed, other, sized(240, 240));
  assert.equal(other.attributes.glass, "on");
  failed.replies[1].reject(new Error("gone"));
  await failed.settle();
  assert.equal(other.attributes.glass, "off");
  assert.equal(failed.errors.length, 1);

  const revertedFailed = harness();
  revertedFailed.glass.setPages([PAGE]);
  const backOther = node(sized());
  await shown(revertedFailed, backOther);
  resize(revertedFailed, backOther, sized(240, 200));
  resize(revertedFailed, backOther, sized());
  revertedFailed.tick(STABLE_FRAMES);
  revertedFailed.replies[1].reject(new Error("gone"));
  await revertedFailed.settle();
  assert.equal(backOther.attributes.glass, "off", "reverted size cannot stay translucent via stale applied baseline after send error");
});
