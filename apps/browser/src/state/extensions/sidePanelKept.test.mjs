import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { useExtensions } = await import("./store.ts");
const panels = await import("./sidePanels.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();

async function sentCounts() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  return events.at(-1) ?? {};
}

test("the keep counter counts a tab coming back to its kept panel page, not one that has to load its page again", async () => {
  client.setSharing(true, "onboarding");
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "b.com", background: true });
  usePages.setState({ ready: { [a]: 1, [b]: 2 } });
  useExtensions.setState({ lists: { "": [{ id: "ext", name: "Ext", enabled: true, pinned: true, hasAction: true, incognito: false, sidePanel: "panel.html" }] }, actions: {}, popup: null, sidePanels: {}, sidePanelCards: {} });
  stub.extensionAnswers.sidePanelUrl = async (tabId) => `chrome-extension://ext/panel.html?tabId=${tabId}`;
  const show = async (tab) => {
    S().activate(tab);
    await panels.syncSidePanel(w);
  };
  await panels.openSidePanel(w, "ext");
  await show(b);
  panels.dropSidePanelCard(w, panels.sidePanelCards(w).find((card) => card.tabId === a));
  await show(a);
  await show(b);
  await show(a);
  assert.equal((await sentCounts()).side_panels_kept_on_switch, 2, "B and then A come back to kept pages; A's first return loads a new page after its old one crashed");
});
