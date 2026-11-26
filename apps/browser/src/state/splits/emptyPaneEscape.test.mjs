import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openSplitPane, closeEmptySplitPaneOnEscape } = await import("./actions.ts");
const { splitOf } = await import("./splits.ts");
const { activeTabId } = await import("../browser/model.ts");
const S = () => useBrowser.getState();
S().hydrate({});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Esc on a new empty split pane closes it, as ⌘W does", async () => {
  const windowId = S().createWindow({ url: "https://a.example/" });
  const page = activeTabId(S(), windowId);
  const empty = openSplitPane(windowId);
  assert.ok(empty && splitOf(S(), empty), "the empty pane joined a split");
  assert.equal(S().tabs[empty].url, "");
  assert.equal(closeEmptySplitPaneOnEscape(empty), true);
  await settle();
  assert.equal(S().tabs[empty], undefined, "the empty pane is gone");
  assert.ok(S().tabs[page], "the page beside it stays");
  assert.equal(splitOf(S(), page), undefined, "a split of one pane is no split");
});

test("Esc never closes a pane that has a page, or an empty tab outside a split", async () => {
  const windowId = S().createWindow({ url: "https://a.example/" });
  const other = openSplitPane(windowId, { url: "https://b.example/" });
  assert.ok(other && splitOf(S(), other));
  assert.equal(closeEmptySplitPaneOnEscape(other), false);
  assert.equal(closeEmptySplitPaneOnEscape(activeTabId(S(), windowId)), false);
  const lone = S().createWindow({});
  const blank = activeTabId(S(), lone);
  assert.equal(closeEmptySplitPaneOnEscape(blank), false);
  assert.equal(closeEmptySplitPaneOnEscape("missing"), false);
  await settle();
  assert.ok(S().tabs[other] && S().tabs[blank]);
});

test("Esc on a blank third pane of a pinned split removes only that pane: both pages stay loaded in their split and one of them is shown", async () => {
  const { splitTabIdsOf } = await import("./splits.ts");
  const { webviews } = await import("../../platform/webviews.ts");
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), windowId);
  const b = S().newTab(windowId, { url: "https://b.example/" });
  S().pinTabs([a, b], true, true);
  S().createSplit([a, b]);
  S().activate(b);
  S().activate(a);
  assert.ok(S().tabs[a].page.nav && S().tabs[b].page.nav, "both pages are loaded");
  const split = splitOf(S(), a);
  const empty = openSplitPane(windowId, { anchorTabId: a });
  assert.ok(empty && splitOf(S(), empty)?.id === split.id, "the blank pane joined the pinned split");
  assert.equal(activeTabId(S(), windowId), empty);
  const focused = [];
  for (const id of [a, b]) webviews.set(id, { focus: async () => void focused.push(id) });
  assert.equal(closeEmptySplitPaneOnEscape(empty), true);
  await settle();
  assert.equal(S().tabs[empty], undefined, "the blank pane is gone");
  assert.deepEqual(splitTabIdsOf(splitOf(S(), a)).sort(), [a, b].sort(), "the split keeps its two pages");
  assert.ok(S().tabs[a].page.nav && S().tabs[b].page.nav, "neither page was put to sleep");
  const shown = activeTabId(S(), windowId);
  assert.ok(shown === a || shown === b, `a surviving pane is shown: ${shown}`);
  assert.deepEqual(focused, [shown], "and its page has the keyboard");
  assert.equal(S().closedTabs.some((c) => c.id === empty), false, "a blank pane leaves nothing in Recently Closed");
});

test("holding Esc on Windows with two blank panes beside a page closes only the newest blank pane even if Shift is pressed during the hold", async () => {
  const { useHeldEscape } = await import("../../components/ui/fieldKeys.ts");
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  const page = activeTabId(S(), windowId);
  const firstBlank = openSplitPane(windowId);
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [firstBlank]: { ...s.tabs[firstBlank], lastActiveAt: s.tabs[page].lastActiveAt + 1 } } }));
  const secondBlank = openSplitPane(windowId);
  assert.ok(firstBlank && secondBlank && splitOf(S(), firstBlank) && splitOf(S(), secondBlank));
  assert.equal(activeTabId(S(), windowId), secondBlank);
  const newestField = useHeldEscape();
  const earlierField = useHeldEscape();
  newestField.release();
  const press = (field, tabId, key) => {
    const e = { nativeEvent: { key } };
    if (field.down(e)) return false;
    return key === "Escape" ? closeEmptySplitPaneOnEscape(tabId) : false;
  };
  try {
    assert.equal(press(newestField, secondBlank, "Escape"), true, "first Esc closes the newest blank pane");
    assert.equal(S().tabs[secondBlank], undefined);
    assert.equal(activeTabId(S(), windowId), firstBlank, "focus hands off to the remaining blank pane");
    assert.equal(press(earlierField, firstBlank, "Shift"), false, "pressing Shift while holding Esc does not close or rearm");
    assert.equal(press(earlierField, firstBlank, "Escape"), false, "held-Esc auto-repeat in the second blank pane is suppressed");
    assert.ok(S().tabs[firstBlank], "the second blank pane stays open");
    earlierField.up({ nativeEvent: { key: "Escape" } });
    assert.equal(press(earlierField, firstBlank, "Escape"), true, "releasing and pressing Esc again closes the second blank pane");
    await settle();
    assert.equal(S().tabs[firstBlank], undefined);
    assert.ok(S().tabs[page], "the loaded page beside them stays");
  } finally {
    newestField.release();
  }
});

