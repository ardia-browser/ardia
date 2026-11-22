import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("./store.ts");

const S = () => useBrowser.getState();
const functionFields = (s) => Object.keys(s).filter((k) => typeof s[k] === "function");

test("the state root carries data only, and every action still runs from it after merging, replacing and settling writes", () => {
  S().hydrate({});
  assert.deepEqual(functionFields(S()), [], "no action is an own field of the root");
  assert.ok(Object.keys(S()).length < 40, `the root has ${Object.keys(S()).length} own fields`);
  const w = S().createWindow({ url: "https://a.com/" });
  useBrowser.setState({ windowOrder: [...S().windowOrder] });
  assert.equal(typeof S().newTab, "function", "after a merging write");
  useBrowser.setState({ ...S(), selection: {} }, true);
  assert.equal(typeof S().newTab, "function", "after a replacing write of a spread state");
  const id = S().newTab(w, { url: "https://b.com/" });
  S().pinTabs([id], true);
  assert.equal(typeof S().closeTab, "function", "after a write that settles");
  assert.deepEqual(functionFields({ ...S() }), [], "a spread copies data only");
  assert.equal(S().tabs[id].pin?.as !== undefined, true);
});
