import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { openFromPage } = await import("../tabs/openFromPage.ts");
const { webviews } = await import("../../platform/webviews.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

const settle = async () => {
  mock.timers.tick(2000);
  await new Promise((r) => setImmediate(r));
};

test("pages a link opened in front are counted, and so are the ones that held the keyboard", async () => {
  client.setSharing(true, "onboarding");
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const page = activeTabId(S(), w);
  const ref = { windowId: w, profileId: S().windows[w].profileId, tabId: page };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    openFromPage({ url: "https://a.example/focused", disposition: "foreground", adoptId: "ardiacore:1" }, ref);
    const focused = activeTabId(S(), w);
    webviews.set(focused, { evaluate: async () => true });
    openFromPage({ url: "https://a.example/unfocused", disposition: "foreground", adoptId: "link:0" }, ref);
    const unfocused = activeTabId(S(), w);
    webviews.set(unfocused, { evaluate: async () => false });
    openFromPage({ url: "https://a.example/behind", disposition: "background", adoptId: "ardiacore:2" }, ref);
    openFromPage({ url: "https://a.example/plain", disposition: "foreground" }, ref);
    await settle();
  } finally {
    mock.timers.reset();
  }
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].link_tab_loads, 2);
  assert.equal(sent[0].link_tab_loads_page_focused, 1);
});
