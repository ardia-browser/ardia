import assert from "node:assert/strict";
import { test } from "node:test";
const { socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round9-test");

const { call, ok } = socketClient(40);

const row = (title) => ({ path: [0], title, enabled: true, checked: false, separator: false });

function unprovenMenus(windowId, tab) {
  return [
    { id: "live1", kind: "page", tab, window: windowId, items: [row("Copy")] },
    { id: "sel1", kind: "select", tab, window: windowId, items: [row("apple")] },
    { id: "app1", kind: "app", window: windowId, items: [row("Copy Recovery Code")] },
    { id: "bar1", kind: "menuBar", window: windowId, items: [row("Quit Ardia")] },
    { id: "wk1", kind: "other", window: windowId, items: [row("Look Up")] },
  ];
}

test("any menu that isn't a captured background menu answers exactly as a random id does", async () => {
  const { windowId, tab } = await freshWindow();
  const menus = unprovenMenus(windowId, tab);
  stub.surfaces.open = menus;
  stub.surfaces.dismissed.length = 0;
  for (const method of ["menus.choose", "menus.dismiss"]) {
    const params = (menu) => (method === "menus.choose" ? { menu, path: [0] } : { menu });
    const unknown = await call(method, params("nobody-has-this-id"));
    assert.equal(unknown.error?.code, "no_window", method);
    for (const menu of menus) {
      const reply = await call(method, params(menu.id));
      assert.deepEqual(reply.error, unknown.error, `${method} ${menu.id}`);
    }
  }
  assert.deepEqual(stub.surfaces.dismissed, []);
});

test("a menu whose items target an unknown class is neither listed nor announced", async () => {
  const { windowId, tab } = await freshWindow();
  await ok("subscribe", { events: ["menu.opened"] });
  stub.controlSocket.broadcasts.length = 0;
  stub.surfaces.open = unprovenMenus(windowId, tab);
  assert.deepEqual(await ok("menus.open"), []);
  for (const menu of unprovenMenus(windowId, tab)) {
    stub.surfaces.emit({ type: "menuOpened", ...menu });
    stub.surfaces.emit({ type: "menuDropped", id: menu.id, kind: menu.kind });
  }
  assert.deepEqual(stub.controlSocket.broadcasts.map((b) => JSON.parse(b.line).event), []);
  await ok("subscribe", { events: [] });
});

test("menu.closed isn't an event: nothing native sends a close, so it can't be subscribed and the menu feed keeps no announced ids to lose", async () => {
  const { AUTOMATION_EVENTS } = await import("./eventNames.ts");
  assert.equal(AUTOMATION_EVENTS.includes("menu.closed"), false);
  const reply = await call("subscribe", { events: ["menu.opened", "menu.closed"] });
  assert.equal(reply.error?.code, "bad_request", JSON.stringify(reply));
});
