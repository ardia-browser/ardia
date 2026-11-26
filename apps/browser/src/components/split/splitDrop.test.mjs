import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { DROP_SIDES, PANE_SIDES, dropPreviewRect, paneDropTarget, paneSideAt } = await import("./splitDrop.ts");
const { splitGeometry } = await import("../window/geometry.ts");
const { useBrowser } = await import("../../state/browser/store.ts");

test("the pointer's own position picks the edge, and the middle of a pane is no target for a tab from outside", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.deepEqual(paneDropTarget(panes, 60, 400, null), { tabId: "t1", side: "left" });
  assert.deepEqual(paneDropTarget(panes, 940, 400, null), { tabId: "t1", side: "right" });
  assert.deepEqual(paneDropTarget(panes, 500, 60, null), { tabId: "t1", side: "top" });
  assert.deepEqual(paneDropTarget(panes, 500, 740, null), { tabId: "t1", side: "bottom" });
  assert.equal(paneDropTarget(panes, 500, 400, null), null);
  assert.equal(paneDropTarget(panes, 1010, 400, null), null);
});

test("an edge lights only while the pointer is inside its band, never because the dragged card overlaps it", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.deepEqual(paneDropTarget(panes, 179, 400, null), { tabId: "t1", side: "left" });
  assert.equal(paneDropTarget(panes, 230, 400, null), null);
  assert.equal(paneDropTarget(panes, 500, 230, null), null);
});

test("the edge being held keeps a little slack so its border doesn't flicker, and loses it once the pointer leaves", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.equal(paneDropTarget(panes, 190, 400, null), null);
  assert.deepEqual(paneDropTarget(panes, 190, 400, { tabId: "t1", side: "left" }), { tabId: "t1", side: "left" });
  assert.equal(paneDropTarget(panes, 200, 400, { tabId: "t1", side: "left" }), null);
  assert.deepEqual(paneDropTarget(panes, 190, 400, { tabId: "t1", side: "center" }, PANE_SIDES), { tabId: "t1", side: "center" });
});

test("a corner goes to the edge the pointer is deeper inside, measured against each edge's own band", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 400 };
  assert.equal(paneSideAt(pane, 20, 60), "left");
  assert.equal(paneSideAt(pane, 90, 10), "top");
});

test("near a corner the held edge keeps 16 px of slack against the other edge, so a small wobble doesn't flip it", () => {
  const pane = { x: 0, y: 0, width: 1162, height: 842 };
  for (const inset of [20, 40]) {
    let held = paneSideAt(pane, inset, inset);
    for (const [dx, dy] of [[2, -2], [-2, 2], [2, 2], [-2, -2], [3, -3], [-3, 3]]) {
      assert.equal(paneSideAt(pane, inset + dx, inset + dy, DROP_SIDES, held), held, `corner ${inset} wobble ${dx},${dy}`);
    }
    held = "left";
    assert.equal(paneSideAt(pane, inset + 15, inset, DROP_SIDES, held), "left");
    assert.equal(paneSideAt(pane, inset + 17, inset, DROP_SIDES, held), "top");
  }
});

test("the swap target fills the middle and is only offered when asked for", () => {
  const pane = { x: 0, y: 0, width: 1000, height: 800 };
  const panes = [["t1", pane]];
  assert.deepEqual(paneDropTarget(panes, 500, 400, null, PANE_SIDES), { tabId: "t1", side: "center" });
  assert.deepEqual(paneDropTarget(panes, 230, 400, null, PANE_SIDES), { tabId: "t1", side: "center" });
  assert.equal(paneDropTarget(panes, 500, 400, null, DROP_SIDES), null);
  assert.deepEqual(paneDropTarget(panes, 60, 400, null, PANE_SIDES), { tabId: "t1", side: "left" });
});

test("between two panes the target is the pane under the pointer, and the gap and a pane that isn't a candidate give none", () => {
  const twoPanes = [
    ["left", { x: 0, y: 0, width: 500, height: 800 }],
    ["right", { x: 509, y: 0, width: 500, height: 800 }],
  ];
  assert.deepEqual(paneDropTarget(twoPanes, 495, 400, null), { tabId: "left", side: "right" });
  assert.deepEqual(paneDropTarget(twoPanes, 520, 400, null), { tabId: "right", side: "left" });
  assert.equal(paneDropTarget(twoPanes, 504, 400, null), null);
  assert.equal(paneDropTarget([twoPanes[1]], 100, 400, null), null);
});

test("a narrow pane splits its width evenly between the two side bands and has no dead middle", () => {
  const pane = { x: 0, y: 0, width: 80, height: 800 };
  assert.equal(paneSideAt(pane, 39, 400), "left");
  assert.equal(paneSideAt(pane, 41, 400), "right");
});

test("the landing preview covers the half the new pane will take, or the whole pane for a swap, inside the pane", () => {
  const pane = { x: 100, y: 50, width: 1000, height: 800 };
  const inside = (r) => r.x >= pane.x && r.y >= pane.y && r.x + r.width <= pane.x + pane.width && r.y + r.height <= pane.y + pane.height;
  const left = dropPreviewRect(pane, "left");
  const right = dropPreviewRect(pane, "right");
  const top = dropPreviewRect(pane, "top");
  const bottom = dropPreviewRect(pane, "bottom");
  const centre = dropPreviewRect(pane, "center");
  for (const r of [left, right, top, bottom, centre]) assert.ok(inside(r));
  assert.ok(left.x + left.width < right.x && Math.abs(left.width - right.width) < 0.01);
  assert.ok(top.y + top.height < bottom.y && Math.abs(top.height - bottom.height) < 0.01);
  assert.ok(left.width > pane.width * 0.45 && top.height > pane.height * 0.45);
  assert.ok(centre.width > pane.width * 0.95 && centre.height > pane.height * 0.95);
});

function freshWindow() {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  return { S, w, a, b, c };
}

test("all 8 two- and three-pane split combinations are reachable from drop sides", () => {
  const W = 1200, H = 800, G = 9;

  {
    const { S, w, a, b } = freshWindow();
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].x < panes[b].x && panes[a].height === H && panes[b].height === H);
  }
  {
    const { S, w, a, b } = freshWindow();
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].y < panes[b].y && panes[a].width === W && panes[b].width === W);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].x < panes[b].x && panes[b].x < panes[c].x && panes[a].height === H && panes[b].height === H && panes[c].height === H);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].y < panes[b].y && panes[b].y < panes[c].y && panes[a].width === W && panes[b].width === W && panes[c].width === W);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].height === H && panes[a].x < panes[b].x && panes[b].x === panes[c].x && panes[b].y < panes[c].y);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: c, side: "right" });
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[c].height === H && panes[a].x < panes[c].x && panes[a].x === panes[b].x && panes[a].y < panes[b].y);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
    const res = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[a].width === W && panes[a].y < panes[b].y && panes[b].y === panes[c].y && panes[b].x < panes[c].x);
  }
  {
    const { S, w, a, b, c } = freshWindow();
    S().openSplitPane(w, { anchorTabId: a, tabId: c, side: "bottom" });
    const res = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
    assert.equal(res.ok, true);
    const { panes } = splitGeometry(S().splits[res.splitId], W, H, G);
    assert.ok(panes[c].width === W && panes[a].y < panes[c].y && panes[a].y === panes[b].y && panes[a].x < panes[b].x);
  }
});
