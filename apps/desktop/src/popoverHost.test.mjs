import assert from "node:assert/strict";
import test from "node:test";
import { createPopoverHost, focusableForRestore, nextPopoverId, popoverCapabilities, POPOVER_BEYOND_WINDOW, POPOVER_CHILD_PANEL_METHODS, POPOVER_CLOSE_METHOD, POPOVER_DISMISSED_EVENT, POPOVER_MESSAGE_EVENT, POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD } from "./popoverHost.ts";

const hostWith = (capabilities) => ({ bootstrap: { windowId: "w", profileId: "p", capabilities }, call: async () => "null", invoke: async () => null, onEvent: () => () => {} });

test("child panels are advertised only when the host serves open, update and close; beyond-window needs its own flag", () => {
  assert.deepEqual(popoverCapabilities(undefined), { childPanels: false, beyondWindow: false });
  assert.deepEqual(popoverCapabilities(hostWith([POPOVER_OPEN_METHOD, POPOVER_CLOSE_METHOD])), { childPanels: false, beyondWindow: false });
  assert.deepEqual(popoverCapabilities(hostWith([...POPOVER_CHILD_PANEL_METHODS])), { childPanels: true, beyondWindow: false });
  assert.deepEqual(popoverCapabilities(hostWith([...POPOVER_CHILD_PANEL_METHODS, POPOVER_BEYOND_WINDOW])), { childPanels: true, beyondWindow: true });
  assert.deepEqual(popoverCapabilities(hostWith([POPOVER_BEYOND_WINDOW])), { childPanels: false, beyondWindow: false });
});

function element(name) {
  const node = { name, nodeName: "DIV", isConnected: true, focused: 0, focus() { this.focused++; active = this; } };
  return node;
}
let active = null;

