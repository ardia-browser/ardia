import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const native = await import("../../test-native/reactNative.ts");
const client = await import("../../state/telemetry/client.ts");
const { takeTabMotionCounts } = await import("../../state/telemetry/tabMotionCounts.ts");
const { createMotion, plan, shoot } = await import("./stripSlides.ts");

const animations = native.animations;
after(() => {
  animations.held = false;
  animations.running = [];
  client.setSharing(false, "settings");
});

const shot = (keys, { width = 100, tabs = {}, end = null } = {}) => ({
  keys,
  x: new Map(keys.map((k, i) => [k, i * (width + 4)])),
  width: new Map(keys.map((k) => [k, width])),
  tabs: new Map(keys.map((k) => [k, [k]])),
  shown: new Map(keys.map((k) => [k, [k]])),
  groups: new Set(),
  end,
  state: { tabs: Object.fromEntries([...keys, ...Object.keys(tabs)].map((k) => [k, { id: k, url: `https://e.test/${k}`, title: k, profileId: "default" }])) },
});

const held = (fn) => {
  animations.held = true;
  try {
    return fn();
  } finally {
    animations.held = false;
  }
};

test("a close while a chip still slides keeps the slide and restarts it from where it is drawn", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "b", from: 104 }], appears: [], ghosts: [], at: Date.now() });
    const slide = own.motion.slide("b");
    assert.ok(slide);
    own.motion.mount(slide);
    assert.ok(slide.moving);
    own.apply({ moves: [{ key: "b", from: 154 }], appears: [], ghosts: [], at: Date.now() + 50 });
    assert.equal(own.motion.slide("b"), slide, "the live slide survives the second close");
    assert.ok(slide.moving, "and runs again");
    assert.equal(slide.value.__getValue(), 154);
  });
  animations.finish();
  assert.equal(own.motion.slide("b"), null, "it lands once the restarted run ends");
});

test("three closes in a row each restart the same chips without dropping one", () => {
  const own = createMotion();
  held(() => {
    const at = Date.now();
    own.apply({ moves: [{ key: "c", from: 104 }, { key: "d", from: 104 }], appears: [], ghosts: [], at });
    for (const k of ["c", "d"]) own.motion.mount(own.motion.slide(k));
    for (let i = 1; i < 3; i++) {
      own.apply({ moves: [{ key: "c", from: 104 * (i + 1) }, { key: "d", from: 104 * (i + 1) }], appears: [], ghosts: [], at: at + 120 * i });
      for (const k of ["c", "d"]) assert.ok(own.motion.slide(k)?.moving, `${k} after close ${i + 1}`);
    }
  });
  animations.finish();
  assert.equal(own.slides.size, 0);
});

test("the planner slides what moved, fades what opened and leaves a ghost for what closed, only in view", () => {
  const before = shot(["a", "b", "c", "far"], { tabs: {} });
  const after = shot(["a", "c", "far"]);
  delete after.state.tabs.b;
  after.x.set("far", 5000);
  before.x.set("far", 5104);
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false);
  assert.deepEqual(p.moves.map((m) => [m.key, m.from]), [["c", 104]]);
  assert.deepEqual(p.ghosts.map((g) => g.x), [104]);
  assert.equal(plan(before, before, new Map(), [-48, 1000], Date.now(), false), null);
});

test("an overrun counts in the consent period its run started in, not the one it was found in", () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  takeTabMotionCounts();
  const own = createMotion();
  const at = Date.now() - 10_000;
  held(() => {
    own.apply({ moves: [{ key: "e", from: 104 }], appears: [], ghosts: [], at });
    own.motion.mount(own.motion.slide("e"));
  });
  client.setSharing(true, "settings");
  held(() => own.apply({ moves: [], appears: [], ghosts: [], at: Date.now() }));
  assert.equal(takeTabMotionCounts().tab_strip_motion_overruns, 0);

  const later = createMotion();
  held(() => {
    later.apply({ moves: [{ key: "f", from: 104 }], appears: [], ghosts: [], at });
    later.motion.mount(later.motion.slide("f"));
    later.apply({ moves: [], appears: [], ghosts: [], at: Date.now() });
  });
  assert.equal(takeTabMotionCounts().tab_strip_motion_overruns, 1);
  animations.running = [];
});

