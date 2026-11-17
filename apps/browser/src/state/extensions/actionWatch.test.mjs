import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { useExtensions } = await import("./store.ts");
const { startActionStates } = await import("./actionWatch.ts");

const S = () => useBrowser.getState();
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("a title change on a shown tab asks for no action states, a navigation asks again", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  const asked = [];
  native.extensionAnswers.actionStates = async (tabId, ids) => (asked.push(tabId), Object.fromEntries(ids.map((id) => [id, { popup: "" }])));
  useExtensions.setState({ lists: { "": [{ id: "one", name: "One", enabled: true, pinned: true, hasAction: true, incognito: false }] }, actions: {}, popup: null });
  usePages.setState({ ready: { [a]: 1 } });
  startActionStates();
  await settle();
  asked.length = 0;
  S().updateTab(a, { title: "Renamed" });
  await settle();
  assert.deepEqual(asked, []);
  S().updateTab(a, { url: "https://b.com/" });
  await settle();
  assert.deepEqual(asked, [a]);
});
