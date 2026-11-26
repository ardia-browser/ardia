import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
const { takePeekMotionCounts } = await import("../telemetry/peekMotion.ts");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("../commands/commands.ts");
const { openFind } = await import("../find/actions.ts");
const { activeTabId } = await import("../browser/model.ts");
const { shownPeek } = await import("./peek.ts");
const { webviews } = await import("../../platform/webviews.ts");
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const windowWithPeek = () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const a = S().windows[w].tabIds[0];
  S().newTab(w, { url: "https://b.example/", background: true });
  S().activate(a);
  const peek = S().openPeek(a, "https://peek.example/page", { x: 100, y: 200 });
  assert.ok(peek && shownPeek(S(), w), "a Peek shows");
  return { w, a, peek };
};

test("⌘W in a Peek with Find open closes the Peek, as File › Close Peek says, not just the Find bar", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takePeekMotionCounts();
  const { w, a, peek } = windowWithPeek();
  const focused = [];
  webviews.set(peek, { focus: async () => void focused.push(peek), stopFinding: async () => {} });
  openFind(peek);
  assert.equal(S().find[peek].open, true);
  runCommand({ command: "closeTab", arg: null, windowId: w }, { user: { consent: client.consentToken() } });
  await settle();
  assert.equal(shownPeek(S(), w), undefined, "the Peek is gone");
  assert.notEqual(S().find[peek]?.open, true, "its Find bar went with it");
  assert.deepEqual(focused, [], "the closing Peek's page isn't handed the keyboard");
  assert.ok(S().tabs[a], "the page under the Peek stays");
  assert.equal(activeTabId(S(), w), a);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 1, "the completed close is counted once");
});

test("⌘W in a Peek without Find still closes the Peek, and the tab under it stays", async () => {
  const { w, a } = windowWithPeek();
  runCommand({ command: "closeTab", arg: null, windowId: w });
  await settle();
  assert.equal(shownPeek(S(), w), undefined);
  assert.ok(S().tabs[a]);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0, "a close without Find isn't counted");
});

test("with sharing off, a ⌘W close with Find open isn't counted", async () => {
  client.setSharing(false, "settings");
  takePeekMotionCounts();
  const { w, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  openFind(peek);
  runCommand({ command: "closeTab", arg: null, windowId: w }, { user: { consent: client.consentToken() } });
  await settle();
  assert.equal(shownPeek(S(), w), undefined);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0);
});

test("⌘W in a tab with Find open closes the tab", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().newTab(w, { url: "https://b.example/" });
  openFind(b);
  runCommand({ command: "closeTab", arg: null, windowId: w });
  await settle();
  assert.equal(S().tabs[b], undefined);
});

const { registerPeekMotion, finishPeek } = await import("./actions.ts");
const { escapePressed } = await import("../windows/unclaimedEscape.ts");
const sharingOn = () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takePeekMotionCounts();
};
const peekIn = (w) => {
  const source = activeTabId(S(), w);
  const peek = S().openPeek(source, `https://peek.example/${w}`, { x: 100, y: 200 });
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  return { source, peek };
};
const heldClose = (w, peek) => {
  let closes = 0;
  registerPeekMotion(w, { tabId: peek, close: async () => (closes++, true), promote: async () => true });
  return () => closes;
};
const closeKey = (w) => runCommand({ command: "closeTab", arg: null, windowId: w }, { user: { consent: client.consentToken() } });

test("a second ⌘W while the first close is still animating doesn't erase it: the Peek is counted once when it goes", async () => {
  sharingOn();
  const { w, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  const closes = heldClose(w, peek);
  openFind(peek);
  closeKey(w);
  closeKey(w);
  assert.ok(closes() >= 1, "the close animation started");
  finishPeek(peek);
  await settle();
  assert.equal(shownPeek(S(), w), undefined);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 1);
});

test("two windows closing their Peeks with Find open at the same time each count", async () => {
  sharingOn();
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w1 = S().createWindow({ url: "https://one.example/" });
  const w2 = S().createWindow({ url: "https://two.example/" });
  const one = peekIn(w1), two = peekIn(w2);
  heldClose(w1, one.peek);
  heldClose(w2, two.peek);
  openFind(one.peek);
  openFind(two.peek);
  closeKey(w1);
  closeKey(w2);
  finishPeek(one.peek);
  finishPeek(two.peek);
  await settle();
  assert.equal(shownPeek(S(), w1), undefined);
  assert.equal(shownPeek(S(), w2), undefined);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 2);
});

