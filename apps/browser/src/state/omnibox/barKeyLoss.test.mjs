import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { cancelPanel } = await import("./barState.ts");
const { showNewTabBar, startNewTabBar } = await import("./newTabBar.ts");
const { barBlurred, barRefocused, heldBars, releaseBarHold, watchBarField } = await import("./barKeyLoss.ts");
const linux = await import("../../lib/platformFeatures.linux.ts");
const win = await import("../../lib/platformFeatures.win.ts");
const mac = await import("../../lib/platformFeatures.ts");
after(() => client.setSharing(false, "settings"));
startNewTabBar();

const S = () => useBrowser.getState();
const panel = (w) => S().windowUi[w]?.panel ?? { open: false };
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

function bar(windowId, { newTab = false } = {}) {
  if (newTab) assert.equal(showNewTabBar(windowId), true);
  else S().openPanel(windowId, "https://a.com/");
  assert.equal(panel(windowId).open, true);
  return () => cancelPanel(windowId);
}

const OTHER_FIELD = 99;
const fieldOf = (windowId) => 10 + windows.indexOf(windowId);
const blur = (windowId, cancel, cause) => (stub.fieldBlurCauses.set(fieldOf(windowId), [cause]), barBlurred(windowId, fieldOf(windowId), cancel));
const focusWindow = (id, restored, field = restored ? fieldOf(id) : undefined) => stub.windows.emit({ type: "focus", id, restored, field });

async function totals() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  const sum = (key) => events.reduce((total, e) => total + (e[key] ?? 0), 0);
  return { held: sum("command_bar_key_loss_holds"), restored: sum("command_bar_focus_restores"), closed: sum("command_bar_key_loss_closes") };
}

async function counting() {
  const before = await totals();
  return async () => {
    const now = await totals();
    return { held: now.held - before.held, restored: now.restored - before.restored, closed: now.closed - before.closed };
  };
}

let windows;
beforeEach(() => {
  client.setSharing(true, "onboarding");
  stub.fieldBlurCauses.clear();
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  S().updateSettings({ newTabOpens: "commandBar" });
  windows = [S().createWindow({ url: "https://a.com/" }), S().createWindow({ url: "https://b.com/" })];
});

test("an in-window blur closes the bar at once, even when the window loses key right after, in either event order", async () => {
  const [a] = windows;
  const cancel = bar(a);
  blur(a, cancel, "inWindow");
  assert.equal(panel(a).open, false, "the blur stamped in-window closes the bar");
  stub.emitAppEvent({ type: "resignActive" });
  assert.equal(panel(a).open, false);

  const again = bar(a, { newTab: true });
  stub.emitAppEvent({ type: "resignActive" });
  stub.fieldBlurCauses.set(fieldOf(a), ["inWindow"]);
  barBlurred(a, fieldOf(a), again);
  assert.equal(panel(a).open, false, "key loss seen first does not keep a bar whose blur was in-window");
  assert.deepEqual(heldBars(), []);
});

test("a key-loss blur keeps the bar and a quick return gives it focus back, with the window focus before or after the field focus", async () => {
  const [a] = windows;
  const counted = await counting();
  const cancel = bar(a, { newTab: true });
  blur(a, cancel, "keyLoss");
  assert.equal(panel(a).open, true, "Raycast or ⌘Tab taking the keyboard keeps the New Tab bar");
  assert.deepEqual(heldBars(), [a]);
  focusWindow(a, true);
  barRefocused(a, fieldOf(a));
  assert.equal(panel(a).open, true);
  assert.deepEqual(heldBars(), []);

  blur(a, cancel, "keyLoss");
  barRefocused(a, fieldOf(a));
  focusWindow(a, true);
  assert.equal(panel(a).open, true, "the field's focus may arrive before the window's");
  assert.deepEqual(heldBars(), []);
  assert.deepEqual(await counted(), { held: 2, restored: 2, closed: 0 });
});

test("returning through another Ardia window never strands a ⌘L bar, whichever event lands first", async () => {
  const [a, b] = windows;
  const counted = await counting();
  const cancel = bar(a);
  blur(a, cancel, "keyLoss");
  assert.equal(panel(a).open, true);
  focusWindow(b, false);
  assert.equal(panel(a).open, false, "another window taking key closes the held address bar");
  focusWindow(a, false);
  assert.equal(panel(a).open, false);

  const later = bar(a);
  focusWindow(b, false);
  blur(a, later, "inWindow");
  assert.equal(panel(a).open, false, "native marks the blur in-window once another window took key, so a late blur closes it");
  assert.deepEqual(heldBars(), []);
  assert.deepEqual(await counted(), { held: 1, restored: 0, closed: 1 });
});