function harness({ childPanels = false, beyondWindow = false, openFails = false, openThrows = false, holdOpen = false, focusable, mountThrows = false, scale = 2 } = {}) {
  const target = new EventTarget();
  const calls = [];
  const mounted = [];
  const regions = new Set();
  const dismissed = [];
  let shellListener = null;
  let pageFocusListener = null;
  let windowFocused = true;
  const pendingOpens = [];
  let id = 0;
  const body = { nodeName: "BODY", focus() {} };
  active = body;
  const host = createPopoverHost({
    windowId: "w1",
    capabilities: { childPanels, beyondWindow },
    invoke: (method, args) => {
      calls.push({ method, args });
      if (method === POPOVER_OPEN_METHOD && openThrows) throw new Error("threw synchronously");
      if (method === POPOVER_OPEN_METHOD && openFails) return Promise.reject(new Error("no panel"));
      if (method === POPOVER_OPEN_METHOD && holdOpen) return new Promise((resolve, reject) => pendingOpens.push({ resolve, reject }));
      return Promise.resolve(null);
    },
    watchPageFocus: (listener) => {
      pageFocusListener = listener;
      return () => void (pageFocusListener = null);
    },
    windowFocused: () => windowFocused,
    ...(focusable ? { focusable } : {}),
    onShellEvent: (listener) => {
      shellListener = listener;
      return () => void (shellListener = null);
    },
    viewport: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    workArea: () => ({ x: -100, y: -100, width: 1920, height: 1080 }),
    scale: () => scale,
    mountDom: (popoverId, spec, placement) => {
      if (mountThrows) throw new Error("mount failed");
      const node = element(popoverId);
      const record = { id: popoverId, node, placements: [placement], unmounted: false };
      mounted.push(record);
      return { element: node, place: (next) => record.placements.push(next), unmount: () => void (record.unmounted = true) };
    },
    addRegion: (node) => {
      regions.add(node);
      return () => regions.delete(node);
    },
    target,
    activeElement: () => active,
    contains: (node, other) => node === other,
    nextId: () => `p${++id}`,
    report: () => {},
  });
  const spec = (extra = {}) => ({ anchor: { x: 400, y: 600, width: 40, height: 20 }, size: { width: 200, height: 150 }, content: { route: "downloads" }, onDismiss: (reason) => dismissed.push(reason), ...extra });
  const key = (init) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key: "Escape", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const press = (on) => {
    const event = new Event("pointerdown");
    Object.defineProperty(event, "target", { value: on });
    target.dispatchEvent(event);
  };
  return {
    host, calls, mounted, regions, dismissed, spec, key, press, target, pendingOpens,
    shell: (name, data) => shellListener?.(name, data),
    listening: () => !!shellListener,
    focusPage: () => pageFocusListener?.(),
    setWindowFocused: (value) => void (windowFocused = value),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("without child panels a popover mounts in the DOM at once and registers its input region", async () => {
  const h = harness();
  const handle = h.host.open(h.spec());
  assert.equal(handle.mode(), "dom");
  assert.equal(await handle.ready, "dom");
  assert.equal(h.mounted.length, 1);
  assert.ok(h.regions.has(h.mounted[0].node));
  assert.equal(handle.placement().side, "top");
  assert.equal(h.calls.length, 0);
  handle.close();
  assert.equal(h.regions.size, 0);
  assert.equal(h.mounted[0].unmounted, true);
  assert.deepEqual(h.dismissed, ["closed"]);
});

test("with child panels the host gets the placed rect and no DOM or input region is used", async () => {
  const h = harness({ childPanels: true, beyondWindow: true });
  const handle = h.host.open(h.spec());
  assert.equal(await handle.ready, "native");
  assert.equal(h.mounted.length, 0);
  assert.equal(h.regions.size, 0);
  const open = h.calls[0];
  assert.equal(open.method, POPOVER_OPEN_METHOD);
  assert.equal(open.args.windowId, "w1");
  assert.equal(open.args.beyondWindow, true);
  assert.equal(open.args.side, "bottom", "the screen work area has room below, so it does not flip");
  assert.equal(open.args.scale, 2);
  assert.deepEqual(open.args.content, { route: "downloads" });
  handle.update({ anchor: { x: 10, y: 10, width: 10, height: 10 } });
  await tick();
  assert.equal(h.calls[1].method, POPOVER_UPDATE_METHOD);
  handle.close();
  handle.close();
  await tick();
  assert.deepEqual(h.calls.slice(2).map((c) => c.method), [POPOVER_CLOSE_METHOD]);
  assert.deepEqual(h.dismissed, ["closed"]);
  handle.update({ anchor: { x: 0, y: 0, width: 1, height: 1 } });
  await tick();
  assert.equal(h.calls.length, 3);
});

test("a host that fails to open a panel falls back to the DOM", async () => {
  const h = harness({ childPanels: true, openFails: true });
  const handle = h.host.open(h.spec());
  assert.equal(await handle.ready, "dom");
  assert.equal(handle.mode(), "dom");
  assert.equal(h.mounted.length, 1);
  assert.equal(h.regions.size, 1);
});

test("Escape closes only the topmost popover; modified, composing or handled Escapes are ignored", () => {
  const h = harness();
  const below = h.host.open(h.spec());
  const above = h.host.open(h.spec({ nested: true }));
  for (const init of [{ shiftKey: true }, { metaKey: true }, { isComposing: true }, { key: "Enter" }]) h.key(init);
  assert.equal(h.host.openCount(), 2);
  const handled = new Event("keydown", { cancelable: true });
  Object.assign(handled, { key: "Escape" });
  handled.preventDefault();
  h.target.dispatchEvent(handled);
  assert.equal(h.host.openCount(), 2);
  const escape = h.key();
  assert.equal(escape.defaultPrevented, true);
  assert.equal(above.closed(), true);
  assert.equal(below.closed(), false);
  assert.deepEqual(h.dismissed, ["escape"]);
});

test("an outside press closes, a press inside or on an ignored anchor does not", () => {
  const anchor = { name: "anchor" };
  const h = harness();
  const handle = h.host.open(h.spec({ ignorePress: (on) => on === anchor }));
  h.press(h.mounted[0].node);
  h.press(anchor);
  assert.equal(handle.closed(), false);
  h.press({ name: "elsewhere" });
  assert.equal(handle.closed(), true);
  assert.deepEqual(h.dismissed, ["outside"]);
});

test("window blur closes DOM popovers but not native panels, which take focus themselves; resize closes both", async () => {
  const dom = harness();
  const a = dom.host.open(dom.spec());
  dom.target.dispatchEvent(new Event("blur"));
  assert.equal(a.closed(), true);
  const native = harness({ childPanels: true });
  const b = native.host.open(native.spec());
  native.target.dispatchEvent(new Event("blur"));
  assert.equal(b.closed(), false);
  native.target.dispatchEvent(new Event("resize"));
  assert.equal(b.closed(), true);
  assert.deepEqual(native.dismissed, ["resize"]);
});

test("a host dismissal closes the right panel once, ignoring stale ids, other windows and DOM popovers", async () => {
  const h = harness({ childPanels: true });
  const handle = h.host.open(h.spec());
  h.shell(POPOVER_DISMISSED_EVENT, { id: "p999", windowId: "w1" });
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "other" });
  h.shell("shell.somethingElse", { id: handle.id, windowId: "w1" });
  assert.equal(handle.closed(), false);
  await handle.ready;
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "w1", reason: "blur" });
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "w1", reason: "blur" });
  await tick();
  assert.deepEqual(h.dismissed, ["blur"]);
  assert.equal(h.calls.filter((c) => c.method === POPOVER_CLOSE_METHOD).length, 0, "the host already closed it");
  assert.equal(h.listening(), false, "listeners detach once nothing is open");
});

