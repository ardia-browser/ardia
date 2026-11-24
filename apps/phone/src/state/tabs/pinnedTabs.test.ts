import assert from "node:assert/strict";
import test from "node:test";
import { tabForRemote } from "./pinnedTabs.ts";

const tab = (id: string, url: string, extra: { profileSyncId?: string | null; pinnedKey?: string | null; lastActive?: number } = {}) => ({ id, url, profileSyncId: "work", pinnedKey: null, lastActive: 1, ...extra });

test("a pinned tile finds the tab it opened after the page has moved off the pinned address", () => {
  const open = [tab("a", "https://example.com/"), tab("m", "https://music.apple.com/new", { pinnedKey: "music" })];
  assert.deepEqual(tabForRemote(open, "https://music.apple.com/", "work", "music"), { tab: open[1], how: "movedOn" });
});

test("it finds its tab on the pinned address too, and the newest when two carry the key", () => {
  const open = [tab("old", "https://music.apple.com/", { pinnedKey: "music", lastActive: 1 }), tab("new", "https://music.apple.com/", { pinnedKey: "music", lastActive: 5 })];
  assert.deepEqual(tabForRemote(open, "https://music.apple.com/", "work", "music"), { tab: open[1], how: "tied" });
});

test("a tile's tab belongs to its space: the same key in another space is another tile", () => {
  const open = [tab("m", "https://music.apple.com/new", { pinnedKey: "music", profileSyncId: "home" })];
  assert.equal(tabForRemote(open, "https://music.apple.com/", "work", "music"), null);
});

test("with no tab of its own, a tile takes an untied tab on its address, and never another tile's tab", () => {
  const free = [tab("f", "https://music.apple.com/")];
  assert.deepEqual(tabForRemote(free, "https://music.apple.com/", "work", "music"), { tab: free[0], how: "sameAddress" });
  const taken = [tab("t", "https://music.apple.com/", { pinnedKey: "other" })];
  assert.equal(tabForRemote(taken, "https://music.apple.com/", "work", "music"), null);
});

test("a row with no key, a Mac's open tab or a history row, still matches by address, whatever tile the tab came from", () => {
  const open = [tab("m", "https://music.apple.com/", { pinnedKey: "music" }), tab("n", "https://music.apple.com/new")];
  assert.deepEqual(tabForRemote(open, "https://music.apple.com/", "work", null), { tab: open[0], how: "sameAddress" });
  assert.equal(tabForRemote(open, "https://music.apple.com/gone", "work", null), null);
});
