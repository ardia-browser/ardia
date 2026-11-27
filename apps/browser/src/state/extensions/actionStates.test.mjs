import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { useExtensions } = await import("./store.ts");
const { refreshActionStates } = await import("./actionStates.ts");
const { notePageCommit } = await import("../engines/pageDocuments.ts");

const S = () => useBrowser.getState();
const ONE = { id: "one", name: "One", enabled: true, pinned: true, hasAction: true, incognito: false };

function heldWindow() {
  S().hydrate({});
  const w = S().createWindow({ url: "a.com" });
  const a = S().windows[w].tabIds[0];
  useExtensions.setState({ lists: { "": [ONE] }, actions: {}, popup: null });
  usePages.setState({ ready: { [a]: 1 } });
  const replies = [];
  native.extensionAnswers.actionStates = (tabId, ids) =>
    new Promise((resolve) => replies.push(() => resolve(Object.fromEntries(ids.map((id) => [id, { popup: "", badge: "3" }])))));
  return { w, a, replies };
}

test("a reply that lands after its tab closed doesn't put the closed tab back in the toolbar states", async () => {
  const { a, replies } = heldWindow();
  const refresh = refreshActionStates();
  await new Promise((r) => setImmediate(r));
  assert.equal(replies.length, 1);
  S().closeTab(a);
  usePages.setState({ ready: {} });
  replies[0]();
  await refresh;
  assert.equal(a in useExtensions.getState().actions, false);
});

test("a reply for a page the tab has since replaced is dropped, and one for the page still shown is kept", async () => {
  const { a, replies } = heldWindow();
  const stale = refreshActionStates();
  await new Promise((r) => setImmediate(r));
  usePages.setState({ ready: { [a]: 2 } });
  replies[0]();
  await stale;
  assert.equal(a in useExtensions.getState().actions, false, "the reply was for the page before");
  const fresh = refreshActionStates();
  await new Promise((r) => setImmediate(r));
  replies[1]();
  await fresh;
  assert.equal(useExtensions.getState().actions[a]?.one?.badge, "3");
});

test("a reply for the document before a reload in the same view is dropped, though the tab's readiness didn't change", async () => {
  const { a, replies } = heldWindow();
  notePageCommit(a, 1000);
  const stale = refreshActionStates();
  await new Promise((r) => setImmediate(r));
  notePageCommit(a, 2000);
  replies[0]();
  await stale;
  assert.equal(a in useExtensions.getState().actions, false, "the reply was for the document before the reload");
  const fresh = refreshActionStates();
  await new Promise((r) => setImmediate(r));
  replies[1]();
  await fresh;
  assert.equal(useExtensions.getState().actions[a]?.one?.badge, "3");
});
