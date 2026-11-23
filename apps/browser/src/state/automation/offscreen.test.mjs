import assert from "node:assert/strict";
import { mock, test } from "node:test";
const mockTimers = mock.timers;
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 9, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 9); i++) await tick();
  return JSON.parse(stub.controlSocket.replies.slice(before).find((r) => r.connection === 9).line);
}

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://shown.example/" });
  const shown = S().windows[windowId].activeTabIds[S().windows[windowId].profileId];
  const hidden = S().newTab(windowId, { url: "https://hidden.example/", background: true });
  return { windowId, shown, hidden };
}

test("offscreen: a hidden tab the command opened leaves the window with no closed-tab record", async () => {
  const { windowId, shown, hidden } = await setup();
  const moved = [];
  globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
  globalThis.acTestCliMoveOffscreen = (tabId) => (moved.push(tabId), { ok: true });
  try {
    const closedBefore = S().closedTabs.length;
    assert.deepEqual((await call("offscreen", { tab: hidden })).result, { ok: true });
    assert.deepEqual(moved, [hidden]);
    assert.equal(S().tabs[hidden], undefined);
    assert.equal(S().windows[windowId].tabIds.includes(hidden), false);
    assert.equal(S().closedTabs.length, closedBefore);
    assert.equal(S().windows[windowId].activeTabIds[S().windows[windowId].profileId], shown);
  } finally {
    delete globalThis.acTestCliOwns;
    delete globalThis.acTestCliMoveOffscreen;
  }
});

test("offscreen: the shown tab, a tab the command didn't open, one that was shown and a failed move all stay", async () => {
  const { shown, hidden } = await setup();
  const moved = [];
  globalThis.acTestCliMoveOffscreen = (tabId) => (moved.push(tabId), { ok: false, reason: "Ardia couldn't take that tab off-screen." });
  try {
    globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
    assert.match((await call("offscreen", { tab: shown })).error.message, /shown in a window/);
    globalThis.acTestCliOwns = () => ({ owned: false, shown: false });
    assert.match((await call("offscreen", { tab: hidden })).error.message, /didn't open/);
    globalThis.acTestCliOwns = () => ({ owned: true, shown: true });
    assert.match((await call("offscreen", { tab: hidden })).error.message, /has been shown/);
    assert.deepEqual(moved, []);
    globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
    assert.match((await call("offscreen", { tab: hidden })).error.message, /couldn't take/);
    assert.ok(S().tabs[hidden]);
    assert.match((await call("offscreen", { tab: "tab-nope" })).error.message, /no such tab/);
    assert.match((await call("offscreen", { tab: hidden, window: "w" })).error.message, /takes no window \(it takes tab\)/);
  } finally {
    delete globalThis.acTestCliOwns;
    delete globalThis.acTestCliMoveOffscreen;
  }
});

test("offscreen: the 5 s close asks the engine first, so a connection JS hasn't heard about yet keeps its tabs", async () => {
  const { noteCliConnections } = await import("./offscreen.ts");
  let closes = 0;
  let live = 0;
  globalThis.acTestCliCloseOffscreen = () => void closes++;
  globalThis.acTestCliControl = () => ({ state: "on", port: 1, connections: live, generation: 1, file: "" });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };
  try {
    mockTimers.enable({ apis: ["setTimeout"] });
    noteCliConnections(1);
    noteCliConnections(0);
    live = 1;
    mockTimers.tick(5000);
    mockTimers.reset();
    await settle();
    assert.equal(closes, 0, "a connection the engine counts keeps the off-screen tabs");
    live = 0;
    mockTimers.enable({ apis: ["setTimeout"] });
    noteCliConnections(1);
    noteCliConnections(0);
    mockTimers.tick(5000);
    mockTimers.reset();
    await settle();
    assert.equal(closes, 1, "with no connection left, the off-screen tabs close");
  } finally {
    mockTimers.reset();
    delete globalThis.acTestCliCloseOffscreen;
    delete globalThis.acTestCliControl;
  }
});

test("offscreen: when the engine's status can't be read, the 5 s close still runs", async () => {
  const { noteCliConnections } = await import("./offscreen.ts");
  let closes = 0;
  globalThis.acTestCliCloseOffscreen = () => void closes++;
  globalThis.acTestCliControl = () => Promise.reject(new Error("engine gone"));
  try {
    mockTimers.enable({ apis: ["setTimeout"] });
    noteCliConnections(1);
    noteCliConnections(0);
    mockTimers.tick(5000);
    mockTimers.reset();
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(closes, 1);
  } finally {
    mockTimers.reset();
    delete globalThis.acTestCliCloseOffscreen;
    delete globalThis.acTestCliControl;
  }
});
