import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openLinkInSplit, openSplitPane } = await import("./actions.ts");
const { openFromBar } = await import("../omnibox/openFromBar.ts");
const { openPeekInSplit } = await import("../peek/actions.ts");
const { runCommand } = await import("../commands/commands.ts");
const { splitTabIds } = await import("./splits.ts");
const { useToasts } = await import("../app/toasts.ts");
const S = () => useBrowser.getState();

function stacked(orientation = "vertical") {
  S().hydrate({});
  useToasts.setState({ toasts: {} });
  const w = S().createWindow({ url: "https://one.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const id = S().createSplit([a, b], orientation);
  const c = S().openSplitPane(w, { anchorTabId: b, side: orientation === "vertical" ? "right" : "bottom", url: "https://three.example/" }).tabId;
  S().activate(c);
  return { w, a, b, c, id };
}

function fourth({ w, a, b, c, id }, url) {
  const split = S().splits[id];
  const ids = splitTabIds(split);
  assert.equal(ids.length, 4);
  assert.deepEqual(ids.slice(0, 3), [a, b, c]);
  assert.equal(split.slots.length, 3);
  assert.deepEqual(split.slots[1].stack, [b, c]);
  if (url) assert.equal(S().tabs[ids[3]].url, url);
  assert.equal(Object.keys(S().tabs).length, 4);
  assert.equal(useToasts.getState().toasts[w], undefined);
}

test("Open Link in Split View from the last stacked vertical pane opens a fourth pane without a toast", () => {
  const v = stacked();
  const url = "https://link.example/";
  openLinkInSplit(v.c, url);
  fourth(v, url);
});

test("the command bar split disposition from a stacked vertical pane opens a fourth pane without a toast", () => {
  const v = stacked();
  const url = "https://bar.example/";
  openFromBar(url, v.c, "split");
  fourth(v, url);
});

for (const [command, orientation] of [["openSplitPane", "vertical"], ["openSplitPaneBelow", "horizontal"]]) {
  test(`${command} from a stacked pane opens a fourth pane without a toast`, () => {
    const v = stacked(orientation);
    runCommand({ command, windowId: v.w });
    fourth(v);
  });
}

test("the peek Open in Split action from a stacked vertical pane opens a fourth pane without a toast", () => {
  const v = stacked();
  const url = "https://peek.example/";
  const peek = S().openPeek(v.c, url);
  assert.ok(peek);
  openPeekInSplit(v.w);
  fourth(v, url);
  assert.deepEqual(S().peeks, {});
});

test("a full split refuses another pane with the full toast and leaves the tabs unchanged", () => {
  const v = stacked();
  S().openSplitPane(v.w, { anchorTabId: v.a, side: "right" });
  const before = S().tabs;
  assert.equal(openSplitPane(v.w, { anchorTabId: v.c }), null);
  assert.equal(S().tabs, before);
  const toast = useToasts.getState().toasts[v.w];
  assert.equal(toast.title, "Cannot Add New Pane");
  assert.equal(toast.message, "Split View can show up to 4 tabs at once.");
});
