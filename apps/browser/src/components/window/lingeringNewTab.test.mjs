import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { useBrowser } from "../../state/browser/store.ts";
import { activeTabId } from "../../state/browser/model.ts";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures.ts";
import { PAGE_STACKING } from "../../lib/pageStacking.ts";
import { PAGE_STACKING as DESKTOP_STACKING } from "../../lib/pageStacking.desktop.ts";
import { usePaneLayout } from "./usePaneLayout.ts";

const S = () => useBrowser.getState();
const SIZE = { width: 1200, height: 800 };
const macFeatures = { waits: PLATFORM_FEATURES.newTabWaitsForFirstFrame, holds: PLATFORM_FEATURES.holdsColdPagesUntilPainted };
const shellAbovePages = PAGE_STACKING.shellAbovePages;
const mounted = [];

PLATFORM_FEATURES.newTabWaitsForFirstFrame = true;
PLATFORM_FEATURES.holdsColdPagesUntilPainted = false;
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  PAGE_STACKING.shellAbovePages = shellAbovePages;
});
after(() => {
  PLATFORM_FEATURES.newTabWaitsForFirstFrame = macFeatures.waits;
  PLATFORM_FEATURES.holdsColdPagesUntilPainted = macFeatures.holds;
});

function newTabThenPage() {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://github.com/" });
  const page = S().windows[windowId].tabIds[0];
  const newTab = S().newTab(windowId);
  return { windowId, page, newTab };
}

function newTabThenOtherProfilesPage() {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://github.com/" });
  const page = S().windows[windowId].tabIds[0];
  const personal = S().windows[windowId].profileId;
  const tmp = S().createProfile({ name: "Tmp 2" });
  S().switchProfile(windowId, tmp);
  const newTab = activeTabId(S(), windowId);
  assert.equal(S().tabs[newTab].url, "", "Tmp 2 opens on a New Tab");
  return { windowId, page, newTab, personal };
}

function card(windowId) {
  const hook = mount(() => usePaneLayout(windowId, activeTabId(S(), windowId), undefined, undefined, SIZE, 0));
  mounted.push(hook);
  return hook;
}

const shownTabs = (layout) => layout.shown.map((key) => key.slice(0, key.indexOf("|")));

const switches = [
  { name: "a tab switch", setup: newTabThenPage, leave: ({ page }) => S().activate(page) },
  { name: "a profile switch", setup: newTabThenOtherProfilesPage, leave: ({ windowId, personal }) => S().switchProfile(windowId, personal) },
];

test("every desktop WebUI build draws its shell above the native pages, and the React Native Mac does not", () => {
  assert.equal(DESKTOP_STACKING.shellAbovePages, true);
  assert.equal(shellAbovePages, false);
});

for (const { name, setup, leave } of switches) {
  test(`WebUI: ${name} away from a New Tab leaves no New Tab pane painted over the incoming page`, () => {
    PAGE_STACKING.shellAbovePages = true;
    const tabs = setup();
    const hook = card(tabs.windowId);
    assert.equal(hook.value.lingerId, undefined);
    leave(tabs);
    const layout = hook.rerender();
    assert.equal(activeTabId(S(), tabs.windowId), tabs.page, "the switch lands on the page");
    assert.equal(layout.lingerId, undefined, "no New Tab lingers over the page");
    assert.equal(layout.lingerRect, undefined);
    assert.ok(!shownTabs(layout).includes(tabs.newTab), "the New Tab's pane is gone on the first switched frame");
    assert.deepEqual(Object.keys(layout.panes), [tabs.page]);
  });

  test(`React Native Mac: ${name} away from a New Tab still holds it under the page's first frame`, () => {
    PAGE_STACKING.shellAbovePages = false;
    const tabs = setup();
    const hook = card(tabs.windowId);
    leave(tabs);
    const layout = hook.rerender();
    assert.equal(layout.lingerId, tabs.newTab, "the native page sinks the New Tab until it paints");
    assert.deepEqual(layout.lingerRect, { x: 0, y: 0, ...SIZE });
    assert.ok(shownTabs(layout).includes(tabs.newTab));
  });
}

test("a profile switch closes the New Tab bar left open over the outgoing New Tab", () => {
  const { windowId, personal } = newTabThenOtherProfilesPage();
  S().openPanel(windowId, "", { kind: "list" });
  assert.equal(S().windowUi[windowId].panel.open, true);
  S().switchProfile(windowId, personal);
  assert.equal(S().windowUi[windowId].panel.open, false);
  assert.equal(S().windowUi[windowId].panel.newTab, undefined);
});
