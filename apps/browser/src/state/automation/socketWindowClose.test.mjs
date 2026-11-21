import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { openLittleArdia } = await import("../littleArdia/actions.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const originalConfirm = dialogs.confirm;
after(() => {
  dialogs.confirm = originalConfirm;
  S().updateSettings({ cliControl: false });
});

const { fire, call } = socketClient(51);
const other = socketClient(52);
const asked = [];

function answerWith(answer) {
  asked.length = 0;
  dialogs.confirm = (options) => {
    asked.push(options);
    return Promise.resolve(typeof answer === "function" ? answer(options) : answer);
  };
}

const withTabs = (windowId) => {
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
};

test("windows.close refuses when Ardia would have to ask and nobody can see the question", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  withTabs(windowId);
  S().updateSettings({ warnBeforeClosingWindow: true });
  answerWith((options) => (options.onlyIfShown ? { confirmed: false, suppressed: false, unshown: true } : { confirmed: true, suppressed: false }));
  const reply = await call("windows.close", { window: windowId });
  assert.equal(reply.error?.code, "refused");
  assert.match(reply.error.message, /nobody can see/);
  assert.ok(S().windows[windowId], "the window stayed open");
  assert.equal(asked[0]?.onlyIfShown, true, "the socket asked only where the question can be seen");
  assert.equal(S().settings.warnBeforeClosingWindow, true);
  dialogs.confirm = originalConfirm;
});

test("two windows.close calls at once keep the last window to reopen", async () => {
  const { windowId: first } = await freshWindow();
  const second = S().createWindow({ url: "https://two.example/" });
  S().updateSettings({ warnBeforeClosingWindow: false });
  const closedBefore = S().closedWindows.length;
  const replies = await Promise.all([fire("windows.close", { window: first }), other.fire("windows.close", { window: second })]);
  for (const reply of replies) assert.ok(!reply.error, JSON.stringify(reply.error));
  const closed = S().closedWindows.slice(closedBefore);
  assert.equal(closed.length, 2);
  assert.equal(closed.filter((c) => c.lastWindow).length, 1, "one of them is kept as the last window");
});

test("a second close of a window already closing or asking is refused, as the UI's guard does", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  withTabs(windowId);
  S().updateSettings({ warnBeforeClosingWindow: true });
  const answers = [];
  dialogs.confirm = () => new Promise((resolve) => answers.push(resolve));
  const firstClose = fire("windows.close", { window: windowId });
  for (let i = 0; i < 20 && !answers.length; i++) await tick();
  const again = await other.call("windows.close", { window: windowId });
  assert.equal(again.error?.code, "refused");
  assert.match(again.error.message, /already closing/);
  answers[0]({ confirmed: true, suppressed: false });
  const firstReply = await firstClose;
  assert.ok(!firstReply.error, JSON.stringify(firstReply.error));
  dialogs.confirm = originalConfirm;
});

test("littleArdia.close answers only once its quit prompt is answered, and refuses on Cancel", async () => {
  await freshWindow();
  for (const id of [...S().windowOrder]) S().closeWindow(id);
  const little = openLittleArdia("https://l.example/");
  const quits = PLATFORM_FEATURES.quitsWithLastWindow;
  PLATFORM_FEATURES.quitsWithLastWindow = true;
  S().updateSettings({ warnBeforeQuitting: true });
  const windowIds = shellNativeModules.ArdiaAppWindows.windowIds;
  shellNativeModules.ArdiaAppWindows.windowIds = () => Promise.resolve([little]);
  answerWith({ confirmed: false, suppressed: false });
  try {
    const reply = await call("littleArdia.close", { window: little });
    assert.equal(asked.length, 1, "Ardia asked before quitting");
    assert.equal(reply.error?.code, "refused", "Cancel leaves it open, so the reply can't say ok");
    assert.ok(S().windows[little], "Little Ardia stayed open");
    answerWith({ confirmed: true, suppressed: false });
    const closed = await call("littleArdia.close", { window: little });
    assert.ok(!closed.error, JSON.stringify(closed.error));
    assert.equal(S().windows[little], undefined, "the reply came after the window closed");
  } finally {
    PLATFORM_FEATURES.quitsWithLastWindow = quits;
    shellNativeModules.ArdiaAppWindows.windowIds = windowIds;
    dialogs.confirm = originalConfirm;
  }
});