test("a late close of a Peek another link replaced counts nothing and leaves the new Peek open", async () => {
  sharingOn();
  const { w, a, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  heldClose(w, peek);
  openFind(peek);
  closeKey(w);
  const replacement = S().openPeek(a, "https://peek.example/next", { x: 100, y: 200 });
  assert.notEqual(replacement, peek);
  finishPeek(peek);
  await settle();
  assert.equal(shownPeek(S(), w)?.tabId, replacement, "the replacement survives");
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0);
});

test("Esc with a Peek's Find bar open closes only Find, keeps the Peek and gives its page the keyboard, wherever the keyboard was", async () => {
  const { closeFind } = await import("../find/actions.ts");
  for (const where of ["find field", "Peek page", "window"]) {
    const { w, a, peek } = windowWithPeek();
    const focused = [];
    webviews.set(peek, { focus: async () => void focused.push(peek), stopFinding: async () => {} });
    openFind(peek);
    if (where === "find field") closeFind(peek);
    else escapePressed(where === "Peek page" ? peek : a, where === "Peek page" ? "page" : "window");
    await settle();
    assert.equal(S().find[peek]?.open, false, `${where}: Find closed`);
    assert.equal(shownPeek(S(), w)?.tabId, peek, `${where}: the same Peek stays open`);
    assert.deepEqual(focused, [peek], `${where}: its page has the keyboard`);
    escapePressed(a, "window");
    await settle();
    assert.equal(shownPeek(S(), w), undefined, `${where}: the next Esc closes the Peek`);
  }
});

test("⌘W pressed while a Close-button close is already animating takes no credit for it", async () => {
  sharingOn();
  const { w, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  heldClose(w, peek);
  openFind(peek);
  const { dismissPeek } = await import("./actions.ts");
  dismissPeek(w);
  closeKey(w);
  finishPeek(peek);
  await settle();
  assert.equal(shownPeek(S(), w), undefined);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0);
});

test("a close that never completes leaves nothing behind once its Peek is replaced or its window closes", async () => {
  const { trackedPeekCloses, startPeeks } = await import("./actions.ts");
  startPeeks();
  sharingOn();
  const { w, a, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  heldClose(w, peek);
  openFind(peek);
  closeKey(w);
  assert.ok(trackedPeekCloses() > 0, "the close is pending while it animates");
  S().openPeek(a, "https://peek.example/replacement", { x: 100, y: 200 });
  await settle();
  assert.equal(trackedPeekCloses(), 0, "replacing the Peek forgets its pending close");
  const second = shownPeek(S(), w).tabId;
  webviews.set(second, { focus: async () => {}, stopFinding: async () => {} });
  heldClose(w, second);
  openFind(second);
  closeKey(w);
  assert.ok(trackedPeekCloses() > 0);
  S().closeWindow(w);
  await settle();
  assert.equal(trackedPeekCloses(), 0, "closing the window forgets it too");
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0);
});

const replyLater = (w, peek) => {
  const replies = [];
  registerPeekMotion(w, { tabId: peek, close: () => new Promise((resolve) => replies.push(resolve)), promote: async () => true });
  return (accepted) => replies.shift()(accepted);
};

test("a ⌘W the motion refuses takes no credit even when a pinch close finishes before the refusal arrives", async () => {
  sharingOn();
  const { w, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  const reply = replyLater(w, peek);
  openFind(peek);
  closeKey(w);
  finishPeek(peek);
  reply(false);
  await settle();
  assert.equal(shownPeek(S(), w), undefined, "the pinch closed it");
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0);
  const { trackedPeekCloses } = await import("./actions.ts");
  assert.equal(trackedPeekCloses(), 0, "nothing is kept once the refusal arrives");
});

test("a ⌘W close counts once it is both accepted and finished, in either order", async () => {
  for (const order of ["finished first", "accepted first"]) {
    sharingOn();
    const { w, peek } = windowWithPeek();
    webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
    const reply = replyLater(w, peek);
    openFind(peek);
    closeKey(w);
    if (order === "finished first") {
      finishPeek(peek);
      await settle();
      assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0, `${order}: not before the motion accepts it`);
      reply(true);
    } else {
      reply(true);
      await settle();
      assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0, `${order}: not before it finishes`);
      finishPeek(peek);
    }
    await settle();
    assert.equal(shownPeek(S(), w), undefined);
    assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 1, order);
  }
});
