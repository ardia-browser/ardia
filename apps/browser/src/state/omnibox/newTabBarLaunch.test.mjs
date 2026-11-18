import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { closeNewTabBar, showOnceOverEmptyCard, startNewTabBar } = await import("./newTabBar.ts");
const { openExternalUrls } = await import("../littleArdia/actions.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const panel = (w) => S().windowUi[w]?.panel ?? { open: false };
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("launch shows count the bars shown over each launch window's first card, also a window the launch itself opened, never a restored blank tab picked later", async () => {
  client.setSharing(true, "onboarding");
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  S().updateSettings({ newTabOpens: "commandBar", openLinksInLittleArdia: false });
  const restored = S().createWindow({ url: "https://a.com/" });
  const page = model.activeTabId(S(), restored);
  const blank = S().newTab(restored, { background: true });
  S().activate(page);
  startNewTabBar();
  const opened = S().createWindow({});
  await Promise.resolve();
  const card = model.activeTabId(S(), opened);
  showOnceOverEmptyCard(opened, card);
  assert.equal(panel(opened).open, true, "the window the launch opened shows the bar");
  closeNewTabBar(opened);
  usage.sessionEnding();
  const atLaunch = await usageCounts();
  assert.equal(atLaunch.length, 1);
  assert.equal(atLaunch[0].new_tab_bar_launch_shows, 1);
  S().activate(blank);
  showOnceOverEmptyCard(restored, blank);
  assert.equal(panel(restored).open, true, "a blank tab picked later still shows the bar once");
  closeNewTabBar(restored);
  usage.sessionEnding();
  const later = (await usageCounts()).slice(1);
  assert.deepEqual(later.map((e) => e.new_tab_bar_launch_shows ?? 0).filter(Boolean), []);
});

test("a link from another app over the launch bar fills the empty card instead of leaving it behind", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  S().updateSettings({ newTabOpens: "commandBar", openLinksInLittleArdia: false });
  const w = S().createWindow({});
  S().setFocusedWindow(w);
  const empty = model.activeTabId(S(), w);
  showOnceOverEmptyCard(w, empty);
  assert.equal(panel(w).open, true);
  openExternalUrls(["https://link.com/"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(S().windows[w].tabIds.map((id) => S().tabs[id].url), ["https://link.com/"]);
  assert.equal(panel(w).open, false);
});
