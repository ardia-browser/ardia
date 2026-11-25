import assert from "node:assert/strict";
import { mock, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { startPinHandoff } = await import("./pinHandoff.ts");
const { webviews, webviewRef } = await import("../../platform/webviews.ts");
const { withLivePage } = await import("../tabs/livePage.ts");

const S = () => useBrowser.getState();
const tileOf = (w, url) => model.viewTabIds(S(), w).find((id) => !!S().tabs[id].pin && S().tabs[id].pinnedUrl === url);
const settled = () => new Promise((r) => setImmediate(r));
const advance = async (ms) => {
  for (let t = 0; t < ms; t += 10) {
    mock.timers.tick(10);
    await settled();
  }
};
const until = async (test, ms = 2000) => {
  for (let t = 0; !test() && t < ms; t += 10) {
    mock.timers.tick(10);
    await settled();
  }
  return test();
};

function twoWindows() {
  S().hydrate({});
  const a = S().createWindow({ url: "https://mail.com" });
  const [mail] = S().windows[a].tabIds;
  S().newTab(a, { url: "https://a.com" });
  S().pinTabs([mail], true);
  S().activate(mail);
  const b = S().createWindow({ url: "https://b.com" });
  return { a, b, mail };
}

const page = (calls, slow = 0) => ({
  capturePicture: () => new Promise((r) => setTimeout(() => r({ data: "AA", frame: [0, 0, 1, 1] }), slow)),
  goBack: () => calls.push("back"),
  reload: () => calls.push("reload"),
});

mock.timers.enable({ apis: ["setTimeout"] });
startPinHandoff();

test("a handoff still capturing loses to anything the user does in that window meanwhile", async () => {
  const { a, b, mail } = twoWindows();
  webviewRef(mail)(page([], 80));
  const copy = tileOf(b, "https://mail.com");
  const regular = S().windows[b].activeTabIds.default;
  S().activate(copy);
  S().activate(regular);
  S().activate(regular);
  await advance(400);
  assert.equal(S().tabs[mail].windowId, a, "switching away and back cancels the pending move");

  S().activate(copy);
  S().openPanel(b);
  await advance(400);
  assert.equal(S().tabs[mail].windowId, a, "opening the command bar cancels it too");
  assert.equal(S().windowUi[b].panel.open, true, "and the command bar stays open");

  S().closePanel(b);
  S().activate(copy);
  assert.ok(await until(() => S().tabs[mail].windowId === b), "an undisturbed request moves the page");
  webviews.delete(mail);
});

test("Back, Forward or Reload on a frozen copy pull the page back, then run on it there", async () => {
  const { a, b, mail } = twoWindows();
  webviewRef(mail)(page([]));
  S().activate(tileOf(b, "https://mail.com"));
  assert.ok(await until(() => S().tabs[mail].windowId === b));
  const frozen = S().windows[a].activeTabIds.default;
  assert.equal(S().tabs[frozen].page.holderId, mail);
  S().updateLive(mail, { canGoBack: true });
  const calls = [];
  withLivePage(frozen, (p) => p.goBack());
  assert.ok(await until(() => S().tabs[mail].windowId === a), "the page comes back to A");
  webviewRef(mail)(page(calls));
  assert.ok(await until(() => calls.length > 0), "and Back runs on it once it arrived");
  assert.deepEqual(calls, ["back"]);
  webviews.delete(mail);
});

test("Back on a frozen copy is dropped for good if its pull-back is cancelled, even when the pin is selected again", async () => {
  const { a, b, mail } = twoWindows();
  webviewRef(mail)(page([]));
  S().activate(tileOf(b, "https://mail.com"));
  assert.ok(await until(() => S().tabs[mail].windowId === b));
  const frozen = S().windows[a].activeTabIds.default;
  const other = model.viewTabIds(S(), a).find((id) => !S().tabs[id].pin);
  const calls = [];
  webviewRef(mail)(page(calls, 80));
  void withLivePage(frozen, (p) => p.goBack());
  S().activate(other);
  await advance(150);
  S().activate(frozen);
  assert.ok(await until(() => S().tabs[mail].windowId === a), "the later selection brings the page over");
  webviewRef(mail)(page(calls));
  await advance(400);
  assert.deepEqual(calls, [], "the cancelled Back never runs");
  webviews.delete(mail);
});

async function doubleClickTile(windowId, tabId) {
  const held = await import("../sidebar/heldTabPress.ts");
  const { refreshShownTile } = await import("../sidebar/actions.ts");
  const click = () => {
    const e = { nativeEvent: { identifier: "0", pageX: 20, pageY: 20 }, touchHistory: { touchBank: [{ startTimeStamp: performance.now() + Math.random() }] } };
    const press = held.holdTabPress(windowId, tabId, e);
    held.clickHeldTabPress(windowId, tabId, e, press, (wasShown) => refreshShownTile(windowId, tabId, wasShown));
  };
  held.endHeldTabPress([], null);
  click();
  click();
}

function pageAwayInB() {
  const { a, b, mail } = twoWindows();
  const calls = [];
  webviewRef(mail)({ ...page(calls, 80), loadUrl: () => {} });
  S().updateTab(mail, { url: "https://mail.com/inbox" }, { isLoading: false });
  const copy = tileOf(b, "https://mail.com");
  return { a, b, mail, copy, calls };
}

function watchNavigations() {
  const real = S().navigate;
  const seen = [];
  useBrowser.setState({ navigate: (id, url, options) => (seen.push([id, url]), real(id, url, options)) });
  return { seen, stop: () => useBrowser.setState({ navigate: real }) };
}

test("both clicks of a double-click landing before a shared pin's page arrives still take it back to the pinned URL once it does", async () => {
  const { b, mail, copy, calls } = pageAwayInB();
  const navs = watchNavigations();
  try {
    await doubleClickTile(b, copy);
    assert.notEqual(S().tabs[mail].windowId, b, "the capture is still running: the page hasn't moved yet");
    assert.deepEqual(navs.seen, []);
    assert.ok(await until(() => S().tabs[mail].windowId === b && model.activeTabId(S(), b) === mail), "then the page lands in B");
    assert.ok(await until(() => navs.seen.length > 0), "and goes back");
    assert.deepEqual(navs.seen, [[mail, "https://mail.com"]], "to its pinned URL, once");
    assert.deepEqual(calls, [], "without a reload");
  } finally {
    navs.stop();
    webviews.delete(mail);
  }
});

test("a double-click on a selected frozen copy pulls its page across and never reloads it", async () => {
  const { a, b, mail } = twoWindows();
  webviewRef(mail)(page([]));
  S().activate(tileOf(b, "https://mail.com"));
  assert.ok(await until(() => S().tabs[mail].windowId === b));
  const frozen = S().windows[a].activeTabIds.default;
  assert.equal(S().tabs[frozen].page.holderId, mail, "A shows a frozen copy, selected");
  const calls = [];
  webviewRef(mail)(page(calls, 80));
  await doubleClickTile(a, frozen);
  assert.notEqual(S().tabs[mail].windowId, a, "the swap hasn't finished by the second click");
  assert.ok(await until(() => S().tabs[mail].windowId === a && model.activeTabId(S(), a) === mail), "the page lands in A");
  webviewRef(mail)(page(calls));
  await advance(400);
  assert.deepEqual(calls, [], "and isn't reloaded once it mounts there");
  webviews.delete(mail);
});

test("a double-click whose page never arrives does nothing once the wait runs out", async () => {
  const { b, mail, copy, calls } = pageAwayInB();
  const navs = watchNavigations();
  try {
    await doubleClickTile(b, copy);
    S().activate(S().windows[b].tabIds.find((id) => !S().tabs[id].pin));
    await advance(3500);
    assert.deepEqual(calls, []);
    assert.deepEqual(navs.seen, [], "nothing went back once the user moved on");
  } finally {
    navs.stop();
    webviews.delete(mail);
  }
});

test("a double-click whose hand-off is cancelled never resets the page a later single click brings across", async () => {
  const { b, mail, copy, calls } = pageAwayInB();
  const navs = watchNavigations();
  try {
    await doubleClickTile(b, copy);
    S().openPanel(b);
    await advance(400);
    assert.notEqual(S().tabs[mail].windowId, b, "opening the command bar cancelled the hand-off");
    S().closePanel(b);
    S().activate(copy);
    assert.ok(await until(() => S().tabs[mail].windowId === b && model.activeTabId(S(), b) === mail, 1000), "the single click brings the page across");
    await advance(200);
    assert.deepEqual(navs.seen, [], "and it stays where it was");
    assert.deepEqual(calls, []);
  } finally {
    navs.stop();
    webviews.delete(mail);
  }
});
