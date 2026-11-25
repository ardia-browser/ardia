import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
const { useMedia } = await import("../media/media.ts");
const { recordSelectionByApp, judgeStripSelection, takeStripBounceCounts } = await import("./stripBounce.ts");

const state = (selected, extra = {}) => ({
  windows: { w1: { id: "w1", profileId: "default", activeTabIds: { default: selected } } },
  tabs: { video: { id: "video", pin: { as: "tile" } }, notes: { id: "notes", pin: null }, other: { id: "other", pin: null } },
  ...extra,
});
const sharing = () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeStripBounceCounts();
};
const loggedBounces = async () => {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"logs":[]}');
  return (saved.logs ?? []).filter((l) => /tab strip selected/.test(JSON.stringify(l)));
};

test("Chromium's strip taking the window back to the tab just left within 2 s counts as a bounce, with its flags", async () => {
  sharing();
  useMedia.setState({ pipOpen: { video: "video" } });
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 1800);
  assert.deepEqual(takeStripBounceCounts(), { strip_bounces_back: 1, strip_bounces_back_pip: 1, strip_bounces_back_native_press: 0, strip_bounces_elsewhere: 0 });
  const logs = await loggedBounces();
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs[0]), /"ms"[^}]*800/);
  assert.match(JSON.stringify(logs[0]), /"tile"[^}]*true/);
  useMedia.setState({ pipOpen: {} });
});

test("a strip change later than 2 s, or one not following a switch, is not a bounce", () => {
  sharing();
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 3500);
  judgeStripSelection(state("video"), state("notes"), 3600);
  assert.deepEqual(takeStripBounceCounts(), { strip_bounces_back: 0, strip_bounces_back_pip: 0, strip_bounces_back_native_press: 0, strip_bounces_elsewhere: 0 });
});

test("the strip picking a third tab right after a switch counts apart, and each switch is judged once", () => {
  sharing();
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("other"), 1200);
  judgeStripSelection(state("other"), state("video"), 1300);
  assert.deepEqual(takeStripBounceCounts(), { strip_bounces_back: 0, strip_bounces_back_pip: 0, strip_bounces_back_native_press: 0, strip_bounces_elsewhere: 1 });
});

test("nothing is counted while sharing is off", () => {
  client.setSharing(false, "settings");
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 1100);
  assert.deepEqual(takeStripBounceCounts(), { strip_bounces_back: 0, strip_bounces_back_pip: 0, strip_bounces_back_native_press: 0, strip_bounces_elsewhere: 0 });
});
