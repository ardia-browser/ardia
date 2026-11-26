import assert from "node:assert/strict";
import { test } from "node:test";
import { createPopoverHost, POPOVER_CLOSE_METHOD, POPOVER_DISMISSED_EVENT, POPOVER_MESSAGE_EVENT, POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD } from "./popoverHost.ts";
import { createButtonPresses, RECENT_PRESS_MS, DOWNLOADS_POPOVER, DOWNLOADS_ROUTE, downloadPresence, downloadsMessage, downloadsPanelSize, downloadsProps, openNativeDownloads, OUTSIDE_SETTLE_MS, runDownloadsMessage } from "./nativeDownloads.ts";

const download = (overrides) => ({ id: "d", filename: "file.zip", path: "/tmp/file.zip", url: "https://example.com/file.zip", state: "finished", received: 2000, total: 2000, speed: 0, paused: false, dangerous: false, ...overrides });
const LIST = [
  download({ id: "run", state: "downloading", received: 500, total: 1000, speed: 100 }),
  download({ id: "held", state: "downloading", paused: true, received: 0, total: 0 }),
  download({ id: "risky", state: "downloading", dangerous: true, url: "http://example.com/x.exe" }),
  download({ id: "done" }),
  download({ id: "gone", path: "/tmp/gone.zip" }),
  download({ id: "failed", state: "failed" }),
];
const exists = (path) => path !== "/tmp/gone.zip";

test("each download row offers the panel's own actions, status and progress", () => {
  const { rows, clearable, dark, revealTitle } = downloadsProps(LIST, exists, true, "Show in Finder");
  assert.deepEqual([clearable, dark, revealTitle], [true, true, "Show in Finder"]);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.run.actions, ["pause", "cancel"]);
  assert.equal(byId.run.progress, 0.5);
  assert.deepEqual([byId.held.actions, byId.held.progress, byId.held.paused], [["resume", "cancel"], 0.03, true]);
  assert.deepEqual([byId.risky.actions, byId.risky.warning, byId.risky.progress, byId.risky.status], [["keep", "discard"], true, null, "Blocked: not secure"]);
  assert.deepEqual([byId.done.actions, byId.done.status, byId.done.missing], [["open", "reveal"], "2.0 KB", false]);
  assert.deepEqual([byId.gone.actions, byId.gone.status, byId.gone.missing], [[], "Deleted", true]);
  assert.deepEqual([byId.failed.actions, byId.failed.status], [[], "Failed to Download"]);
  assert.equal(downloadsProps([LIST[0]], exists, false, "").clearable, false);
  assert.equal(downloadsProps([download({ filename: "" })], exists, false, "").rows[0].title, "Preparing…");
});

test("the panel grows with its rows up to eight, then scrolls", () => {
  const { padding, header, row, empty, footer, separator, width } = DOWNLOADS_POPOVER;
  assert.deepEqual(downloadsPanelSize(0), { width, height: padding * 2 + header + empty + separator + footer });
  assert.equal(downloadsPanelSize(3).height, padding * 2 + header + 3 * row + separator + footer);
  assert.equal(downloadsPanelSize(40).height, downloadsPanelSize(8).height);
});

test("only actions a row offers, for a download it shows, come back from the panel", () => {
  const { rows } = downloadsProps(LIST, exists, false, "");
  assert.deepEqual(downloadsMessage({ type: "action", action: "pause", id: "run" }, rows), { type: "action", action: "pause", id: "run" });
  assert.deepEqual(downloadsMessage({ type: "clear" }, rows), { type: "clear" });
  assert.deepEqual(downloadsMessage({ type: "viewAll", extra: 1 }, rows), { type: "viewAll" });
  for (const bad of [null, "clear", [], { type: "action", action: "open", id: "run" }, { type: "action", action: "pause", id: "nobody" }, { type: "action", action: "rm", id: "done" }, { type: "action", action: "open", id: "gone" }, { type: "navigate", url: "https://x" }]) {
    assert.equal(downloadsMessage(bad, rows), null, JSON.stringify(bad));
  }
});

function recorder() {
  const calls = [];
  const actions = Object.fromEntries(["open", "reveal", "pause", "resume", "cancel", "keep", "clear", "viewAll"].map((name) => [name, (arg) => calls.push(arg === undefined ? [name] : [name, arg])]));
  return { calls, actions };
}

