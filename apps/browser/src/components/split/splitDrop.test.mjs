import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { DROP_SIDES, zoneHit, zoneRect } = await import("./splitDrop.ts");
const { splitGeometry } = await import("../window/geometry.ts");
const { useBrowser } = await import("../../state/browser/store.ts");

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("all four split drop zones stay disjoint across full, half-width and half-height panes", () => {
  const panes = [
    { x: 0, y: 0, width: 1200, height: 800 },
    { x: 0, y: 0, width: 690, height: 775 },
    { x: 0, y: 0, width: 1390, height: 383 },
  ];
  for (const pane of panes) {
    for (const stage of ["rest", "grown"]) {
      const rects = DROP_SIDES.map((side) => [side, zoneRect(pane, side, stage)]);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
          assert.equal(overlaps(rects[i][1], rects[j][1]), false, `${pane.width}x${pane.height} ${stage}: ${rects[i][0]} vs ${rects[j][0]}`);
    }
    for (const active of DROP_SIDES) {
      const rects = DROP_SIDES.map((side) => {
        const home = zoneRect(pane, side, "grown");
        return [side, zoneRect(pane, side, side === active ? "active" : "grown", home.x + home.width / 2, home.y + home.height / 2)];
      });
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++)
          assert.equal(overlaps(rects[i][1], rects[j][1]), false, `${pane.width}x${pane.height} active=${active}: ${rects[i][0]} vs ${rects[j][0]}`);
    }
  }
});

test("zoneHit targets left, right, top and bottom cleanly and stays null at pane centre", () => {
  const pane = { x: 0, y: 0, width: 1200, height: 800 };
  assert.equal(zoneHit([["a", pane]], 600, 400, null), null);
  for (const side of DROP_SIDES) {
    const r = zoneRect(pane, side, "grown");
    assert.deepEqual(zoneHit([["a", pane]], r.x + r.width / 2, r.y + r.height / 2, null), { tabId: "a", side });
  }
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

test("rearranging a tab already inside a 3-pane split reshapes the layout instead of hitting max", () => {
  const { S, w, a, b, c } = freshWindow();
  S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
  S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "right" });
  const reshaped = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
  assert.equal(reshaped.ok, true);
  const { panes } = splitGeometry(S().splits[reshaped.splitId], 1200, 800, 9);
  assert.ok(panes[a].height === 800 && panes[b].x === panes[c].x && panes[b].y < panes[c].y);
});
