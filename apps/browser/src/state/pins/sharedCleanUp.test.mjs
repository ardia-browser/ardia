import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { clearedTabIds } = await import("./tabCleanup.ts");
const { setLive } = await import("../tabs/tabLive.ts");
const { holderOfPage } = await import("../tabs/pageSession.ts");

const S = () => useBrowser.getState();

test("clearing a window keeps the shared copy of a tab that plays sound in another window", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "https://start.com/" });
  const song = S().newTab(a, { url: "https://music.com/" });
  S().newTab(a, { url: "https://other.com/" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: "https://b.com/" });
  const copy = Object.values(S().tabs).find((t) => t.windowId === b && t.pinKey === song);
  assert.ok(copy, "the second window lists a copy of the tab");
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [copy.id]: { ...s.tabs[copy.id], page: { kind: "frozen", holderId: song } } } }));
  assert.equal(holderOfPage(S().tabs[copy.id]), song);
  setLive(song, { playingAudio: true });
  assert.ok(!clearedTabIds(S(), b).includes(copy.id), "the playing tab's copy isn't cleared");
});
