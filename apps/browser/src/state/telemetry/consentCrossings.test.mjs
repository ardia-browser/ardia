import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const track = await import("./track.ts");
const { useMedia } = await import("../media/media.ts");
const screenShare = await import("../media/screenShare.ts");
const { webviews } = await import("../../platform/webviews.ts");
after(() => client.setSharing(false, "settings"));

const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const queuedUsage = async () => {
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "usage_counts");
};

test("a keystroke made while sharing was off is never sampled, even when another omnibox's keystroke comes after opt-in", () => {
  sharing(false);
  const commandBar = track.newOmniboxKey();
  track.omniboxKeyHeard(commandBar);
  sharing(true);
  track.takeOmniboxLatency();
  const toolbarField = track.newOmniboxKey();
  for (let i = 0; i < 4; i++) {
    track.omniboxKeyHeard(toolbarField);
    track.sampleOmniboxLatency(toolbarField);
  }
  track.omniboxKeyHeard(toolbarField);
  track.sampleOmniboxLatency(commandBar);
  assert.deepEqual(track.takeOmniboxLatency(), []);
  track.sampleOmniboxLatency(toolbarField);
  assert.equal(track.takeOmniboxLatency().length, 1, "the bar that was keyed after opt-in still samples");
});

test("a tab picked to share while sharing was off isn't counted when its source arrives after a consent change", async () => {
  sharing(true);
  await queuedUsage();
  sharing(false);
  let resolveSource = () => {};
  useMedia.setState({ displayRequests: { asker: { id: "r1", origin: "https://meet.test", controller: false, pageUrl: "https://meet.test/" } } });
  webviews.set("shared", { mediaCaptureSourceId: () => new Promise((resolve) => (resolveSource = resolve)), resolveDisplayMedia: async () => {} });
  webviews.set("asker", { resolveDisplayMedia: async () => {} });
  const picking = screenShare.shareTab("asker", "shared", false);
  sharing(true);
  resolveSource("tab:42");
  await picking;
  const picked = (await queuedUsage()).filter((e) => (e.properties.shares_picked_tab ?? 0) > 0);
  assert.deepEqual(picked, []);
  webviews.delete("shared");
  webviews.delete("asker");
});

const presses = await import("./tabPresses.ts");
const writes = await import("./sessionWrites.ts");
const local = await import("./localStore.ts");
const { telemetryLocal } = await import("../../test-native/telemetryLocal.ts");

test("tab presses, session writes and external-app requests counted with sharing off are gone after the consent change, and never reach the record, the queue or the next usage_counts", async () => {
  sharing(true);
  await queuedUsage();
  sharing(false);
  local.flushLocal();
  telemetryLocal.reset();
  presses.notePressStarted();
  presses.notePressEnded("click");
  writes.noteSessionWrite(4096, false, 2);
  track.noteExternalAppRequest(true);
  assert.equal(presses.devTabPresses().presses, 1, "the press was tallied in memory");
  sharing(true);
  assert.equal(presses.devTabPresses().presses, 0, "the change dropped the press tally");
  assert.deepEqual(Object.values(writes.takeSessionWrites()).filter(Boolean), [], "the change drained the session writes");
  assert.deepEqual(Object.values(track.takeExternalAppRequests()).filter(Boolean), [], "the change drained the external-app requests");
  const after = await queuedUsage();
  const pressEvents = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "tab_presses");
  const fields = ["session_writes", "session_kb_written", "session_pin_backups", "session_pins_backed_up", "external_app_prompts"];
  assert.deepEqual(after.flatMap((e) => fields.filter((f) => (e.properties[f] ?? 0) > 0)), []);
  assert.deepEqual(pressEvents.filter((e) => (e.properties.presses ?? 0) > 0), []);
  local.flushLocal();
  const recorded = telemetryLocal.records().filter((r) => ["usage_counts", "tab_presses"].includes(r.event));
  assert.deepEqual(recorded.filter((r) => r.sent === false), []);
  assert.deepEqual(recorded.flatMap((r) => [...fields, "presses"].filter((f) => (r.properties?.[f] ?? 0) > 0)), []);
});