test("a drag landing the strip puts every sliding chip in its final place at once and lets fades finish", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "g", from: 104 }], appears: ["h"], ghosts: [], at: Date.now() });
    for (const k of ["g", "h"]) own.motion.mount(own.motion.slide(k));
    const g = own.motion.slide("g");
    const h = own.motion.slide("h");
    own.motion.land();
    assert.equal(own.motion.slide("g"), null);
    assert.equal(g.value.__getValue(), 0);
    assert.equal(h.value.__getValue(), 0, "nothing is left out of place");
  });
  animations.finish();
  assert.equal(own.slides.size, 0);
});

test("a second close leaves a chip whose place it doesn't change on its running slide, the + button too", () => {
  const own = createMotion();
  const at = Date.now();
  const first = shot(["a", "b", "c", "d"], { end: 420 });
  const second = shot(["b", "c", "d"], { end: 316 });
  delete second.state.tabs.a;
  held(() => {
    own.apply(plan(first, second, own.slides, [-48, 1000], at, false));
    for (const k of own.slides.keys()) own.motion.mount(own.motion.slide(k));
    const b = own.motion.slide("b");
    const plus = own.motion.slide("~new");
    const third = shot(["b", "d"], { end: 212 });
    delete third.state.tabs.a;
    delete third.state.tabs.c;
    third.x.set("b", second.x.get("b"));
    third.end = second.end;
    const p = plan(second, third, own.slides, [-48, 1000], at + 50, false);
    assert.deepEqual(p.moves.map((m) => m.key), ["d"]);
    own.apply(p);
    assert.equal(own.motion.slide("b"), b);
    assert.equal(b.from, 104, "b keeps the run it had");
    assert.equal(own.motion.slide("~new"), plus);
  });
  animations.running = [];
});

test("a tab closed while it fades in leaves a ghost that starts where its fade was", () => {
  const own = createMotion();
  const at = Date.now();
  const opened = shot(["a", "n", "b"]);
  const closed = shot(["a", "b"]);
  delete closed.state.tabs.n;
  held(() => {
    own.apply({ moves: [], appears: ["n"], ghosts: [], at });
    own.motion.mount(own.motion.slide("n"));
    const p = plan(opened, closed, own.slides, [-48, 1000], at + 30, false);
    assert.equal(p.ghosts.length, 1);
    const start = p.ghosts[0].opacity.__getValue();
    assert.ok(start > 0 && start < 1, `the ghost starts at ${start}, not opaque`);
  });
  animations.running = [];
});

test("only the close a strip press made steps; a close from elsewhere still slides, wherever the pointer is", () => {
  const before = shot(["a", "b", "c"], { end: 312 });
  const after = shot(["a", "c"], { end: 208 });
  delete after.state.tabs.b;
  const pressed = plan(before, after, new Map(), [-48, 1000], Date.now(), false, (closed) => closed.filter((id) => id === "b"));
  assert.equal(pressed.stepped, true);
  assert.deepEqual(pressed.moves, []);
  assert.equal(pressed.ghosts.length, 1);
  const elsewhere = plan(before, after, new Map(), [-48, 1000], Date.now(), false, (closed) => closed.filter((id) => id === "x"));
  assert.equal(elsewhere.stepped, false);
  assert.deepEqual(elsewhere.moves.map((m) => m.key), ["c", "~new"]);
});

test("a step lands translations but lets a fade-in finish", () => {
  const own = createMotion();
  held(() => {
    own.apply({ moves: [{ key: "m", from: 104 }], appears: ["n"], ghosts: [], at: Date.now(), stepped: false });
    for (const k of ["m", "n"]) own.motion.mount(own.motion.slide(k));
    const n = own.motion.slide("n");
    own.motion.land();
    assert.equal(own.motion.slide("m"), null, "the slide lands");
    assert.equal(own.motion.slide("n"), n, "the fade keeps running");
    assert.equal(n.fading, true);
    assert.equal(n.opacity.__getValue(), 0);
  });
  animations.finish();
  assert.equal(own.slides.size, 0);
});

