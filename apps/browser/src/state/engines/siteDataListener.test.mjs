import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.acTestNativeModules = {
  ArdiaWebKit: {
    addListener: () => ({ remove() {} }),
    call: async () => "null",
  },
};

const { useBrowser } = await import("../browser/store.ts");

const fromSiteData = () => new Error().stack.includes("siteData.ts");
const wholeStore = [];
const keyed = [];
const subscribe = useBrowser.subscribe;
const subscribeTo = useBrowser.subscribeTo;
useBrowser.subscribe = (listener) => {
  if (fromSiteData()) wholeStore.push(listener);
  return subscribe(listener);
};
useBrowser.subscribeTo = (keys, listener) => {
  if (fromSiteData()) keyed.push([...keys]);
  return subscribeTo(keys, listener);
};

const { startSiteData } = await import("./siteData.ts");
startSiteData();

test("the sign-in carry hears only settings and tabs, so a store change to anything else doesn't call it", () => {
  assert.equal(wholeStore.length, 0);
  assert.deepEqual(keyed, [["settings", "tabs"]]);
});
