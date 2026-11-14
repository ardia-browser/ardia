import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { pressables } = await import("react-native");
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });
const { windows } = await import("../../test-native/shell.ts");
const client = await import("../../state/telemetry/client.ts");
const usage = await import("../../state/telemetry/usage.ts");
const { useBrowser } = await import("../../state/browser/store.ts");
const { useSettingsNav, SETTINGS_WINDOW_ID } = await import("../../state/settings/settingsWindows.ts");
const { SiteExtensions } = await import("./SiteExtensions.tsx");

const S = () => useBrowser.getState();
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

function workWindowBehindDefaultWindow() {
  S().hydrate({});
  const work = S().createProfile({ name: "Work", shareWith: "default" });
  const workWindow = S().createWindow({ profileId: work });
  const defaultWindow = S().createWindow();
  assert.equal(S().ui.focusOrder[0], defaultWindow);
  return { work, workWindow, tabId: S().windows[workWindow].tabIds[0] };
}

function renderPanel(windowId, tabId, onClose) {
  const initial = useBrowser.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, S());
  pressables.length = 0;
  try {
    renderToStaticMarkup(React.createElement(SiteExtensions, { windowId, tabId, columns: 4, onClose }));
  } finally {
    Object.assign(initial, saved);
  }
  return (label) => pressables.find((p) => p.accessibilityLabel === label);
}

test("the Extensions header has a visible Manage button that closes the panel, then opens Settings › Extensions for the panel window's profile", async () => {
  const { work, workWindow, tabId } = workWindowBehindDefaultWindow();
  client.setSharing(true, "onboarding");
  windows.open.delete(SETTINGS_WINDOW_ID);
  useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  const events = [];
  const pressable = renderPanel(workWindow, tabId, () => events.push(windows.open.has(SETTINGS_WINDOW_ID) ? "close after open" : "close"));
  const manage = pressable("Manage Extensions");
  assert.ok(manage, `no Manage Extensions button among ${JSON.stringify(pressables.map((p) => p.accessibilityLabel))}`);
  manage.onPress();
  assert.deepEqual(events, ["close"]);
  assert.ok(windows.open.has(SETTINGS_WINDOW_ID));
  const nav = useSettingsNav.getState();
  assert.equal(nav.pane, "extensions");
  assert.equal(nav.profileId, work);
  usage.sessionEnding();
  assert.deepEqual((await usageCounts()).map((e) => e.extensions_manage_opens_from_site_controls), [1]);
});

test("the + tile still closes the panel and opens the Chrome Web Store in the panel's window", () => {
  const { workWindow, tabId } = workWindowBehindDefaultWindow();
  let closes = 0;
  const add = renderPanel(workWindow, tabId, () => closes++)("Add Extension");
  assert.ok(add);
  const before = S().windows[workWindow].tabIds.length;
  add.onPress();
  assert.equal(closes, 1);
  const tabs = S().windows[workWindow].tabIds;
  assert.equal(tabs.length, before + 1);
  assert.match(S().tabs[tabs.find((id) => id !== tabId)].url, /^https:\/\/chromewebstore\.google\.com\//);
});