test("a new popover replaces an open one unless nested", () => {
  const h = harness();
  const first = h.host.open(h.spec());
  const second = h.host.open(h.spec());
  assert.equal(first.closed(), true);
  assert.equal(second.closed(), false);
  assert.deepEqual(h.dismissed, ["replaced"]);
});

test("focus returns to the element that had it, unless focus has since moved somewhere else", () => {
  const h = harness();
  const button = element("button");
  active = button;
  const handle = h.host.open(h.spec());
  active = h.mounted[0].node;
  handle.close();
  assert.equal(button.focused, 1);
  const field = element("field");
  active = button;
  const again = h.host.open(h.spec());
  active = field;
  again.close();
  assert.equal(button.focused, 1);
  const gone = element("gone");
  active = gone;
  const third = h.host.open(h.spec());
  gone.isConnected = false;
  third.close();
  assert.equal(gone.focused, 0);
});

test("a DOM popover is re-placed on update with a stale update after close ignored", () => {
  const h = harness();
  const handle = h.host.open(h.spec());
  handle.update({ anchor: { x: 100, y: 100, width: 10, height: 10 } });
  assert.equal(h.mounted[0].placements.length, 2);
  assert.equal(h.mounted[0].placements[1].side, "bottom");
  handle.close();
  handle.update({ anchor: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(h.mounted[0].placements.length, 2);
});

test("closing while the host is still opening the panel sends close once the open lands, never before", async () => {
  const h = harness({ childPanels: true, holdOpen: true });
  const handle = h.host.open(h.spec());
  await tick();
  handle.close("escape");
  await tick();
  assert.deepEqual(h.calls.map((c) => c.method), [POPOVER_OPEN_METHOD], "close is not sent ahead of the open");
  assert.equal(h.host.openCount(), 0);
  h.pendingOpens[0].resolve(null);
  assert.equal(await handle.ready, "native");
  await tick();
  assert.deepEqual(h.calls.map((c) => c.method), [POPOVER_OPEN_METHOD, POPOVER_CLOSE_METHOD]);
  assert.equal(h.calls[1].args.id, handle.id);
  assert.equal(h.calls[1].args.reason, "escape");
  assert.deepEqual(h.dismissed, ["escape"]);
});

test("updates while opening are coalesced into one update sent after the open lands", async () => {
  const h = harness({ childPanels: true, holdOpen: true });
  const handle = h.host.open(h.spec());
  for (const x of [10, 20, 30]) handle.update({ anchor: { x, y: 10, width: 10, height: 10 } });
  await tick();
  assert.deepEqual(h.calls.map((c) => c.method), [POPOVER_OPEN_METHOD]);
  h.pendingOpens[0].resolve(null);
  await handle.ready;
  await tick();
  assert.deepEqual(h.calls.map((c) => c.method), [POPOVER_OPEN_METHOD, POPOVER_UPDATE_METHOD]);
  assert.deepEqual(h.calls[1].args.anchor, { x: 30, y: 10, width: 10, height: 10 });
});

test("a host that rejects the open after a close leaves nothing behind and sends no close", async () => {
  const h = harness({ childPanels: true, holdOpen: true });
  const handle = h.host.open(h.spec());
  handle.close();
  await tick();
  h.pendingOpens[0].reject(new Error("gone"));
  await handle.ready;
  await tick();
  assert.equal(h.calls.filter((c) => c.method === POPOVER_CLOSE_METHOD).length, 0);
  assert.equal(h.mounted.length, 0);
});

test("an invoke that throws synchronously falls back to the DOM instead of leaving a dangling entry", async () => {
  const h = harness({ childPanels: true, openThrows: true });
  const handle = h.host.open(h.spec());
  assert.equal(await handle.ready, "dom");
  assert.equal(h.mounted.length, 1);
  assert.equal(h.host.openCount(), 1);
  handle.close();
  assert.equal(h.host.openCount(), 0);
  assert.equal(h.regions.size, 0);
});

test("focusing a native page closes open popovers", () => {
  const h = harness();
  const handle = h.host.open(h.spec());
  h.focusPage();
  assert.equal(handle.closed(), true);
  assert.deepEqual(h.dismissed, ["page"]);
});

test("a native child taking focus does not let window blur close its DOM parent", async () => {
  const mixed = harness({ childPanels: true });
  const domParent = mixed.host.open(mixed.spec());
  const child = mixed.host.open(mixed.spec({ nested: true }));
  await child.ready;
  mixed.target.dispatchEvent(new Event("blur"));
  assert.equal(domParent.closed(), false);
  assert.equal(child.closed(), false);
  mixed.setWindowFocused(false);
  mixed.shell(POPOVER_DISMISSED_EVENT, { id: child.id, windowId: "w1", reason: "blur" });
  assert.equal(child.closed(), true);
  assert.equal(domParent.closed(), true, "focus left the app, so the whole stack closes together");
});

test("a host dismissing a parent panel closes the children stacked above it", async () => {
  const h = harness({ childPanels: true });
  const parent = h.host.open(h.spec());
  const child = h.host.open(h.spec({ nested: true }));
  await Promise.all([parent.ready, child.ready]);
  h.shell(POPOVER_DISMISSED_EVENT, { id: parent.id, windowId: "w1", reason: "outside" });
  assert.equal(child.closed(), true);
  assert.equal(parent.closed(), true);
  await tick();
  assert.deepEqual(h.calls.filter((c) => c.method === POPOVER_CLOSE_METHOD).map((c) => c.args.id), [child.id]);
});

test("a press inside a parent closes only the popovers above it", () => {
  const h = harness();
  const parent = h.host.open(h.spec());
  const child = h.host.open(h.spec({ nested: true }));
  h.press(h.mounted[0].node);
  assert.equal(child.closed(), true);
  assert.equal(parent.closed(), false);
});

test("popover ids never repeat across adapters in one document, so a late dismissal cannot close a newer panel", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(nextPopoverId("w1"));
  assert.equal(seen.size, 50);
  const first = nextPopoverId("w1");
  const second = nextPopoverId("w1");
  assert.notEqual(first, second);
  assert.match(first, /^popover-w1-/);
});

test("focus is not restored to a hidden, inert or aria-hidden element", () => {
  assert.equal(focusableForRestore({ focus() {}, isConnected: false }), false);
  assert.equal(focusableForRestore({ focus() {}, isConnected: true, closest: () => ({}), getClientRects: () => [{}] }), false);
  assert.equal(focusableForRestore({ focus() {}, isConnected: true, closest: () => null, getClientRects: () => [] }), false);
  assert.equal(focusableForRestore({ focus() {}, isConnected: true, closest: () => null, getClientRects: () => [{}] }), true);
  const h = harness({ focusable: (node) => node.name !== "hidden" });
  const hidden = element("hidden");
  active = hidden;
  const handle = h.host.open(h.spec());
  active = h.mounted[0].node;
  handle.close();
  assert.equal(hidden.focused, 0);
  const throwing = harness({ focusable: () => { throw new Error("detached"); } });
  const button = element("button");
  active = button;
  const other = throwing.host.open(throwing.spec());
  other.close();
  assert.equal(button.focused, 0);
});

test("closing a parent directly closes every nested popover above it", async () => {
  const h = harness();
  const parent = h.host.open(h.spec());
  const child = h.host.open(h.spec({ nested: true }));
  const grandchild = h.host.open(h.spec({ nested: true }));
  parent.close();
  assert.equal(h.host.openCount(), 0);
  assert.ok(child.closed() && grandchild.closed());
  assert.deepEqual(h.dismissed, ["closed", "closed", "closed"]);
  child.close();
  assert.equal(h.dismissed.length, 3);
});

test("a host dismissal that arrives before the open is acknowledged sends no redundant close", async () => {
  const h = harness({ childPanels: true, holdOpen: true });
  const handle = h.host.open(h.spec());
  await tick();
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "w1", reason: "outside" });
  assert.equal(handle.closed(), true);
  h.pendingOpens[0].resolve(null);
  await handle.ready;
  await tick();
  assert.deepEqual(h.calls.map((c) => c.method), [POPOVER_OPEN_METHOD]);
  assert.deepEqual(h.dismissed, ["outside"]);
});

