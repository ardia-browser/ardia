import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
globalThis.require ??= (id) => ({ asset: id });
await import("../../test-native/index.ts");
const { Animated } = await import("react-native");
const { useBrowser } = await import("../../state/browser/store.ts");
const { NextMeetingBadge } = await import("./NextMeetingBadge.tsx");

test("a tile with no meeting to count down to starts no animation, so launch springs nothing per pinned tile", (t) => {
  const spring = Animated.spring;
  let springs = 0;
  Animated.spring = (value, config) => (springs++, spring(value, config));
  t.after(() => {
    Animated.spring = spring;
  });
  useBrowser.getState().hydrate({});
  const w = useBrowser.getState().createWindow({ url: "https://a.example/" });
  const tabId = useBrowser.getState().windows[w].tabIds[0];
  const badge = mount(() => NextMeetingBadge.type ? NextMeetingBadge.type({ tabId }) : NextMeetingBadge({ tabId }));
  t.after(() => badge.unmount());
  assert.equal(badge.value, null);
  badge.rerender();
  assert.equal(springs, 0);
});
