import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
globalThis.require ??= (id) => ({ asset: id });
const stub = await import("../../test-native/index.ts");
const { BarField } = await import("./BarField.tsx");

const field = (tag, watchBlurs) =>
  mount(() => BarField({ inputRef: { current: { _nativeTag: tag } }, focusEcho: { current: false }, onSelection() {}, variant: "panel", floating: false, scope: null, incognito: false, watchBlurs, value: "" }));

test("the command bar's native field is watched while mounted, and a swapped-in field takes the watch over", () => {
  stub.watchedFieldBlurs.clear();
  const toolbar = field(41, true);
  assert.deepEqual([...stub.watchedFieldBlurs], [41]);
  toolbar.unmount();
  const sidebar = field(42, true);
  assert.deepEqual([...stub.watchedFieldBlurs], [42], "moving the open address bar between the toolbar and the sidebar mounts a new native field");
  sidebar.unmount();
  assert.deepEqual([...stub.watchedFieldBlurs], []);
});

test("a field without a cancel, like the New Tab page's hero bar, is never watched", () => {
  stub.watchedFieldBlurs.clear();
  const hero = field(43, false);
  assert.deepEqual([...stub.watchedFieldBlurs], []);
  hero.unmount();
});
