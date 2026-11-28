import assert from "node:assert/strict";
import { test } from "node:test";
import { followShownPage, shownPageId } from "./shownPage.ts";

function fakeStore() {
  const listeners = new Set<() => void>();
  return { subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)), emit: () => listeners.forEach((listener) => listener()) };
}

test("the page counts as shown only on the browsing surface, uncovered, with the app active and no voice overlay", () => {
  const front = { appActive: true, surface: "browsing", covered: false, voice: false, sidebar: false, selectedId: "a" } as const;
  assert.equal(shownPageId(front), "a");
  assert.equal(shownPageId({ ...front, voice: true }), null);
  assert.equal(shownPageId({ ...front, covered: true }), null);
  assert.equal(shownPageId({ ...front, surface: "deck" }), null);
  assert.equal(shownPageId({ ...front, appActive: false }), null);
  assert.equal(shownPageId({ ...front, selectedId: null }), null);
});

test("the Duo's sidebar over the card takes the page out of front", () => {
  const front = { appActive: true, surface: "browsing", covered: false, voice: false, sidebar: false, selectedId: "a" } as const;
  assert.equal(shownPageId({ ...front, sidebar: true }), null);
});

test("the shown page is pushed once at start and again only when it changes", () => {
  const store = fakeStore();
  let shown: string | null = "a";
  const pushed: (string | null)[] = [];
  const follow = followShownPage(() => shown, (id) => pushed.push(id), [store]);
  store.emit();
  shown = null;
  store.emit();
  store.emit();
  shown = "b";
  follow.report();
  assert.deepEqual(pushed, ["a", null, "b"]);
  follow.stop();
  shown = "c";
  store.emit();
  assert.deepEqual(pushed, ["a", null, "b"]);
});
