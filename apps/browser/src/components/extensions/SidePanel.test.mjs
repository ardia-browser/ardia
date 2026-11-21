import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const native = await import("../../test-native/index.ts");
const { animations } = await import("react-native");
const { useBrowser } = await import("../../state/browser/store.ts");
const { WindowContext } = await import("../../state/browser/hooks.ts");
const { usePages } = await import("../../state/tabs/pageState.ts");
const { useExtensions } = await import("../../state/extensions/store.ts");
const panels = await import("../../state/extensions/sidePanels.ts");
const { ExtensionSidePanel } = await import("./SidePanel.tsx");

const S = () => useBrowser.getState();
const EXT = { id: "ext", name: "Ext", enabled: true, pinned: true, hasAction: true, incognito: false, sidePanel: "panel.html" };

const cardsIn = (node, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) cardsIn(child, out);
    return out;
  }
  if (node.props?.panel && node.key) out.push(node.key);
  cardsIn(node.props?.children, out);
  return out;
};

test("closing the panel with the X fades out the page that was showing instead of loading it again for the fade", async (t) => {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  usePages.setState({ ready: { [a]: 1 } });
  useExtensions.setState({ lists: { "": [EXT] }, actions: {}, popup: null, sidePanels: {}, sidePanelCards: {} });
  native.extensionAnswers.actionStates = async () => ({});
  native.extensionAnswers.sidePanelUrl = async () => "chrome-extension://ext/panel.html?tabId=a";
  await panels.openSidePanel(w, "ext");
  const renders = [];
  const mounted = mount(
    () => {
      const tree = ExtensionSidePanel();
      renders.push(cardsIn(tree));
      return tree;
    },
    { contexts: [[WindowContext, w]] },
  );
  t.after(() => {
    mounted.unmount();
    animations.held = false;
  });
  void mounted.value;
  const key = renders.at(-1)[0];
  assert.ok(key, "the panel's page is mounted");
  animations.held = true;
  const before = renders.length;
  panels.closeSidePanelOnTab(w);
  void mounted.value;
  const since = renders.slice(before);
  assert.ok(since.length > 0);
  assert.deepEqual(since.map((keys) => keys.includes(key)), since.map(() => true), `the page stays mounted through the fade: ${JSON.stringify(since)}`);
  animations.finish();
  void mounted.value;
  assert.deepEqual(renders.at(-1), [], "and goes once the fade ends");
});

test("a panel already hidden that then closes for the window doesn't bring back a page closed earlier with the X", async (t) => {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "b.com", background: true });
  usePages.setState({ ready: { [a]: 1, [b]: 2 } });
  useExtensions.setState({ lists: { "": [EXT] }, actions: {}, popup: null, sidePanels: {}, sidePanelCards: {} });
  native.extensionAnswers.actionStates = async () => ({});
  native.extensionAnswers.sidePanelUrl = async (tabId) => `chrome-extension://ext/panel.html?tabId=${tabId === a ? "a" : "b"}`;
  await panels.openSidePanel(w, "ext");
  const renders = [];
  const mounted = mount(
    () => {
      const tree = ExtensionSidePanel();
      renders.push(cardsIn(tree));
      return tree;
    },
    { contexts: [[WindowContext, w]] },
  );
  t.after(() => {
    mounted.unmount();
    animations.held = false;
  });
  const show = async (tab) => {
    S().activate(tab);
    await panels.syncSidePanel(w);
    void mounted.value;
  };
  void mounted.value;
  const keyA = renders.at(-1)[0];
  await show(b);
  await show(a);
  animations.held = true;
  panels.closeSidePanelOnTab(w);
  void mounted.value;
  animations.finish();
  void mounted.value;
  assert.ok(!renders.at(-1).includes(keyA), "A's page is gone once its fade ends");
  const before = renders.length;
  panels.closeSidePanel(w);
  void mounted.value;
  animations.finish();
  void mounted.value;
  const since = renders.slice(before);
  assert.ok(since.every((keys) => !keys.includes(keyA)), `A's closed page never comes back: ${JSON.stringify(since)}`);
});