test("a DOM fallback that throws cleans up the entry and its listeners and rejects ready", async () => {
  const native = harness({ childPanels: true, openFails: true, mountThrows: true });
  const handle = native.host.open(native.spec());
  await assert.rejects(handle.ready, /mount failed/);
  assert.equal(native.host.openCount(), 0);
  assert.equal(native.listening(), false);
  assert.equal(handle.closed(), true);
  assert.equal(native.regions.size, 0);
  const dom = harness({ mountThrows: true });
  const direct = dom.host.open(dom.spec());
  await assert.rejects(direct.ready, /mount failed/);
  assert.equal(dom.host.openCount(), 0);
  assert.equal(dom.listening(), false);
});

test("the host never receives a non-finite anchor or scale", async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const h = harness({ childPanels: true, scale: bad });
    const handle = h.host.open(h.spec({ anchor: { x: bad, y: bad, width: bad, height: bad } }));
    await handle.ready;
    handle.update({ anchor: { x: bad, y: 10, width: 10, height: bad } });
    await tick();
    for (const { args } of h.calls.filter((c) => c.method !== POPOVER_CLOSE_METHOD)) {
      for (const value of [...Object.values(args.anchor), ...Object.values(args.rect), args.scale, args.arrowOffset]) assert.ok(Number.isFinite(value), JSON.stringify(args));
      assert.ok(args.scale > 0);
    }
  }
});

