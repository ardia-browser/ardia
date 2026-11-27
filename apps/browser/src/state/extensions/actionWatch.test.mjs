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

test("moving a window, opening a background tab or another tab becoming ready asks for no action states; switching tabs and the shown tab becoming ready do", async () => {
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
  useBrowser.setState((s) => ({ windows: { ...s.windows, [w]: { ...s.windows[w], frame: { x: 10, y: 20, width: 900, height: 700 } } } }));
  await settle();
  const b = S().newTab(w, { url: "https://b.com/", background: true });
  await settle();
  usePages.setState((p) => ({ ready: { ...p.ready, [b]: 2 } }));
  await settle();
  assert.deepEqual(asked, [], "nothing that changes which page's actions are shown asked again");
  usePages.setState((p) => ({ ready: { ...p.ready, [a]: 3 } }));
  await settle();
  assert.deepEqual([...new Set(asked)], [a], "the shown tab becoming ready again asks for it");
  asked.length = 0;
  S().activate(b);
  await settle();
  assert.deepEqual([...new Set(asked)], [b], "switching to the other tab asks for its states");
});