test("a fading tab that slides keeps its fade's own clock, so its ghost starts where the fade is", () => {
  const own = createMotion();
  const at = Date.now();
  held(() => {
    own.apply({ moves: [], appears: ["n"], ghosts: [], at, stepped: false });
    const n = own.motion.slide("n");
    own.motion.mount(n);
    n.appearAt = at - 70;
    own.apply({ moves: [{ key: "n", from: 104 }], appears: [], ghosts: [], at: at + 10, stepped: false });
    assert.equal(n.appearAt, at - 70, "moving it doesn't restart its fade");
    assert.equal(n.fading, true);
    const opened = shot(["a", "n"]);
    const closed = shot(["a"]);
    delete closed.state.tabs.n;
    const ghost = plan(opened, closed, own.slides, [-48, 1000], at + 20, false).ghosts[0];
    assert.equal(ghost.opacity.__getValue(), 90 / 140);
  });
  animations.running = [];
});

test("a member opened or closed inside a surviving group steps everything at once and takes its press", () => {
  const before = shot(["a", "group:g", "c"], { tabs: { m1: 1, m2: 1 } });
  before.tabs.set("group:g", ["m1", "m2"]);
  before.shown.set("group:g", ["m1", "m2"]);
  before.width.set("group:g", 300);
  const after = shot(["a", "group:g", "c"], { tabs: { m1: 1 } });
  after.tabs.set("group:g", ["m1"]);
  after.shown.set("group:g", ["m1"]);
  after.x.set("c", before.x.get("c") - 177);
  delete after.state.tabs.m2;
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false, (closed) => closed.filter((id) => id === "m2"));
  assert.equal(p.stepped, true);
  assert.deepEqual(p.moves, []);
  assert.deepEqual(p.pressed, ["m2"]);
});

test("a tab pushed into the overflow menu just leaves, and one coming back just appears", () => {
  const before = shot(["a", "b", "c"]);
  const after = shot(["a", "n", "b"], { tabs: { c: 1 } });
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false);
  assert.deepEqual(p.ghosts, [], "c is still open, in the menu: no ghost");
  assert.deepEqual(p.appears, ["n"]);
  const back = plan(after, before, new Map(), [-48, 1000], Date.now(), false);
  assert.deepEqual(back.appears, [], "c comes back without a fade-in");
});

const grouped = (keys, members, shownMembers, extraTabs = []) => {
  const s = shot(keys, { tabs: Object.fromEntries([...members, ...extraTabs].map((id) => [id, 1])) });
  s.groups.add("group:g");
  s.tabs.set("group:g", members);
  s.shown.set("group:g", shownMembers);
  return s;
};

test("an ordinary close slides even when a hidden group member closes with it", () => {
  const before = grouped(["group:g", "a", "b"], ["m1", "hidden"], [], []);
  before.end = 312;
  const after = grouped(["group:g", "b"], ["m1"], [], []);
  after.end = 208;
  after.x.set("b", before.x.get("a"));
  delete after.state.tabs.a;
  delete after.state.tabs.hidden;
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false);
  assert.equal(p.stepped, false);
  assert.deepEqual(p.moves.map((m) => m.key), ["b", "~new"]);
});

test("closing only a group member that sits in the overflow menu plans nothing", () => {
  const before = grouped(["a", "group:g", "b"], ["m1", "over"], ["m1"]);
  const after = grouped(["a", "group:g", "b"], ["m1"], ["m1"]);
  delete after.state.tabs.over;
  assert.equal(plan(before, after, new Map(), [-48, 1000], Date.now(), false), null);
});

