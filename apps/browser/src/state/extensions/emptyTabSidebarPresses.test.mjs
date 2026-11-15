import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { extensionProfile, useExtensions } = await import("./store.ts");
const { openExtensionFromMenu } = await import("./bridge.ts");
const { addressBarInSidebar } = await import("../windows/layout.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const EXT = { id: "fixture", name: "Fixture", enabled: true, pinned: true, hasAction: true, incognito: false, mayModify: true, errors: [] };

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("an extension opened from the command bar or a shortcut on an empty tab is not counted as a sidebar button press", async () => {
  client.setSharing(true, "onboarding");
  S().hydrate({});
  S().updateSettings({ addressBar: "sidebar" });
  const w = S().createWindow({});
  const empty = model.activeTabId(S(), w);
  assert.equal(S().tabs[empty].url, "");
  assert.equal(addressBarInSidebar(S(), w), true);
  useExtensions.setState({ lists: { [extensionProfile(S(), w)]: [EXT] } });
  openExtensionFromMenu(w, EXT.id, empty);
  await new Promise((resolve) => setImmediate(resolve));
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.deepEqual(sent.map((e) => e.empty_tab_sidebar_extension_presses ?? 0).filter(Boolean), []);
});

test("an hour whose only activity is a press of an empty tab's sidebar extension button still sends usage_counts", async () => {
  client.setSharing(true, "onboarding");
  const before = (await usageCounts()).length;
  usage.noteEmptyTabSidebarExtensionPress();
  usage.sessionEnding();
  const sent = (await usageCounts()).slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].empty_tab_sidebar_extension_presses, 1);
});
