import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const track = await import("./track.ts");
const presses = await import("./tabPresses.ts");
const { noteLinuxDownloadsPanelInsidePress } = await import("./downloadsPanelCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sent(event) {
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === event).map((e) => e.properties);
}

function beWhileOff() {
  noteLinuxDownloadsPanelInsidePress();
  usage.noteImportedPins({ rows: 3, splits: 1 });
  stub.editKeyAcks.pending = { accepted: 4 };
  for (let i = 0; i < 20; i++) track.sampleOmniboxLatency(track.omniboxKeyHeard() - 12);
  track.noteSearchSuggest("ok");
  presses.notePressStarted();
  presses.notePressEnded("click");
}

test("nothing counted while sharing was off is sent once sharing turns on, in usage_counts, perf_omnibox or tab_presses", async () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  beWhileOff();
  client.setSharing(true, "settings");
  usage.sessionEnding();
  const counts = await sent("usage_counts");
  assert.ok(counts.every((p) => !p.imported_pinned_rows && !p.imported_splits && !p.edit_key_acks_accepted && !p.linux_downloads_panel_inside_presses), JSON.stringify(counts));
  assert.deepEqual(await sent("perf_omnibox"), []);
  assert.deepEqual(await sent("tab_presses"), []);
});

test("what is counted after sharing turns on is sent", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  noteLinuxDownloadsPanelInsidePress();
  usage.noteImportedPins({ rows: 2, splits: 0 });
  stub.editKeyAcks.pending = { accepted: 1 };
  presses.notePressStarted();
  presses.notePressEnded("click");
  usage.sessionEnding();
  const last = (await sent("usage_counts")).at(-1);
  assert.deepEqual([last.imported_pinned_rows, last.edit_key_acks_accepted], [2, 1]);
  assert.equal(last.linux_downloads_panel_inside_presses, 1);
  assert.equal((await sent("tab_presses")).at(-1).presses, 1);
});

test("turning sharing off and on again drops what was counted before", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  for (let i = 0; i < 7; i++) noteLinuxDownloadsPanelInsidePress();
  usage.noteImportedPins({ rows: 7, splits: 0 });
  stub.focusHandoffCounts.pending = { delivered: 3 };
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteLinuxDownloadsPanelInsidePress();
  noteLinuxDownloadsPanelInsidePress();
  usage.sessionEnding();
  assert.ok((await sent("usage_counts")).every((p) => p.imported_pinned_rows !== 7 && !p.focus_handoffs_delivered));
  assert.equal((await sent("usage_counts")).at(-1).linux_downloads_panel_inside_presses, 2);
});