test("closing a member the strip shows steps", () => {
  const before = grouped(["a", "group:g", "b"], ["m1", "m2"], ["m1", "m2"]);
  const after = grouped(["a", "group:g", "b"], ["m1"], ["m1"]);
  after.x.set("b", before.x.get("b") - 100);
  delete after.state.tabs.m2;
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false);
  assert.equal(p.stepped, true);
  assert.deepEqual(p.moves, []);
});

test("a group that shifts keeps its own place, and the tabs after it still slide", () => {
  const before = grouped(["a", "group:g", "b"], ["m1"], ["m1"]);
  before.end = 312;
  const after = grouped(["group:g", "b"], ["m1"], ["m1"]);
  after.end = 208;
  delete after.state.tabs.a;
  const p = plan(before, after, new Map(), [-48, 1000], Date.now(), false);
  assert.deepEqual(p.moves.map((m) => m.key), ["b", "~new"]);
});

test("a snapshot shows an expanded group's members after the overflow menu, and none of a collapsed group's", () => {
  const top = { slots: [{ tabIds: ["m1", "m2", "over"], width: 300 }, { tabIds: ["c1"], width: 80 }, { tabIds: ["a"], width: 100 }], lefts: [0, 304, 388] };
  const entries = [
    { kind: "group", id: "g", collapsed: false, members: [{ kind: "tab", id: "m1", group: "g" }, { kind: "tab", id: "m2", group: "g" }], memberTabIds: ["m1", "m2", "over"] },
    { kind: "group", id: "h", collapsed: true, members: [{ kind: "tab", id: "c1", group: "h" }] },
    { kind: "tab", id: "a", group: null },
  ];
  const snap = shoot(entries, top, 15, null, { tabs: {} });
  assert.deepEqual(snap.shown.get("group:g"), ["m1", "m2"]);
  assert.deepEqual(snap.shown.get("group:h"), []);
  assert.deepEqual(snap.shown.get("a"), ["a"]);
  assert.deepEqual(snap.tabs.get("group:g"), ["m1", "m2", "over"]);
});

test("a change that cancels a chip's live offset stops its slide where it belongs, and keeps its fade", () => {
  const own = createMotion();
  const at = Date.now();
  held(() => {
    own.apply({ moves: [{ key: "b", from: 104 }], appears: ["c"], ghosts: [], at, stepped: false, pressed: [] });
    own.apply({ moves: [{ key: "c", from: 104 }], appears: [], ghosts: [], at, stepped: false, pressed: [] });
    for (const k of ["b", "c"]) own.motion.mount(own.motion.slide(k));
    const b = own.motion.slide("b");
    const c = own.motion.slide("c");
    const before = shot(["a", "b", "c"]);
    const after = shot(["a", "n", "b", "c"]);
    const p = plan(before, after, own.slides, [-48, 1000], at, false);
    assert.deepEqual(p.moves.filter((m) => m.key === "b" || m.key === "c"), [{ key: "b", from: 0 }, { key: "c", from: 0 }]);
    own.apply(p);
    assert.equal(b.value.__getValue(), 0);
    assert.equal(own.motion.slide("b"), null, "b's slide is gone, not left running away from its place");
    assert.equal(c.value.__getValue(), 0);
    assert.equal(own.motion.slide("c"), c, "c keeps fading in");
    assert.equal(c.fading, true);
  });
  animations.running = [];
});

test("the + button stops too when a change cancels its live offset", () => {
  const own = createMotion();
  const at = Date.now();
  held(() => {
    own.apply({ moves: [{ key: "~new", from: 104 }], appears: [], ghosts: [], at, stepped: false, pressed: [] });
    own.motion.mount(own.motion.slide("~new"));
    const before = shot(["a", "b"], { end: 208 });
    const after = shot(["a", "n", "b"], { end: 312 });
    const p = plan(before, after, own.slides, [-48, 1000], at, false);
    assert.deepEqual(p.moves.find((m) => m.key === "~new"), { key: "~new", from: 0 });
    own.apply(p);
    assert.equal(own.motion.slide("~new"), null);
  });
  animations.running = [];
});
