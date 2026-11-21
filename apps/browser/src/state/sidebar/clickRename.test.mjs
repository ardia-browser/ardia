import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

globalThis.renameStarts = [];
const stubs = {
  "./actions": "export const startRename = async (windowId, target) => void globalThis.renameStarts.push(target.id);",
};
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/sidebar/clickRename.ts") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

mock.timers.enable({ apis: ["setTimeout"] });
const { useBrowser } = await import("../browser/store.ts");
const { setSidebarUi } = await import("./sidebarUi.ts");
const { armClickRename, cancelClickRename, clickRename, CLICK_RENAME_DELAY_MS } = await import("./clickRename.ts");

const S = () => useBrowser.getState();
const plain = { nativeEvent: {} };
let clock = 0;

function pinnedPair() {
  S().hydrate({});
  setSidebarUi({ renaming: null });
  globalThis.renameStarts = [];
  const w = S().createWindow({ url: "https://a.com/" });
  const [shown] = S().windows[w].tabIds;
  const other = S().newTab(w, { url: "https://b.com/", background: true });
  S().updateTab(shown, { pin: { as: "row" } });
  S().updateTab(other, { pin: { as: "row" } });
  clock += 10_000;
  return { w, shown, other };
}

function click(w, id, event = plain, windowKey = true) {
  armClickRename(w, id);
  clickRename(w, id, event, windowKey, clock);
}

test("one plain click on the shown pinned tab starts renaming it after the pause", () => {
  const { w, shown } = pinnedPair();
  click(w, shown);
  mock.timers.tick(CLICK_RENAME_DELAY_MS - 1);
  assert.deepEqual(globalThis.renameStarts, []);
  mock.timers.tick(1);
  assert.deepEqual(globalThis.renameStarts, [shown]);
});

test("a click on a pinned tab that wasn't shown only switches to it", () => {
  const { w, other } = pinnedPair();
  click(w, other);
  mock.timers.tick(CLICK_RENAME_DELAY_MS);
  assert.deepEqual(globalThis.renameStarts, []);
});

test("a double-click, a modified click, a click that focuses the window or a press before the pause ends starts no click rename", () => {
  const { w, shown } = pinnedPair();
  click(w, shown);
  clock += 200;
  click(w, shown);
  cancelClickRename();
  mock.timers.tick(CLICK_RENAME_DELAY_MS);
  clock += 10_000;
  click(w, shown, { nativeEvent: { metaKey: true } });
  clock += 10_000;
  click(w, shown, plain, false);
  clock += 10_000;
  click(w, shown);
  armClickRename(w, shown);
  mock.timers.tick(CLICK_RENAME_DELAY_MS);
  assert.deepEqual(globalThis.renameStarts, []);
});

test("an unpinned tab, a tab switched away from or a rename already open is left alone", () => {
  const { w, shown, other } = pinnedPair();
  S().updateTab(shown, { pin: null });
  click(w, shown);
  mock.timers.tick(CLICK_RENAME_DELAY_MS);
  S().updateTab(shown, { pin: { as: "row" } });
  clock += 10_000;
  click(w, shown);
  S().activate(other);
  mock.timers.tick(CLICK_RENAME_DELAY_MS);
  S().activate(shown);
  clock += 10_000;
  click(w, shown);
  setSidebarUi({ renaming: { windowId: w, kind: "tab", id: other } });
  mock.timers.tick(CLICK_RENAME_DELAY_MS);
  assert.deepEqual(globalThis.renameStarts, []);
});