test("a queued in-window blur reads its own field's cause, not another field's later key loss, and another field's restore never keeps the bar", async () => {
  const [a] = windows;
  const cancel = bar(a);
  stub.fieldBlurCauses.set(fieldOf(a), ["inWindow"]);
  stub.fieldBlurCauses.set(OTHER_FIELD, ["keyLoss"]);
  barBlurred(a, fieldOf(a), cancel);
  assert.equal(panel(a).open, false, "the bar's queued blur is its own in-window one");
  assert.deepEqual(heldBars(), []);

  const held = bar(a);
  blur(a, held, "keyLoss");
  barRefocused(a, OTHER_FIELD);
  assert.deepEqual(heldBars(), [a], "another field taking focus is not the bar coming back");
  focusWindow(a, true, OTHER_FIELD);
  assert.equal(panel(a).open, false, "native restored a different field, so the bar closes instead of staying without focus");
  assert.deepEqual(heldBars(), []);
});

test("a field that blurs in-window, takes focus back and loses key before its first blur is heard reads each blur's own cause in order", () => {
  const [a] = windows;
  const cancel = bar(a);
  stub.fieldBlurCauses.set(fieldOf(a), ["inWindow", "keyLoss"]);
  barBlurred(a, fieldOf(a), cancel);
  assert.equal(panel(a).open, false, "the first blur heard is the in-window one, so the bar closes");
  assert.deepEqual(heldBars(), []);
  assert.deepEqual(stub.fieldBlurCauses.get(fieldOf(a)), ["keyLoss"], "the key loss waits for its own blur");
  const again = bar(a);
  barBlurred(a, fieldOf(a), again);
  assert.equal(panel(a).open, true, "the second blur reads the key loss");
  assert.equal(stub.fieldBlurCauses.has(fieldOf(a)), false, "a read consumes its record");
});

test("the command bar asks native to queue its field's blurs while mounted, and only then", () => {
  const unwatch = watchBarField(41);
  assert.deepEqual([...stub.watchedFieldBlurs], [41]);
  unwatch();
  assert.deepEqual([...stub.watchedFieldBlurs], []);
  watchBarField(null)();
  assert.deepEqual([...stub.watchedFieldBlurs], []);
});

test("a blur with no field tag never holds", () => {
  const [a] = windows;
  const cancel = bar(a);
  stub.fieldBlurCauses.set(fieldOf(a), ["keyLoss"]);
  barBlurred(a, null, cancel);
  assert.equal(panel(a).open, false);
});

test("switching windows counts the held New Tab bar's close once, with the production listener order", async () => {
  const [a, b] = windows;
  const counted = await counting();
  blur(a, bar(a, { newTab: true }), "keyLoss");
  focusWindow(b, false);
  assert.equal(panel(a).open, false, "newTabBar's own focus listener closes it first");
  assert.deepEqual(heldBars(), []);
  assert.deepEqual(await counted(), { held: 1, restored: 0, closed: 1 });
});

test("a held bar whose field could not take focus back closes when its window returns", async () => {
  const [a] = windows;
  const cancel = bar(a);
  blur(a, cancel, "keyLoss");
  focusWindow(a, false);
  assert.equal(panel(a).open, false);
  assert.deepEqual(heldBars(), []);
});

test("closing a window, from the store or natively, forgets its held bar", () => {
  const [a, b] = windows;
  blur(a, bar(a), "keyLoss");
  blur(b, bar(b), "keyLoss");
  assert.deepEqual(heldBars().sort(), [a, b].sort());
  S().closeWindow(a, { keepsLastWindow: true });
  assert.deepEqual(heldBars(), [b]);
  stub.windows.emit({ type: "close", id: b });
  assert.deepEqual(heldBars(), []);
});

test("an unmounted bar drops its own hold only", () => {
  const [a] = windows;
  const cancel = bar(a);
  blur(a, cancel, "keyLoss");
  releaseBarHold(a, () => {});
  assert.deepEqual(heldBars(), [a]);
  releaseBarHold(a, cancel);
  assert.deepEqual(heldBars(), []);
});

test("only the Mac holds bars on key loss; Linux and Windows keep closing on blur and on deactivation", () => {
  assert.equal(mac.PLATFORM_FEATURES.holdsBarOnKeyLoss, true);
  assert.equal(linux.PLATFORM_FEATURES.holdsBarOnKeyLoss, false);
  assert.equal(win.PLATFORM_FEATURES.holdsBarOnKeyLoss, false);
});