test("a parent whose native open fails and whose DOM fallback throws closes its nested children and detaches every listener", async () => {
  const h = harness({ childPanels: true, holdOpen: true, mountThrows: true });
  const parent = h.host.open(h.spec());
  const child = h.host.open(h.spec({ nested: true }));
  await tick();
  assert.equal(h.pendingOpens.length, 2);
  h.pendingOpens[1].resolve(null);
  await child.ready;
  h.pendingOpens[0].reject(new Error("no panel"));
  await assert.rejects(parent.ready, /mount failed/);
  assert.equal(child.closed(), true);
  assert.equal(parent.closed(), true);
  assert.equal(h.host.openCount(), 0);
  assert.equal(h.listening(), false);
  await tick();
  assert.deepEqual(h.calls.filter((c) => c.method === POPOVER_CLOSE_METHOD).map((c) => c.args.id), [child.id]);
});

test("a host dismissal that lands after a local close but before the open is acknowledged suppresses the close", async () => {
  const h = harness({ childPanels: true, holdOpen: true });
  const handle = h.host.open(h.spec());
  await tick();
  handle.close();
  assert.equal(h.host.openCount(), 0);
  assert.equal(h.listening(), true, "listeners stay while the open is in flight");
  h.shell(POPOVER_DISMISSED_EVENT, { id: handle.id, windowId: "w1", reason: "outside" });
  h.pendingOpens[0].resolve(null);
  await handle.ready;
  await tick();
  assert.deepEqual(h.calls.map((c) => c.method), [POPOVER_OPEN_METHOD]);
  assert.equal(h.listening(), false);
  assert.deepEqual(h.dismissed, ["closed"]);
});

