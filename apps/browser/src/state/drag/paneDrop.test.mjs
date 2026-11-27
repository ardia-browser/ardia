import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { beginTabDrag, endTabDrag, setDropTarget, setOnPage, setPageDrop, updateTabDrag, useTabDrag } = await import("./tabDrag.ts");
const { splitOf, splitTabIdsOf } = await import("../splits/splits.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

function splitWindow() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/", frame: [0, 0, 1200, 800] });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
  assert.equal(res.ok, true);
  return { w, a, b, c, splitId: res.splitId };
}

const windowCount = () => Object.keys(S().windows).length;
const panesOf = (tabId) => splitTabIdsOf(splitOf(S(), tabId)) ?? [];

function dragTo(tabId, x, y, target, { lifted = null, onPage = false, staysOnPage = false } = {}) {
  beginTabDrag(tabId, undefined, { staysOnPage });
  updateTabDrag(x, y, lifted);
  if (onPage) setOnPage(true);
  setDropTarget(target);
  return endTabDrag();
}

test("a pane dragged by its Split View button onto its own page with no drop zone stays where it is and opens no window", () => {
  const { a, b } = splitWindow();
  const before = windowCount();
  assert.equal(dragTo(b, 600, 400, null, { lifted: true, onPage: true, staysOnPage: true }), false);
  assert.equal(windowCount(), before);
  assert.deepEqual(panesOf(a), [a, b]);
  assert.equal(useTabDrag.getState().phase, "idle");
});

test("a pane lifted from the tab strip onto the page with no drop zone still tears out into a new window", () => {
  const { w, a, b } = splitWindow();
  const before = windowCount();
  assert.equal(dragTo(b, 600, 400, null, { lifted: true, onPage: true }), true);
  assert.equal(windowCount(), before + 1);
  assert.notEqual(S().tabs[b].windowId, w);
  assert.ok(!panesOf(a).includes(b));
});

test("a split pane dragged out of the window still moves to a new window", () => {
  const { w, a, b } = splitWindow();
  const before = windowCount();
  assert.equal(dragTo(b, 1500, 400, null), true);
  assert.equal(windowCount(), before + 1);
  assert.notEqual(S().tabs[b].windowId, w);
  assert.ok(!panesOf(a).includes(b));
});

test("a tab from outside the split dropped on a pane edge joins the split on that side", () => {
  const { w, a, b, c } = splitWindow();
  assert.equal(dragTo(c, 900, 400, { tabId: b, side: "right" }, { lifted: true, onPage: true }), true);
  assert.deepEqual(panesOf(a), [a, b, c]);
  assert.equal(S().tabs[c].windowId, w);
});

test("a pane dropped on another pane's swap zone trades places with it and never tears the tab out", () => {
  const { w, a, b, splitId } = splitWindow();
  const before = windowCount();
  assert.equal(dragTo(b, 300, 400, { tabId: a, side: "center" }, { lifted: true, onPage: true }), true);
  assert.equal(windowCount(), before);
  assert.equal(S().tabs[b].windowId, w);
  assert.deepEqual(panesOf(a), [b, a]);
  assert.equal(splitOf(S(), a).id, splitId);
});

test("the dragged page card hides while a split landing preview is showing and comes back once the pointer leaves it", async () => {
  const { shellNativeModules } = await import("../../test-native/shell.ts");
  const { a, b } = splitWindow();
  const shapes = [];
  const windows = shellNativeModules.ArdiaAppWindows;
  const original = windows.dragPreviewUpdate;
  windows.dragPreviewUpdate = (shape) => {
    shapes.push(shape);
    return Promise.resolve();
  };
  try {
    beginTabDrag(b, undefined, { staysOnPage: true });
    updateTabDrag(600, 400, true);
    setOnPage(true);
    assert.equal(shapes.at(-1), "card");
    setDropTarget({ tabId: a, side: "left" });
    assert.equal(shapes.at(-1), "hidden");
    setDropTarget({ tabId: a, side: "center" });
    assert.equal(shapes.at(-1), "hidden");
    setDropTarget(null);
    assert.equal(shapes.at(-1), "card");
  } finally {
    endTabDrag();
    windows.dragPreviewUpdate = original;
  }
});

test("leaving a landing preview straight for the sidebar, or coming straight in from it, never flashes the page card", async () => {
  const { shellNativeModules } = await import("../../test-native/shell.ts");
  const { a, b } = splitWindow();
  const shapes = [];
  const windows = shellNativeModules.ArdiaAppWindows;
  const original = windows.dragPreviewUpdate;
  windows.dragPreviewUpdate = (shape) => {
    shapes.push(shape);
    return Promise.resolve();
  };
  try {
    beginTabDrag(b);
    updateTabDrag(600, 400, null);
    setPageDrop({ tabId: a, side: "left" }, true);
    setPageDrop(null, false);
    setPageDrop({ tabId: a, side: "left" }, true);
    assert.equal(shapes.includes("card"), false, shapes.join(","));
  } finally {
    endTabDrag();
    windows.dragPreviewUpdate = original;
  }
});
