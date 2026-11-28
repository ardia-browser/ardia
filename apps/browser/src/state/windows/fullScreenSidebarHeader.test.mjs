import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { collapsedSidebarHeader, downloadsInSidebarFooter, pageFrameIn, sidebarHeaderCollapsed } = await import("./layout.ts");
const { toolbarLightsCenter } = await import("./dockMotion.ts");
const { listTopGap, sidebarHeaderOf, toolbarEdgeLift } = await import("../../components/sidebar/geometry.ts");
const { toolbarRowOf } = await import("../../lib/toolbarRow.ts");
const { HIDDEN_BUTTONS_CHROME } = await import("../../lib/platformChrome.desktop.ts");

const S = () => useBrowser.getState();

function headerOf(windowId) {
  const frame = pageFrameIn(S(), windowId);
  const lightsY = toolbarLightsCenter(S().settings.compactToolbar, frame)[1];
  return sidebarHeaderCollapsed(S(), windowId) ? collapsedSidebarHeader(frame) : sidebarHeaderOf(false, lightsY, false);
}

const firstPinnedTop = (windowId) => headerOf(windowId) + listTopGap(false);

function browserWindow(settings = {}) {
  S().hydrate({});
  S().updateSettings(settings);
  return S().createWindow({ url: "a.com" });
}

test("a Mac window in full screen has no lights, so the pinned tabs move up into their band", () => {
  for (const settings of [{}, { compactToolbar: true }, { pageFrame: 0 }, { pageFrameZeroInFullScreen: true }, { autoHideTabs: true }]) {
    const label = JSON.stringify(settings);
    const w = browserWindow(settings);
    const windowed = firstPinnedTop(w);
    assert.equal(sidebarHeaderCollapsed(S(), w), false, `${label}: windowed, the header holds the traffic lights`);
    assert.equal(downloadsInSidebarFooter(S(), w), false, `${label}: windowed, downloads stay beside the lights`);
    S().setWindowFullScreen(w, true);
    assert.equal(sidebarHeaderCollapsed(S(), w), true, `${label}: full screen keeps the empty band, pinned tabs still start at ${firstPinnedTop(w)} pt (windowed ${windowed} pt)`);
    assert.equal(firstPinnedTop(w), collapsedSidebarHeader(pageFrameIn(S(), w)) + listTopGap(false), label);
    assert.ok(firstPinnedTop(w) < windowed, label);
    assert.equal(downloadsInSidebarFooter(S(), w), true, `${label}: the download button leaves the band for the sidebar's footer`);
    S().setWindowFullScreen(w, false);
    assert.equal(sidebarHeaderCollapsed(S(), w), false, `${label}: back in a window the band returns`);
    assert.equal(downloadsInSidebarFooter(S(), w), false, label);
    assert.equal(firstPinnedTop(w), windowed, label);
  }
});

test("the sidebar's scroll line meets the toolbar's in a window, and stays at the list's top once the band is gone", () => {
  const w = browserWindow();
  const lift = () => toolbarEdgeLift(headerOf(w), pageFrameIn(S(), w), toolbarRowOf(S().settings.compactToolbar));
  assert.equal(lift(), 3);
  S().setWindowFullScreen(w, true);
  assert.equal(lift(), 0);
});

test("a full screen sidebar header that holds something stays, with its download button", () => {
  const kept = (settings, arrange, why, footer = false) => {
    const w = browserWindow(settings);
    arrange();
    S().setWindowFullScreen(w, true);
    assert.equal(sidebarHeaderCollapsed(S(), w), false, why);
    assert.equal(downloadsInSidebarFooter(S(), w), footer, why);
  };
  const nothing = () => {};
  kept({}, () => void S().createProfile({ name: "Work" }), "the profile indicator");
  kept({ addressBar: "sidebar" }, nothing, "the sidebar button and the navigation buttons", true);
  kept({ sidebarSide: "right" }, nothing, "a right sidebar keeps its header");
  kept({ tabLayout: "top" }, nothing, "top tabs have no sidebar header to collapse");
  const incognito = S().createWindow({ kind: "private", url: "a.com" });
  S().setWindowFullScreen(incognito, true);
  assert.equal(sidebarHeaderCollapsed(S(), incognito), false, "the incognito indicator");
  const little = S().createWindow({ kind: "small", url: "a.com" });
  S().setWindowFullScreen(little, true);
  assert.equal(sidebarHeaderCollapsed(S(), little), false, "Little Ardia has no sidebar");
  assert.equal(downloadsInSidebarFooter(S(), little), false, "Little Ardia has no sidebar footer for its downloads");
});

test("with the window buttons hidden there was never a band to give up", () => {
  const w = browserWindow();
  S().setWindowFullScreen(w, true);
  assert.equal(sidebarHeaderCollapsed(S(), w, HIDDEN_BUTTONS_CHROME), false);
});
