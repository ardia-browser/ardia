import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { cancelPanel } = await import("./barState.ts");
const { webviews } = await import("../../platform/webviews.ts");

const S = () => useBrowser.getState();
const nextTick = () => new Promise((r) => setTimeout(r, 5));

function windowWithPage() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const tab = activeTabId(S(), w);
  const focused = [];
  webviews.set(tab, { focusIfUnfocused: async () => (focused.push(tab), true) });
  return { w, tab, focused };
}

test("closing the bar gives the keyboard back to the page", async () => {
  const { w, tab, focused } = windowWithPage();
  cancelPanel(w);
  await nextTick();
  assert.deepEqual(focused, [tab]);
});

test("closing the bar over a shown Peek leaves the page under the card unfocused", async () => {
  const { w, tab, focused } = windowWithPage();
  assert.ok(S().openPeek(tab, "https://peek.example/"));
  cancelPanel(w);
  await nextTick();
  assert.deepEqual(focused, []);
});
