import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { barSplitSide, barSplitsFrom, dispositionFor, openFromBar, switchFromBar } = await import("./openFromBar.ts");
const { setOpeningGate } = await import("../tabs/openingGate.ts");
const { splitOf, splitTabIds } = await import("../splits/splits.ts");
const { setWindowRootSize, windowRootSize } = await import("../windows/rootSize.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

test("⌥↩ is split, ⌘↩ is a new tab, ⇧↩ is a new window", () => {
  assert.equal(dispositionFor({ altKey: true }), "split");
  assert.equal(dispositionFor({ metaKey: true }), "newTab");
  assert.equal(dispositionFor({ shiftKey: true }), "newWindow");
  assert.equal(dispositionFor({ metaKey: true, altKey: true }), "split");
  assert.equal(dispositionFor({}), "current");
});

test("barSplitSide prefers the split orientation, then the window shape, defaulting to right", () => {
  const wide = { width: 1400, height: 900 };
  const tall = { width: 800, height: 1200 };
  assert.equal(barSplitSide(undefined, wide), "right");
  assert.equal(barSplitSide(undefined, tall), "bottom");
  assert.equal(barSplitSide(undefined, { width: 900, height: 900 }), "right");
  assert.equal(barSplitSide(undefined, undefined), "right");
  for (const size of [wide, tall, undefined]) {
    assert.equal(barSplitSide({ orientation: "horizontal" }, size), "right");
    assert.equal(barSplitSide({ orientation: "vertical" }, size), "bottom");
  }
});

for (const [shape, width, height, orientation] of [
  ["wide", 1400, 900, "horizontal"],
  ["tall", 800, 1200, "vertical"],
]) {
  test(`openFromBar creates a ${orientation} split in a ${shape} window`, () => {
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.com/" });
    const a = S().windows[w].tabIds[0];
    setWindowRootSize(w, width, height);
    openFromBar("https://b.com/", a, "split");
    const split = splitOf(S(), a);
    const b = S().windows[w].tabIds.find((id) => id !== a);
    assert.equal(split.orientation, orientation);
    assert.deepEqual(split.slots.map((slot) => slot.tabId), [a, b]);
    assert.equal(S().tabs[b].url, "https://b.com/");
  });

  test(`openFromBar preserves an existing ${orientation} split in a ${shape === "wide" ? "tall" : "wide"} window`, () => {
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.com/" });
    const a = S().windows[w].tabIds[0];
    const b = S().newTab(w, { url: "https://b.com/" });
    S().createSplit([a, b], orientation);
    setWindowRootSize(w, height, width);
    openFromBar("https://c.com/", b, "split");
    const split = splitOf(S(), a);
    const c = S().windows[w].tabIds.find((id) => id !== a && id !== b);
    assert.equal(split.orientation, orientation);
    assert.deepEqual(split.slots.map((slot) => slot.tabId), [a, b, c]);
    assert.equal(S().tabs[c].url, "https://c.com/");
  });
}

test("openFromBar with unknown window size puts the URL in a right pane beside the tab", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const a = S().windows[w].tabIds[0];
  assert.equal(windowRootSize(S(), w), undefined);
  openFromBar("https://b.com/", a, "split");
  const split = splitOf(S(), a);
  assert.ok(split);
  assert.equal(split.orientation, "horizontal");
  assert.deepEqual(
    splitTabIds(split).map((id) => S().tabs[id].url),
    ["https://a.com/", "https://b.com/"],
  );
});

test("⌥↩ into a full split opens a background tab instead of dropping the URL", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const a = S().windows[w].tabIds[0];
  const b = S().openSplitPane(w, { anchorTabId: a, url: "https://b.com/" }).tabId;
  const c = S().openSplitPane(w, { anchorTabId: b, url: "https://c.com/" }).tabId;
  S().activate(a);
  S().openPanel(w, "https://keep.example/");
  const before = new Set(S().windows[w].tabIds);
  openFromBar("https://d.com/", a, "split");
  assert.deepEqual(
    splitTabIds(splitOf(S(), a)).map((id) => S().tabs[id].url),
    ["https://a.com/", "https://b.com/", "https://c.com/"],
  );
  const added = S().windows[w].tabIds.filter((id) => !before.has(id));
  assert.equal(added.length, 1);
  assert.equal(S().tabs[added[0]].url, "https://d.com/");
  assert.equal(S().tabs[added[0]].openerId, null, "overflow tab is not an opener child");
  assert.equal(activeTabId(S(), w), a, "the new tab stays in the background");
  assert.equal(S().windowUi[w].panel.open, false);
  S().activate(c);
  S().closeTab(c);
  assert.notEqual(activeTabId(S(), w), added[0], "closing the active last pane does not jump to the overflow tab");
  assert.ok([a, b].includes(activeTabId(S(), w)), "focus stays on a remaining split pane");
  assert.ok(splitOf(S(), a));
});

test("⌥↩ asks the opening gate: a rewrite opens the new URL in the pane, a cancel opens nothing", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const a = S().windows[w].tabIds[0];
  const asked = [];
  setOpeningGate((url, context) => {
    asked.push(context.via);
    if (url.includes("blocked")) return { cancel: true };
    return Promise.resolve({ url: "https://rewritten.example/" });
  });
  try {
    const before = S().windows[w].tabIds.length;
    openFromBar("https://blocked.example/", a, "split");
    assert.equal(S().windows[w].tabIds.length, before);
    assert.equal(splitOf(S(), a), undefined);
    openFromBar("https://b.com/", a, "split");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      splitTabIds(splitOf(S(), a)).map((id) => S().tabs[id].url),
      ["https://a.com/", "https://rewritten.example/"],
    );
    assert.deepEqual(asked, ["newTab", "newTab"]);
  } finally {
    setOpeningGate(null);
  }
});

test("⌥↩ splits only from a tab showing a page", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const a = S().windows[w].tabIds[0];
  const blank = S().newTab(w, {});
  assert.equal(barSplitsFrom(a), true);
  assert.equal(barSplitsFrom(blank), false);
  assert.equal(barSplitsFrom("missing"), false);
});

test("a Switch to Tab row switches on ↩ and opens its address in a new tab on ⌘↩, from any bar", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.example.com/" });
  const mail = S().windows[w].tabIds[0];
  const bar = S().newTab(w, {});
  const before = S().windows[w].tabIds.length;
  switchFromBar(mail, "https://mail.example.com/#new", bar, dispositionFor({ metaKey: true }));
  const tabs = S().windows[w].tabIds;
  assert.equal(tabs.length, before + 1, "⌘↩ opens a tab");
  const opened = tabs.find((id) => id !== mail && id !== bar);
  assert.equal(S().tabs[opened].url, "https://mail.example.com/#new", "at the address in the row");
  assert.notEqual(activeTabId(S(), w), mail, "without switching to the open tab");
  switchFromBar(mail, "https://mail.example.com/", bar, dispositionFor({}));
  assert.equal(activeTabId(S(), w), mail, "↩ switches");
});