test("Escape is heard in the bubble phase, so a control inside the popover that handles it keeps the popover open", () => {
  const h = harness();
  const registered = [];
  const add = h.target.addEventListener.bind(h.target);
  h.target.addEventListener = (type, listener, options) => {
    registered.push({ type, options });
    return add(type, listener, options);
  };
  const consumeEscape = (event) => event.preventDefault();
  add("keydown", consumeEscape);
  const handle = h.host.open(h.spec());
  const keydown = registered.find((entry) => entry.type === "keydown");
  assert.ok(keydown);
  assert.ok(!keydown.options || keydown.options === false || keydown.options.capture === false, "not a capture listener that runs before the control");
  const handled = h.key();
  assert.equal(handled.defaultPrevented, true);
  assert.equal(handle.closed(), false);
  h.target.removeEventListener("keydown", consumeEscape);
  h.key();
  assert.equal(handle.closed(), true);
  assert.deepEqual(h.dismissed, ["escape"]);
});

test("a native panel's messages reach only its own popover, and a thrown handler is contained", async () => {
  const h = harness({ childPanels: true });
  const messages = [];
  const panel = h.host.open(h.spec({ onMessage: (message) => messages.push(message) }));
  await panel.ready;
  h.shell(POPOVER_MESSAGE_EVENT, { id: panel.id, windowId: "w1", message: { type: "pick", id: "a" } });
  h.shell(POPOVER_MESSAGE_EVENT, { id: panel.id, windowId: "other", message: "wrong window" });
  h.shell(POPOVER_MESSAGE_EVENT, { id: "stale", windowId: "w1", message: "stale" });
  h.shell(POPOVER_MESSAGE_EVENT, null);
  assert.deepEqual(messages, [{ type: "pick", id: "a" }]);
  const throwing = h.host.open(h.spec({ onMessage: () => { throw new Error("handler"); } }));
  await throwing.ready;
  assert.doesNotThrow(() => h.shell(POPOVER_MESSAGE_EVENT, { id: throwing.id, windowId: "w1", message: 1 }));
  assert.equal(throwing.closed(), false);
});

test("props updates reach an open panel with its geometry, and wait for an opening one", async () => {
  const h = harness({ childPanels: true, holdOpen: true });
  const panel = h.host.open(h.spec({ content: { route: "list", props: { items: [] } } }));
  panel.update({ props: { items: [{ id: "a", title: "A" }] } });
  panel.update({ anchor: { x: 410, y: 600, width: 40, height: 20 } });
  await new Promise(setImmediate);
  assert.equal(h.calls.filter((call) => call.method === POPOVER_UPDATE_METHOD).length, 0);
  h.pendingOpens[0].resolve(null);
  await panel.ready;
  await new Promise(setImmediate);
  const queued = h.calls.filter((call) => call.method === POPOVER_UPDATE_METHOD);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].args.content, { props: { items: [{ id: "a", title: "A" }] } });
  assert.equal(queued[0].args.anchor.x, 410);
  panel.update({ anchor: { x: 420, y: 600, width: 40, height: 20 } });
  panel.update({ props: { items: [] } });
  await new Promise(setImmediate);
  const sent = h.calls.filter((call) => call.method === POPOVER_UPDATE_METHOD);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].args.content, undefined);
  assert.deepEqual(sent[2].args.content, { props: { items: [] } });
});

test("a DOM popover takes props updates in place", () => {
  const h = harness();
  const panel = h.host.open(h.spec());
  panel.update({ props: { count: 2 } });
  assert.equal(h.mounted.length, 1);
  assert.equal(h.mounted[0].placements.length, 2);
});
