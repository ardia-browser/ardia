import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const model = stub.shellNativeModules.ArdiaTranslate;
model.available = true;
const detected = [];
model.detect = async (text) => (detected.push(text), "fr");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setNeverTranslate, translation } = await import("./translate.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((r) => setTimeout(r, 20));

async function sampleFrom(answer) {
  detected.length = 0;
  S().hydrate({});
  const w = S().createWindow({ url: "https://page.example/" });
  const tab = activeTabId(S(), w);
  webviews.set(tab, { evaluate: async () => answer });
  setNeverTranslate(tab, false);
  await settle();
  return detected.slice();
}

test("language detection only ever gets the page's sample as a capped string", async () => {
  assert.ok(translation, "the test needs the translation model");
  assert.deepEqual(await sampleFrom({ lang: "fr", text: "x".repeat(50), active: false }), ["x".repeat(50)]);
  assert.deepEqual(await sampleFrom({ lang: "fr", text: Array.from({ length: 50 }, () => "word"), active: false }), []);
  assert.deepEqual(await sampleFrom({ lang: {}, text: { length: 99, slice: () => "forged" }, active: "yes" }), []);
  assert.equal((await sampleFrom({ lang: "fr", text: "y".repeat(9000), active: false }))[0].length, 3000);
  assert.deepEqual(await sampleFrom("not an object"), []);
});
