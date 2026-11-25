import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { usePages, patchPage } = await import("../tabs/pageState.ts");
const { useMedia } = await import("./media.ts");
const { useTabShared, noteTabShare, startTabShareCleanup } = await import("./screenShare.ts");

function countingPageSubscriptions() {
  const original = usePages.subscribe;
  let live = 0;
  usePages.subscribe = (listener) => {
    live++;
    const unsubscribe = original(listener);
    return () => {
      live--;
      unsubscribe();
    };
  };
  return { live: () => live, restore: () => (usePages.subscribe = original) };
}

test("a tab row reads whether its tab is shared from one media read, with no page subscription of its own", () => {
  useMedia.setState({ tabShares: {}, sharedTabs: {} });
  const stop = startTabShareCleanup();
  const pages = countingPageSubscriptions();
  try {
    const row = mount(() => useTabShared("shared-tab"));
    const other = mount(() => useTabShared("other-tab"));
    assert.equal(row.value, false);
    noteTabShare("capturer", "shared-tab", "https://meet.example");
    assert.equal(row.value, false, "a share counts once its capturer is capturing the screen");
    patchPage("capturer", { mediaAccess: { camera: false, microphone: false, screen: true } });
    assert.equal(row.value, true);
    assert.equal(other.value, false);
    assert.equal(pages.live(), 0, "rows hold no page subscription, shared or not");
    patchPage("capturer", { mediaAccess: null });
    assert.equal(row.value, false, "the badge goes when the capture stops");
    patchPage("capturer", { mediaAccess: { camera: false, microphone: false, screen: true } });
    assert.equal(row.value, true);
    useMedia.setState({ tabShares: {} });
    assert.equal(row.value, false, "and when the share is gone");
    row.unmount();
    other.unmount();
  } finally {
    pages.restore();
    stop();
    patchPage("capturer", { mediaAccess: null });
    useMedia.setState({ tabShares: {}, sharedTabs: {} });
  }
});

test("moving a share to another tab moves the badge", () => {
  useMedia.setState({ tabShares: {}, sharedTabs: {} });
  const stop = startTabShareCleanup();
  try {
    patchPage("capturer", { mediaAccess: { camera: false, microphone: false, screen: true } });
    noteTabShare("capturer", "first", "https://meet.example");
    assert.deepEqual(useMedia.getState().sharedTabs, { first: true });
    useMedia.setState((m) => ({ tabShares: { capturer: { ...m.tabShares.capturer, capturedTabId: "second" } } }));
    assert.deepEqual(useMedia.getState().sharedTabs, { second: true });
  } finally {
    stop();
    patchPage("capturer", { mediaAccess: null });
    useMedia.setState({ tabShares: {}, sharedTabs: {} });
  }
});
