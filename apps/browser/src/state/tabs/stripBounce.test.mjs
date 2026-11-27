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
const attributesOf = (log) =>
  Object.fromEntries(
    log.attributes
      .filter(({ key }) => !key.startsWith("$"))
      .map(({ key, value }) => [key, "intValue" in value ? Number(value.intValue) : "boolValue" in value ? value.boolValue : value.stringValue]),
  );
const counts = (over = {}) => ({
  strip_bounces_back: 0,
  strip_bounces_back_pip: 0,
  strip_bounces_back_native_press: 0,
  strip_bounces_elsewhere: 0,
  strip_bounces_back_did_activate_tab: 0,
  strip_bounces_back_did_insert_tab: 0,
  strip_bounces_back_did_remove_tab: 0,
  strip_bounces_back_attach: 0,
  strip_bounces_back_group_observer: 0,
  strip_bounces_back_none: 0,
  strip_bounces_back_other: 0,
  ...over,
});
const bounce = (context) => {
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 1800, context);
};

test("Chromium's strip taking the window back to the tab just left within 2 s counts as a bounce, with its flags", async () => {
  sharing();
  useMedia.setState({ pipOpen: { video: "video" } });
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 1800);
  assert.deepEqual(takeStripBounceCounts(), counts({ strip_bounces_back: 1, strip_bounces_back_pip: 1, strip_bounces_back_none: 1 }));
  const logs = await loggedBounces();
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs[0]), /"ms"[^}]*800/);
  assert.match(JSON.stringify(logs[0]), /"tile"[^}]*true/);
  useMedia.setState({ pipOpen: {} });
});

test("a strip change later than 2 s, or one not following a switch, is not a bounce", () => {
  sharing();
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 3500, { trigger: "didActivateTab" });
  judgeStripSelection(state("video"), state("notes"), 3600, { trigger: "didActivateTab" });
  assert.deepEqual(takeStripBounceCounts(), counts());
});

test("the strip picking a third tab right after a switch counts apart, and each switch is judged once", () => {
  sharing();
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("other"), 1200, { trigger: "didInsertTab" });
  judgeStripSelection(state("other"), state("video"), 1300, { trigger: "didInsertTab" });
  assert.deepEqual(takeStripBounceCounts(), counts({ strip_bounces_elsewhere: 1 }));
});

test("the warning names the native step, whether it was postponed and what the strip was waiting for", async () => {
  sharing();
  const before = (await loggedBounces()).length;
  bounce({
    trigger: "didActivateTab", deferred: true, deferredBehind: 1, msSinceAck: 12, inflight: "arrange", pendingActive: true, hasSibling: true, activeFallback: true,
  });
  assert.deepEqual(takeStripBounceCounts(), counts({ strip_bounces_back: 1, strip_bounces_back_did_activate_tab: 1 }));
  const logs = await loggedBounces();
  assert.equal(logs.length, before + 1);
  assert.deepEqual(attributesOf(logs.at(-1)), {
    ms: 800, nativePress: false, pictureInPicture: false, tile: true,
    trigger: "didActivateTab", deferred: true, inflight: "arrange", pendingActive: true, hasSibling: true, activeFallback: true, msSinceAck: 12, deferredBehind: 1,
  });
});

test("a report that says nothing logs the new fields as unknown, not as absent", async () => {
  sharing();
  bounce(undefined);
  const logs = await loggedBounces();
  assert.deepEqual(attributesOf(logs.at(-1)), {
    ms: 800, nativePress: false, pictureInPicture: false, tile: true,
    trigger: "none", deferred: false, inflight: "none", pendingActive: false, hasSibling: false, activeFallback: false,
  });
});

test("each bounce is counted under its trigger; a trigger the app doesn't know is other, none is none", () => {
  sharing();
  for (const trigger of ["didActivateTab", "didInsertTab", "didRemoveTab", "attach", "groupObserver", "groupObserver"]) bounce({ trigger });
  bounce({ trigger: "somethingNew" });
  bounce({ trigger: "constructor" });
  bounce({ trigger: 7 });
  bounce({});
  bounce({ trigger: "none" });
  assert.deepEqual(
    takeStripBounceCounts(),
    counts({
      strip_bounces_back: 11,
      strip_bounces_back_did_activate_tab: 1,
      strip_bounces_back_did_insert_tab: 1,
      strip_bounces_back_did_remove_tab: 1,
      strip_bounces_back_attach: 1,
      strip_bounces_back_group_observer: 2,
      strip_bounces_back_none: 2,
      strip_bounces_back_other: 3,
    }),
  );
});

test("a bounce to another tab is counted as elsewhere only, not under a trigger", () => {
  sharing();
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("other"), 1200, { trigger: "didRemoveTab" });
  assert.deepEqual(takeStripBounceCounts(), counts({ strip_bounces_elsewhere: 1 }));
});

test("the warning carries no tab, key or address, and a trigger outside the list is logged as other", async () => {
  sharing();
  await loggedBounces();
  bounce({ trigger: "https://example.com/secret?token=abc", msSinceAck: 5 });
  assert.deepEqual(takeStripBounceCounts(), counts({ strip_bounces_back: 1, strip_bounces_back_other: 1 }));
  const [log] = (await loggedBounces()).slice(-1);
  assert.equal(attributesOf(log).trigger, "other");
  const text = JSON.stringify(log.attributes);
  for (const leaked of ["example.com", "secret", "token", "w1"]) assert.ok(!text.includes(leaked), `${leaked} must not be logged`);
});

test("nothing is counted while sharing is off", () => {
  client.setSharing(false, "settings");
  recordSelectionByApp(state("video"), state("notes"), client.consentToken(), 1000);
  judgeStripSelection(state("notes"), state("video"), 1100, { trigger: "didActivateTab", deferred: true });
  assert.deepEqual(takeStripBounceCounts(), counts());
});
