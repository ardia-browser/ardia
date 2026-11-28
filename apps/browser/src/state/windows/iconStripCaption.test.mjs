import assert from "node:assert/strict";
import { test } from "node:test";
const { iconStripTop, windowControlsPlace, windowControlsBottom, cardTopInset } = await import("./layout.ts");
const { ICON_STRIP } = await import("../../lib/windowLayout.ts");
const { parseButtonLayout } = await import("../../lib/windowButtonLayout.ts");
const windows = (await import("../../lib/platformChrome.windows.ts")).WINDOW_CHROME;
const mac = (await import("../../lib/platformChrome.ts")).WINDOW_CHROME;
const linux = await import("../../lib/platformChrome.desktop.ts");

const WIDTH = 1000;
function state(settings = {}) {
  return {
    windows: { w: { id: "w", kind: "main", profileId: "p", fullScreen: false } },
    windowOrder: ["w"],
    ui: { focusOrder: ["w"] },
    profiles: { p: { id: "p", name: "Personal" } },
    profileOrder: ["p"],
    downloads: [],
    windowUi: {},
    settings: { pageFrame: 9, tabLayout: "sidebar", sidebarSide: "right", addressBar: "toolbar", compactToolbar: false, hideToolbarWhileScrolling: false, autoHideTabs: true, collapsedSidebar: "icons", sidebarWidth: 190, ...settings },
  };
}

const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

function firstIconUnderControls(s, chrome) {
  const top = iconStripTop(s, "w", 9, chrome);
  const right = s.settings.sidebarSide === "right";
  const icon = right ? [WIDTH - 38, top, WIDTH - 8, top + ICON_STRIP.square] : [8, top, 38, top + ICON_STRIP.square];
  const place = windowControlsPlace(s, "w", 9, chrome);
  if (!place || !chrome.trailingWidth) return 0;
  const buttons = [WIDTH - chrome.trailingWidth, place.centerY - place.size / 2, WIDTH, windowControlsBottom(place)];
  return overlap(icon, buttons);
}

test("with icons on the right, no strip icon sits under the Windows or Linux caption buttons, in every toolbar layout", () => {
  const both = linux.nativeButtonsChrome(parseButtonLayout("close:minimize,maximize"));
  const rightOnly = linux.nativeButtonsChrome(parseButtonLayout(":minimize,maximize,close"));
  for (const chrome of [windows, both, rightOnly])
    for (const settings of [{}, { addressBar: "sidebar" }, { compactToolbar: true }, { minimalismMode: true }, { pageFrame: 0 }]) {
      const s = state(settings);
      assert.equal(firstIconUnderControls(s, chrome), 0, JSON.stringify(settings));
      const place = windowControlsPlace(s, "w", 9, chrome);
      if (place) assert.ok(iconStripTop(s, "w", 9, chrome) >= windowControlsBottom(place), "the rail starts below the buttons");
    }
});

test("on the left, and on a Mac either side, the rail starts at the card's top edge: those buttons ride with the sidebar", () => {
  for (const chrome of [windows, mac, linux.nativeButtonsChrome(parseButtonLayout("close,minimize,maximize:"))]) {
    const s = state({ sidebarSide: "left" });
    assert.equal(iconStripTop(s, "w", 9, chrome), cardTopInset(s, "w", 9, chrome));
  }
  assert.equal(iconStripTop(state(), "w", 9, mac), cardTopInset(state(), "w", 9, mac));
});
