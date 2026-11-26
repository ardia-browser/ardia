import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { forgetPeekStage, notePeekStageState, pressPeekChrome, pressPeekScrim } = await import("./gesturePresses.ts");
after(() => client.setSharing(false, "settings"));
const S = () => useBrowser.getState();

async function sentPresses() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  return events.reduce((sum, e) => sum + (e.peek_chrome_presses_mid_gesture ?? 0), 0);
}

function windowWithTwoPeeks() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const hidden = S().openPeek(b, "https://peek.example/b");
  S().activate(a);
  const shown = S().openPeek(a, "https://peek.example/a");
  return { w, shown, hidden };
}

test("a bar button pressed while the shown card is pinched or settling runs and is counted, even when a hidden card in the window settles", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  const { w, shown, hidden } = windowWithTwoPeeks();
  let ran = 0;
  notePeekStageState(shown, "gesture");
  notePeekStageState(hidden, "settling");
  notePeekStageState(hidden, "open");
  pressPeekChrome(w, "bar", () => ran++);
  notePeekStageState(shown, "settling");
  pressPeekChrome(w, "bar", () => ran++);
  assert.equal(ran, 2);
  assert.equal((await sentPresses()) - before, 2);
});

test("spread to +0.25: the top bar has faded out and takes no press, while the side buttons on the still-visible dim keep working", async () => {
  client.setSharing(true, "onboarding");
  const { w, shown } = windowWithTwoPeeks();
  const ran = { bar: 0, side: 0 };
  notePeekStageState(shown, "gesture", { chromeShown: false, scrimShown: true });
  pressPeekChrome(w, "bar", () => ran.bar++);
  pressPeekChrome(w, "side", () => ran.side++);
  assert.deepEqual(ran, { bar: 0, side: 1 });
  notePeekStageState(shown, "settling", { chromeShown: true, scrimShown: true });
  pressPeekChrome(w, "bar", () => ran.bar++);
  assert.equal(ran.bar, 1, "the bar works again once it is back");
});

test("pinch in to -0.70: the card and its bar are invisible, so a held Close released then does nothing, and the faded dim's side buttons don't either", async () => {
  client.setSharing(true, "onboarding");
  const { w, shown } = windowWithTwoPeeks();
  const ran = { bar: 0, side: 0 };
  notePeekStageState(shown, "gesture", { chromeShown: false, scrimShown: false });
  pressPeekChrome(w, "bar", () => ran.bar++);
  pressPeekChrome(w, "side", () => ran.side++);
  assert.deepEqual(ran, { bar: 0, side: 0 });
});

test("a dim press held from visible into an invisible scrim does not dismiss on release, and runs again once the scrim is shown", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  const { w, shown, hidden } = windowWithTwoPeeks();
  let dismissed = 0;
  notePeekStageState(shown, "open", { chromeShown: true, scrimShown: true });
  notePeekStageState(hidden, "open", { chromeShown: true, scrimShown: true });
  notePeekStageState(shown, "gesture", { chromeShown: false, scrimShown: false });
  pressPeekScrim(w, () => dismissed++);
  assert.equal(dismissed, 0, "releasing a press started on the visible dim after pinching the scrim away does not dismiss");
  notePeekStageState(shown, "gesture", { chromeShown: false, scrimShown: true });
  pressPeekScrim(w, () => dismissed++);
  assert.equal(dismissed, 1, "a dim press still dismisses while the scrim is visible");
  notePeekStageState(shown, "open", { chromeShown: true, scrimShown: true });
  pressPeekScrim(w, () => dismissed++);
  assert.equal(dismissed, 2);
  assert.equal((await sentPresses()) - before, 0, "dim presses are not counted as mid-gesture chrome button presses");
});

test("a press on a card at rest, after its stage is forgotten, or with sharing off isn't counted, and still runs", async () => {
  client.setSharing(true, "onboarding");
  const before = await sentPresses();
  const { w, shown } = windowWithTwoPeeks();
  let ran = 0;
  notePeekStageState(shown, "open");
  pressPeekChrome(w, "bar", () => ran++);
  notePeekStageState(shown, "gesture");
  forgetPeekStage(shown);
  pressPeekChrome(w, "bar", () => ran++);
  assert.equal((await sentPresses()) - before, 0);
  client.setSharing(false, "settings");
  notePeekStageState(shown, "gesture");
  pressPeekChrome(w, "bar", () => ran++);
  assert.equal(ran, 3);
  client.setSharing(true, "onboarding");
  assert.equal(await sentPresses(), 0, "the press made while sharing was off never reaches the queue");
});
