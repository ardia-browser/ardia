import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

globalThis.__DEV__ = false;
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { mount } = await import("../../test-hooks.mjs");
const { noteMenuShortcuts, preparePane, readMenuShortcuts, shortcutItems } = await import("./paneData.ts");
const { cached, load, useResource } = await import("./resources.ts");
const { menuBarRevision, setMenuBarShortcuts } = await import("../commands/commandShortcuts.ts");

const menus = shellNativeModules.ArdiaMenus;
const original = menus.menuShortcuts;
afterEach(() => {
  menus.menuShortcuts = original;
});

const NEW_TAB = { id: "newTab", title: "New Tab", path: ["File"], remappable: false, key: "t", modifiers: ["command"] };
const RELOAD = { id: "reload", title: "Reload This Page", path: ["View"], remappable: true };
const menuList = () => [NEW_TAB, RELOAD].map((item) => ({ ...item }));
const settle = () => new Promise((done) => setTimeout(done, 0));

function offer(list) {
  const asked = { calls: 0 };
  menus.menuShortcuts = () => {
    asked.calls++;
    return Promise.resolve(list().map((item) => ({ ...item })));
  };
  return asked;
}

test("switching to the Shortcuts pane after the window prefetched it does not ask the Mac for the menu bar again", async () => {
  const asked = offer(menuList);
  await preparePane("shortcuts", null);
  const listed = cached(shortcutItems, []);
  const revision = menuBarRevision();
  const callsBefore = asked.calls;

  const pane = mount(() => useResource(shortcutItems));
  await settle();

  assert.equal(asked.calls, callsBefore, `menuShortcuts calls ${callsBefore} -> ${asked.calls}`);
  assert.equal(menuBarRevision(), revision, `menu bar revision ${revision} -> ${menuBarRevision()}`);
  assert.equal(cached(shortcutItems, []), listed);
  assert.deepEqual(pane.value[0].map((item) => item.id), ["newTab", "reload"]);
  pane.unmount();
});

test("a failed read leaves an empty list, so opening the pane asks the Mac again", async () => {
  menus.menuShortcuts = () => Promise.reject(new Error("the menu walk failed"));
  await load(shortcutItems, [], { fresh: true });
  assert.deepEqual(cached(shortcutItems, []), []);

  const asked = offer(menuList);
  const pane = mount(() => useResource(shortcutItems));
  await settle();
  assert.equal(asked.calls, 1);
  assert.deepEqual(cached(shortcutItems, []).map((item) => item.id), ["newTab", "reload"]);
  pane.unmount();
});

test("a menu bar offered again with the same shortcuts leaves the revision alone, and a changed one bumps it", () => {
  setMenuBarShortcuts(menuList());
  const revision = menuBarRevision();
  setMenuBarShortcuts(menuList());
  assert.equal(menuBarRevision(), revision);

  const moved = menuList();
  moved[0].key = "n";
  setMenuBarShortcuts(moved);
  assert.equal(menuBarRevision(), revision + 1);

  setMenuBarShortcuts(moved.slice(1));
  assert.equal(menuBarRevision(), revision + 2);
});

test("the menu sync keeps the Settings list current without a second read, and keeps the list it has when nothing changed", async () => {
  const asked = offer(menuList);
  await load(shortcutItems, [], { fresh: true });
  const listed = cached(shortcutItems, []);
  const revision = menuBarRevision();

  noteMenuShortcuts(menuList(), null);
  assert.equal(cached(shortcutItems, []), listed);
  assert.equal(menuBarRevision(), revision);

  const extension = { id: "openExtension:x", title: "X", path: ["Extensions"], remappable: true };
  noteMenuShortcuts([...menuList(), extension], null);
  assert.deepEqual(cached(shortcutItems, []).map((item) => item.id), ["newTab", "reload", "openExtension:x"]);
  assert.equal(menuBarRevision(), revision + 1);

  const pane = mount(() => useResource(shortcutItems));
  await settle();
  assert.equal(asked.calls, 1);
  assert.deepEqual(pane.value[0].map((item) => item.id), ["newTab", "reload", "openExtension:x"]);
  pane.unmount();
});

test("a Settings read that finishes after the menu sync stored a newer list changes neither that list nor the menu bar", async () => {
  let finish = () => {};
  menus.menuShortcuts = () => new Promise((done) => (finish = done));
  const stale = load(shortcutItems, [], { fresh: true });

  const added = { id: "openExtension:y", title: "Y", path: ["Extensions"], remappable: true };
  const newer = [...menuList(), added];
  noteMenuShortcuts(newer, null);
  const listed = cached(shortcutItems, []);
  const revision = menuBarRevision();

  finish(menuList());
  await stale;
  assert.equal(cached(shortcutItems, []), listed, "the stale read left the newer list in the cache");
  assert.equal(menuBarRevision(), revision, `the stale read changed the menu bar: revision ${revision} -> ${menuBarRevision()}`);
  setMenuBarShortcuts(newer);
  assert.equal(menuBarRevision(), revision, "the menu bar still holds the newer list");
});

test("a menu sync whose read fails leaves the held list outdated, so opening the pane reads it again", async () => {
  offer(menuList);
  await load(shortcutItems, [], { fresh: true });
  const held = cached(shortcutItems, []);

  menus.menuShortcuts = () => Promise.reject(new Error("the menu walk failed"));
  assert.equal(await readMenuShortcuts(Promise.resolve(), null), false);
  assert.equal(cached(shortcutItems, []), held);

  const added = { id: "openExtension:z", title: "Z", path: ["Extensions"], remappable: true };
  const asked = offer(() => [...menuList(), added]);
  const pane = mount(() => useResource(shortcutItems));
  await settle();
  assert.equal(asked.calls, 1, `menuShortcuts calls 0 -> ${asked.calls}`);
  assert.deepEqual(pane.value[0].map((item) => item.id), ["newTab", "reload", "openExtension:z"]);
  pane.unmount();

  const again = mount(() => useResource(shortcutItems));
  await settle();
  assert.equal(asked.calls, 1, "the list read after the failed sync is current, so the next visit reuses it");
  again.unmount();
});

test("a menu sync whose read succeeds leaves the list current, so opening the pane does not read again", async () => {
  const asked = offer(menuList);
  await load(shortcutItems, [], { fresh: true });
  const extension = { id: "openExtension:w", title: "W", path: ["Extensions"], remappable: true };
  const sync = offer(() => [...menuList(), extension]);
  assert.equal(await readMenuShortcuts(Promise.resolve(), null), true);
  assert.equal(sync.calls, 1);

  const pane = mount(() => useResource(shortcutItems));
  await settle();
  assert.equal(sync.calls, 1, `menuShortcuts calls 1 -> ${sync.calls}`);
  assert.deepEqual(pane.value[0].map((item) => item.id), ["newTab", "reload", "openExtension:w"]);
  assert.equal(asked.calls, 1);
  pane.unmount();
});
