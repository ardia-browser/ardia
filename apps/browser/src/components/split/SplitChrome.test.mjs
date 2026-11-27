import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

await import("../../test-native/index.ts");
const { PanResponder } = await import("react-native");
const { useBrowser } = await import("../../state/browser/store.ts");
const { splitGeometry } = await import("../window/geometry.ts");
const { DropTargets, SplitDividers } = await import("./SplitChrome.tsx");

test("each grid divider resizes and resets only its own stack", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  const d = S().newTab(w, { url: "https://four.example/", background: true });
  const { splitId } = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
  S().openSplitPane(w, { anchorTabId: a, tabId: c, side: "bottom" });
  S().openSplitPane(w, { anchorTabId: b, tabId: d, side: "bottom" });
  S().updateSplit(splitId, { stackSizes: [0.3, 0.7], stackIndex: 0 });
  S().updateSplit(splitId, { stackSizes: [0.6, 0.4], stackIndex: 1 });
  const split = S().splits[splitId];
  const { dividers } = splitGeometry(split, 1009, 809, 9);
  const handles = SplitDividers({ split, dividers, width: 1009, height: 809 }).props.children;
  assert.equal(new Set(handles.map((h) => h.key)).size, 3);
  const previous = PanResponder.create;
  const mounted = [];
  try {
    PanResponder.create = (handlers) => ({ panHandlers: handlers });
    for (const index of [0, 1]) {
      const element = handles.find((h) => h.props.divider.kind === "stack" && h.props.divider.index === index);
      const hook = mount(() => element.type({ ...element.props, split: S().splits[splitId] }));
      mounted.push(hook);
      const before = S().splits[splitId].slots.map((slot) => slot.stackSizes);
      hook.value.props.onPanResponderGrant();
      hook.value.props.onPanResponderMove(null, { dx: 0, dy: 40 });
      assert.deepEqual(S().splits[splitId].slots[index].stackSizes, index === 0 ? [0.35, 0.65] : [0.65, 0.35]);
      assert.deepEqual(S().splits[splitId].slots[1 - index].stackSizes, before[1 - index]);
      hook.value.props.onPanResponderGrant();
      hook.value.props.onDoubleClick();
      assert.deepEqual(S().splits[splitId].slots[index].stackSizes, [0.5, 0.5]);
      assert.deepEqual(S().splits[splitId].slots[1 - index].stackSizes, before[1 - index]);
    }
  } finally {
    for (const hook of mounted) hook.unmount();
    PanResponder.create = previous;
  }
});

const { WindowContext } = await import("../../state/browser/hooks.ts");
const { beginTabDrag, cancelTabDrag, endTabDrag, updateTabDrag, useTabDrag } = await import("../../state/drag/tabDrag.ts");

function dropWindow() {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/", frame: [0, 0, 1200, 800] });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  const d = S().newTab(w, { url: "https://four.example/", background: true });
  const { splitId } = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
  S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
  const { panes } = splitGeometry(S().splits[splitId], 1200, 800, 9);
  const pane = panes[b];
  return { S, w, d, splitId, panes, x: pane.x + pane.width / 2, y: pane.y + pane.height - 1 };
}

test("DropTargets hides a stacked pane's unavailable edge", () => {
  const { w, d, panes, x, y } = dropWindow();
  beginTabDrag(d, undefined, { staysOnPage: true });
  updateTabDrag(x, y, true);
  const hook = mount(() => DropTargets({ panes, origin: { x: 0, y: 0 } }), { contexts: [[WindowContext, w]] });
  try {
    assert.equal(hook.value.props.landing, null);
    assert.equal(useTabDrag.getState().target, null);
    updateTabDrag(1199, y / 2, true);
    assert.equal(hook.value.props.landing.side, "right");
  } finally {
    hook.unmount();
    cancelTabDrag();
  }
});

test("DropTargets rejects an unavailable edge at release before another render", () => {
  const { S, w, d, splitId, panes, x, y } = dropWindow();
  beginTabDrag(d, undefined, { staysOnPage: true });
  updateTabDrag(1199, y / 2, true);
  const hook = mount(() => DropTargets({ panes, origin: { x: 0, y: 0 } }), { contexts: [[WindowContext, w]] });
  try {
    assert.equal(hook.value.props.landing.side, "right");
    const before = S().splits[splitId];
    useTabDrag.getState().session.pointer = [x, y];
    assert.equal(endTabDrag(), false);
    assert.equal(S().splits[splitId], before);
  } finally {
    hook.unmount();
    cancelTabDrag();
  }
});