test("messages run the matching download action, and Clear or View all close the panel first", () => {
  const { calls, actions } = recorder();
  let closed = 0;
  const close = () => closed++;
  runDownloadsMessage({ type: "action", action: "open", id: "done" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "reveal", id: "done" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "discard", id: "risky" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "keep", id: "risky" }, LIST, actions, close);
  runDownloadsMessage({ type: "action", action: "pause", id: "missing" }, LIST, actions, close);
  assert.equal(closed, 0);
  runDownloadsMessage({ type: "clear" }, LIST, actions, close);
  runDownloadsMessage({ type: "viewAll" }, LIST, actions, close);
  assert.equal(closed, 2);
  assert.deepEqual(calls, [["open", "/tmp/file.zip"], ["reveal", "/tmp/file.zip"], ["cancel", "risky"], ["keep", "risky"], ["clear"], ["viewAll"]]);
});

function production({ openFails = false, list = LIST } = {}) {
  const calls = [];
  const closes = [];
  const fallbacks = [];
  const timers = [];
  let shell = null;
  let press = "none";
  const releases = [];
  const target = new EventTarget();
  const popovers = createPopoverHost({
    windowId: "w1",
    capabilities: { childPanels: true, beyondWindow: true },
    invoke: (method, args) => {
      calls.push({ method, args });
      return method === POPOVER_OPEN_METHOD && openFails ? Promise.reject(new Error("no panel")) : Promise.resolve(null);
    },
    onShellEvent: (listener) => {
      shell = listener;
      return () => void (shell = null);
    },
    viewport: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    scale: () => 2,
    mountDom: () => ({ element: {}, place: () => {}, unmount: () => {} }),
    addRegion: null,
    target,
    activeElement: () => null,
    contains: () => false,
    nextId: () => "dl1",
  });
  const recorded = recorder();
  let props = downloadsProps(list, exists, false, "Show in Finder");
  const controller = openNativeDownloads({
    popovers,
    anchor: () => ({ rect: { x: 900, y: 10, width: 28, height: 28 }, side: "bottom" }),
    props: () => props,
    list: () => list,
    actions: recorded.actions,
    close: (byPress) => closes.push(byPress),
    isButton: (node) => node === "button",
    buttonPress: () => press,
    afterButtonRelease: (run) => releases.push(run),
    later: (run, ms) => timers.push({ run, ms }),
    fallback: () => fallbacks.push(true),
  });
  const settle = () => new Promise(setImmediate);
  const runTimers = () => {
    for (const timer of timers.splice(0)) timer.run();
  };
  return {
    controller, calls, closes, fallbacks, timers, recorded, settle, runTimers,
    shell: (name, data) => shell?.(name, data),
    hold: () => void (press = "held"),
    release: () => {
      press = "recent";
      for (const run of releases.splice(0)) run();
    },
    pressCleared: () => void (press = "none"),
    releases,
    setProps: (next) => void (props = next),
    method: (name) => calls.filter((call) => call.method === name),
  };
}

test("Downloads opens as a native panel under its button, with the rows as props", async () => {
  const h = production();
  await h.settle();
  const [open] = h.method(POPOVER_OPEN_METHOD);
  assert.equal(open.args.content.route, DOWNLOADS_ROUTE);
  assert.equal(open.args.content.props.rows.length, LIST.length);
  assert.equal(open.args.side, "bottom");
  assert.equal(open.args.rect.width, DOWNLOADS_POPOVER.width);
  assert.equal(open.args.rect.height, downloadsPanelSize(LIST.length).height);
  assert.equal(open.args.takesFocus, true);
});

test("a press in the panel runs its action, and a download change reaches the open panel as new props", async () => {
  const h = production();
  await h.settle();
  h.shell(POPOVER_MESSAGE_EVENT, { id: "dl1", windowId: "w1", message: { type: "action", action: "pause", id: "run" } });
  h.shell(POPOVER_MESSAGE_EVENT, { id: "dl1", windowId: "w1", message: { type: "action", action: "open", id: "run" } });
  assert.deepEqual(h.recorded.calls, [["pause", "run"]]);
  h.setProps(downloadsProps(LIST.slice(0, 2), exists, false, "Show in Finder"));
  h.controller.update();
  await h.settle();
  const [update] = h.method(POPOVER_UPDATE_METHOD);
  assert.equal(update.args.content.props.rows.length, 2);
  assert.equal(update.args.rect.height, downloadsPanelSize(2).height);
  h.shell(POPOVER_MESSAGE_EVENT, { id: "dl1", windowId: "w1", message: { type: "viewAll" } });
  assert.deepEqual(h.closes, [false]);
});

