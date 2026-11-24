import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();

test("a front tab change is listed per window, including the front tab going away, and nothing when windows didn't change", async () => {
  const { frontTabChanges } = await import("./frontTabs.ts");
  const tabs = Object.fromEntries(["a", "b"].map((id) => [id, { windowId: "w1" }]));
  const at = (active) => ({ tabs, windows: { w1: { profileId: "p1", activeTabIds: active } } });
  const one = at({ p1: "a" });
  assert.deepEqual(frontTabChanges(one, at({ p1: "b" })), [{ windowId: "w1", before: "a", after: "b" }]);
  assert.deepEqual(frontTabChanges(one, at({})), [{ windowId: "w1", before: "a", after: undefined }], "the live engine's nudge needs the tab that was left even when nothing replaces it");
  assert.deepEqual(frontTabChanges(one, one), []);
  assert.deepEqual(frontTabChanges(one, at({ p1: "a" })), [], "new windows with the same front tab list nothing");
});

test("every consumer of front tab changes shares one store subscription, and the last to leave ends it", async () => {
  const subscribeTo = useBrowser.subscribeTo;
  let subscriptions = 0;
  let unsubscribed = 0;
  useBrowser.subscribeTo = (keys, listener) => {
    subscriptions++;
    const stop = subscribeTo(keys, listener);
    return () => (unsubscribed++, stop());
  };
  try {
    const { onFrontTabChanged } = await import("./frontTabs.ts");
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.example/" });
    const second = S().newTab(w, { url: "https://b.example/", background: true });
    const seenBy = { first: [], second: [] };
    const stopFirst = onFrontTabChanged((change) => seenBy.first.push(change.after));
    const stopSecond = onFrontTabChanged((change) => seenBy.second.push(change.after));
    assert.equal(subscriptions, 1, "two consumers, one store listener");
    S().activate(second);
    assert.deepEqual(seenBy.first, [second]);
    assert.deepEqual(seenBy.second, [second]);
    stopFirst();
    assert.equal(unsubscribed, 0, "still one consumer left");
    stopSecond();
    assert.equal(unsubscribed, 1, "the last consumer ends the store listener");
  } finally {
    useBrowser.subscribeTo = subscribeTo;
  }
});

test("a consumer that leaves and comes back while a change is being handed out hears that change once, and the store listener survives", async () => {
  const subscribeTo = useBrowser.subscribeTo;
  let subscriptions = 0;
  let unsubscribed = 0;
  useBrowser.subscribeTo = (keys, listener) => {
    subscriptions++;
    const stop = subscribeTo(keys, listener);
    return () => (unsubscribed++, stop());
  };
  try {
    const { onFrontTabChanged } = await import("./frontTabs.ts");
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.example/" });
    const second = S().newTab(w, { url: "https://b.example/", background: true });
    const heard = [];
    let stop = () => {};
    const rejoin = (change) => {
      heard.push(change.after);
      stop();
      stop = onFrontTabChanged(rejoin);
    };
    stop = onFrontTabChanged(rejoin);
    S().activate(second);
    assert.deepEqual(heard, [second], "one switch, heard once");
    assert.equal(unsubscribed, 0, "the store listener isn't torn down mid-dispatch");
    assert.equal(subscriptions, 1);
    stop();
    assert.equal(unsubscribed, 1);
  } finally {
    useBrowser.subscribeTo = subscribeTo;
  }
});
