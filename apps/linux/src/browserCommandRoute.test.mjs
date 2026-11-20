import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_WINDOW_COMMANDS, regularFocusOrder, routeToBrowserWindow, serveBrowserCommands } from "./browserCommandRoute.ts";

const name = `route-test-${process.pid}`;

function fakeClock() {
  let now = 0;
  let next = 0;
  const pending = new Map();
  return {
    after: (run, ms) => (pending.set(++next, { run, at: now + ms }), next),
    cancel: (handle) => void pending.delete(handle),
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !pending.has(handle)) continue;
        pending.delete(handle);
        timer.run();
      }
    },
    pending: () => pending.size,
  };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
const until = async (condition) => {
  while (!condition()) await turn();
};

function watch() {
  const channel = new BroadcastChannel(name);
  const seen = [];
  channel.addEventListener("message", ({ data }) => seen.push(data));
  return { seen, count: (type) => seen.filter((m) => m.type === type).length, close: () => channel.close() };
}

function browserRenderer(windowId, focus, timers) {
  const channel = new BroadcastChannel(name);
  const ran = [];
  const focused = [];
  const served = serveBrowserCommands({ windowId, channel, order: () => focus.order, run: (id, command) => ran.push([id, command]), focus: async (id) => focused.push(id), timers });
  return { ran, focused, close: () => { served.remove(); channel.close(); } };
}

async function route(settings, clock, watcher, command, windows, options = {}) {
  const heard = watcher.count("here");
  const runs = watcher.count("run");
  const routed = routeToBrowserWindow({ channel: settings, command, timers: clock, gatherMs: 150, answerMs: 1500, ...options });
  await until(() => watcher.count("here") >= heard + windows);
  clock.advance(options.gatherMs ?? 150);
  if (windows) await until(() => watcher.count("run") > runs);
  return routed;
}

test("a utility window's browser command runs once, in the first regular window of the browser windows' focus order", async () => {
  const clock = fakeClock();
  const watcher = watch();
  const focus = { order: ["w2", "w1", "w3"] };
  const renderers = ["w1", "w2", "w3"].map((id) => browserRenderer(id, focus, clock));
  const settings = new BroadcastChannel(name);
  try {
    assert.equal(await route(settings, clock, watcher, "showOnboarding", 3), "w2");
    await until(() => renderers[1].ran.length === 1);
    assert.deepEqual(renderers.map((r) => r.ran), [[], [["w2", "showOnboarding"]], []]);
    await until(() => renderers[1].focused.length === 1);
    assert.deepEqual(renderers[1].focused, ["w2"]);
    focus.order = ["w3", "w2", "w1"];
    assert.equal(await route(settings, clock, watcher, "toolTour", 3), "w3");
    await until(() => renderers[2].ran.length === 1);
    assert.deepEqual(renderers[2].ran, [["w3", "toolTour"]]);
    await until(() => watcher.count("go") === 2);
    assert.equal(renderers.flatMap((r) => r.ran).length, 2);
  } finally {
    renderers.forEach((r) => r.close());
    settings.close();
    watcher.close();
  }
});

test("a focused window that doesn't serve (a private window, or one still loading) is skipped for the next regular one", async () => {
  const clock = fakeClock();
  const watcher = watch();
  const focus = { order: ["w-private", "w1"] };
  const renderer = browserRenderer("w1", focus, clock);
  const settings = new BroadcastChannel(name);
  try {
    assert.equal(await route(settings, clock, watcher, "showOnboarding", 1), "w1");
    await until(() => renderer.ran.length === 1);
    assert.deepEqual(renderer.ran, [["w1", "showOnboarding"]]);
  } finally {
    renderer.close();
    settings.close();
    watcher.close();
  }
});

test("the focus order keeps only regular, non-Little-Ardia windows", () => {
  const state = {
    ui: { focusOrder: ["p", "small", "b", "gone"] },
    windowOrder: ["a", "b", "p", "small"],
    windows: { a: { kind: "main" }, b: { kind: "main" }, p: { kind: "private" }, small: { kind: "small" } },
  };
  assert.deepEqual(regularFocusOrder(state), ["b", "a"]);
});

test("with no browser window serving the route answers null instead of pretending it ran", async () => {
  const clock = fakeClock();
  const watcher = watch();
  const settings = new BroadcastChannel(name);
  try {
    assert.equal(await route(settings, clock, watcher, "showOnboarding", 0), null);
    assert.equal(clock.pending(), 0, "nothing is left waiting");
  } finally {
    settings.close();
    watcher.close();
  }
});

test("browser windows refuse routed commands that aren't browser-window help commands", async () => {
  const clock = fakeClock();
  const watcher = watch();
  const renderer = browserRenderer("w1", { order: ["w1"] }, clock);
  const settings = new BroadcastChannel(name);
  try {
    assert.equal(BROWSER_WINDOW_COMMANDS.has("quit"), false);
    const routed = route(settings, clock, watcher, "quit", 1, { answerMs: 100 });
    await until(() => watcher.count("run") === 1);
    await turn();
    await turn();
    assert.equal(watcher.count("claim"), 0, "no window claims it");
    clock.advance(100);
    assert.equal(await routed, null);
    assert.deepEqual(renderer.ran, []);
  } finally {
    renderer.close();
    settings.close();
    watcher.close();
  }
});

test("a claim that arrives after the utility gave up is never told to run, so there is exactly one answer", async () => {
  const clock = fakeClock();
  const late = new BroadcastChannel(name);
  const watcher = watch();
  const settings = new BroadcastChannel(name);
  let runRequest = null;
  late.addEventListener("message", ({ data }) => {
    if (data.type === "find") late.postMessage({ type: "here", request: data.request, windowId: "w1", order: ["w1"] });
    if (data.type === "run") runRequest = data.request;
  });
  try {
    const routed = route(settings, clock, watcher, "showOnboarding", 1, { gatherMs: 20, answerMs: 20 });
    await until(() => runRequest !== null);
    clock.advance(20);
    assert.equal(await routed, null);
    late.postMessage({ type: "claim", request: runRequest, windowId: "w1" });
    await until(() => watcher.count("claim") === 1);
    await turn();
    await turn();
    assert.equal(watcher.count("go"), 0);
  } finally {
    late.close();
    watcher.close();
    settings.close();
  }
});

test("a window that claimed but never heard go drops the claim and runs nothing", async () => {
  const clock = fakeClock();
  const channel = new BroadcastChannel(name);
  const driver = new BroadcastChannel(name);
  const watcher = watch();
  const ran = [];
  const served = serveBrowserCommands({ windowId: "w1", channel, order: () => ["w1"], run: (...args) => ran.push(args), focus: async () => {}, claimMs: 30, timers: clock });
  try {
    driver.postMessage({ type: "run", request: "r1", windowId: "w1", command: "showOnboarding" });
    await until(() => watcher.count("claim") === 1);
    assert.equal(clock.pending(), 1, "the claim waits for its go");
    clock.advance(30);
    assert.equal(clock.pending(), 0, "the claim lapsed");
    driver.postMessage({ type: "go", request: "r1", windowId: "w1" });
    await until(() => watcher.count("go") === 1);
    await turn();
    await turn();
    assert.deepEqual(ran, []);
  } finally {
    served.remove();
    channel.close();
    driver.close();
    watcher.close();
  }
});