test("Escape or blur closes Downloads at once; an outside press closes it as a press, and a press on its own button is left to the button", async () => {
  const escape = production();
  await escape.settle();
  escape.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "escape" });
  assert.deepEqual(escape.closes, [false]);

  const outside = production();
  await outside.settle();
  outside.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  assert.deepEqual(outside.closes, []);
  assert.deepEqual(outside.timers.map((timer) => timer.ms), [OUTSIDE_SETTLE_MS]);
  outside.runTimers();
  assert.deepEqual(outside.closes, [true]);

  const quick = production();
  await quick.settle();
  quick.release();
  quick.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  assert.deepEqual(quick.timers.map((timer) => timer.ms), [0]);
  quick.controller.stop();
  quick.runTimers();
  assert.deepEqual(quick.closes, [], "the button's own toggle closed it");

  const late = production();
  await late.settle();
  late.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  late.hold();
  late.runTimers();
  assert.equal(late.releases.length, 1);
  late.controller.stop();
  late.release();
  assert.deepEqual(late.closes, []);
});

test("holding the Downloads button past any timer and releasing never reopens the panel", async () => {
  const h = production();
  await h.settle();
  h.hold();
  h.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  assert.deepEqual(h.timers, [], "nothing waits on a clock while the button is held");
  for (let tick = 0; tick < 50; tick++) h.runTimers();
  assert.deepEqual(h.closes, []);
  h.controller.stop();
  h.release();
  assert.deepEqual(h.closes, [], "the release's own toggle closed it, and the panel isn't asked to close twice or reopen");

  const dragged = production();
  await dragged.settle();
  dragged.hold();
  dragged.shell(POPOVER_DISMISSED_EVENT, { id: "dl1", windowId: "w1", reason: "outside" });
  dragged.release();
  assert.deepEqual(dragged.closes, [true], "a press dragged off the button still closes the panel once released");
});

test("finished downloads keep Open and Show until the host confirms a file is gone", () => {
  const done = download({ id: "done" });
  for (const status of ["unknown", "present"]) {
    const row = downloadsProps([done], downloadPresence(() => status), false, "").rows[0];
    assert.deepEqual([row.actions, row.missing, row.status], [["open", "reveal"], false, "2.0 KB"], status);
  }
  const gone = downloadsProps([done], downloadPresence(() => "missing"), false, "").rows[0];
  assert.deepEqual([gone.actions, gone.missing, gone.status], [[], true, "Deleted"]);
});

test("closing Downloads from the store closes the native panel once and leaves no listener", async () => {
  const h = production();
  await h.settle();
  h.controller.stop();
  await h.settle();
  assert.equal(h.method(POPOVER_CLOSE_METHOD).length, 1);
  assert.equal(h.controller.handle.closed(), true);
  h.controller.update();
  assert.equal(h.method(POPOVER_UPDATE_METHOD).length, 0);
  assert.deepEqual(h.closes, [], "a close the store asked for is not echoed back to the store");
});

test("a host that can't open the panel falls back to the DOM Downloads without closing it", async () => {
  const h = production({ openFails: true });
  await h.settle();
  await h.settle();
  assert.deepEqual(h.fallbacks, [true]);
  assert.deepEqual(h.closes, []);
});

test("a hold belongs to the pointer that pressed the Downloads button, so another pointer's release can't end it", () => {
  let now = 0;
  const deferred = [];
  const presses = createButtonPresses((target) => target === "button", () => now, (run) => deferred.push(run));
  const ran = [];
  const flush = () => deferred.splice(0).forEach((run) => run());
  presses.down({ pointerId: 7, target: "elsewhere" });
  assert.equal(presses.press(), "none");
  presses.down({ pointerId: 1, target: "button" });
  presses.down({ pointerId: 2, target: "button" });
  assert.equal(presses.press(), "held");
  presses.afterRelease(() => ran.push("released"));
  presses.up({ pointerId: 2, target: "button" });
  presses.up({ pointerId: 3, target: "page" });
  flush();
  assert.equal(presses.press(), "held", "a second pointer lifting doesn't release the first one's hold");
  assert.deepEqual(ran, []);
  now = 900;
  presses.up({ pointerId: 1, target: "elsewhere" });
  assert.equal(presses.press(), "recent");
  flush();
  assert.deepEqual(ran, ["released"]);
  now += RECENT_PRESS_MS + 1;
  assert.equal(presses.press(), "none");
  presses.afterRelease(() => ran.push("idle"));
  flush();
  assert.deepEqual(ran, ["released", "idle"]);
  presses.down({ target: "button" });
  presses.afterRelease(() => ran.push("cleared"));
  presses.clear();
  presses.up({ target: "button" });
  flush();
  assert.deepEqual(ran, ["released", "idle"]);
});
