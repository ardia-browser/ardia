import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const { useBrowser } = await import("../../state/browser/store.ts");
const { WindowContext } = await import("../../state/browser/hooks.ts");
const { HeaderAppMenu, ProfileIndicator, profileIndicatorX, sidebarProfileRow, useAppMenuInHeader, useProfileIndicatorWidth } = await import("./ProfileIndicator.tsx");

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

test("in full screen the sidebar header centres the profile name at every sidebar width, with or without Downloads beside it (#4680)", () => {
  for (const width of [150, 205, 260, 390, 480]) {
    for (const downloadsRoom of [0, 30]) {
      const row = sidebarProfileRow({ width, fullScreen: true, edge: 12, captionRoom: 0, downloadsRoom });
      assert.equal(row.centered, true);
      const chip = Math.min(row.room, 60);
      const freeLeft = row.left;
      const freeRight = width - row.right - downloadsRoom;
      const chipLeft = freeLeft + (freeRight - freeLeft - chip) / 2;
      assert.equal(chipLeft + chip / 2, width / 2, `width ${width}, downloads ${downloadsRoom}`);
      assert.equal(row.room, width - 2 * (12 + downloadsRoom));
    }
  }
});

test("outside full screen the profile name still starts right of the traffic lights, as Dia's header stack places it", () => {
  for (const width of [205, 390]) {
    const row = sidebarProfileRow({ width, fullScreen: false, edge: 12, captionRoom: 0, downloadsRoom: 30 });
    assert.deepEqual(row, { left: profileIndicatorX(), right: 12, room: width - profileIndicatorX() - 12 - 30, centered: false });
  }
});

test("a full-screen header never hands the name negative room on a very narrow sidebar", () => {
  assert.equal(sidebarProfileRow({ width: 40, fullScreen: true, edge: 12, captionRoom: 0, downloadsRoom: 30 }).room, 0);
});
