import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const { useBrowser } = await import("../../state/browser/store.ts");
const { WindowContext } = await import("../../state/browser/hooks.ts");
const { HeaderAppMenu, ProfileIndicator, useAppMenuInHeader, useProfileIndicatorWidth } = await import("./ProfileIndicator.tsx");

const S = () => useBrowser.getState();

function windowWithTwoProfiles() {
  S().hydrate({
    profiles: {
      default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
      work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 },
    },
    profileOrder: ["default", "work"],
  });
  return S().createWindow({ url: "https://indicator.ardia.test/" });
}

const rendered = (windowId, render) => {
  const mounted = mount(render, { contexts: [[WindowContext, windowId]] });
  try {
    return mounted.value;
  } finally {
    mounted.unmount();
  }
};

test("with the profile part hidden the shared indicator draws nothing and takes no room, so the Mac and Windows headers stay as they were", () => {
  const windowId = windowWithTwoProfiles();
  assert.notEqual(rendered(windowId, () => ProfileIndicator({ room: 160 })), null, "two profiles show the indicator");
  assert.ok(rendered(windowId, () => useProfileIndicatorWidth(160)) > 0);
  assert.equal(rendered(windowId, () => ProfileIndicator({ room: 160, profileShown: false })), null);
  assert.equal(rendered(windowId, () => useProfileIndicatorWidth(160, false)), 0);
});

test("the shared header keeps no app menu of its own: only Linux draws one there", () => {
  const windowId = windowWithTwoProfiles();
  assert.equal(rendered(windowId, () => useAppMenuInHeader()), false);
  assert.equal(HeaderAppMenu({ size: 28 }), null);
});
