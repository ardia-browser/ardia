import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useToasts } = await import("../app/toasts.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { captureEnded, captureFullPage, toggleCapture } = await import("./actions.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setImmediate(resolve));
const toastOf = (w) => useToasts.getState().toasts[w] ?? null;

function twoTabs() {
  S().hydrate({});
  useToasts.setState({ toasts: {} });
  const w = S().createWindow({ url: "https://a.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://b.example/", background: true });
  for (const tab of [a, b]) webviews.set(tab, { captureFullPage: async () => true, toggleCapture: async () => true });
  return { w, a, b };
}

const page = (capture) => ({ outcome: "copied", kind: "page", width: 1800, height: 6000, ms: 90, capture });

test("with two full pages coming in one window, the first result keeps saying the other is still coming", async () => {
  const { w, a, b } = twoTabs();
  await captureFullPage(a);
  await captureFullPage(b);
  captureEnded(a, page(1));
  const first = toastOf(w);
  assert.equal(first?.title, "Capture copied");
  assert.equal(first?.message, "1800 × 6000 · capturing 1 more page…");
  assert.equal(first?.sticky, true);
  captureEnded(b, page(2));
  const last = toastOf(w);
  assert.equal(last?.title, "Capture copied");
  assert.equal(last?.message, "1800 × 6000");
  assert.ok(!last?.sticky);
  assert.notEqual(last?.id, first?.id, "a new toast, so it closes by itself");
});

test("a full page in another tab also keeps a Capture… result from hiding that it's still coming", async () => {
  const { w, a, b } = twoTabs();
  await captureFullPage(a);
  captureEnded(b, { outcome: "copied", kind: "area", width: 200, height: 100, ms: 900, capture: 3 });
  assert.equal(toastOf(w)?.message, "200 × 100 · capturing 1 more page…");
  assert.equal(toastOf(w)?.sticky, true);
});

test("a platform that refuses the call clears the progress instead of leaving it up", async () => {
  const { w, a } = twoTabs();
  webviews.set(a, { captureFullPage: () => Promise.reject(new Error("Unsupported tab command: captureFullPage")), toggleCapture: () => Promise.reject(new Error("Unsupported tab command: toggleCapture")) });
  await captureFullPage(a);
  await settle();
  assert.equal(toastOf(w), null);
  await assert.doesNotReject(toggleCapture(a));
});
