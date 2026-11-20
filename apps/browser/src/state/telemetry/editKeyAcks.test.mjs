import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events
    .filter((e) => e.event === "usage_counts")
    .map((e) => Object.fromEntries(Object.entries(e.properties).filter(([key]) => key.startsWith("edit_key_acks") || key.startsWith("paste_match_style"))));
}

test("edit keys a page handed back are sent with the hourly counts, accepted or refused and after a handback apart, Paste and Match Style by its key, odd values become 0, taken once", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  stub.editKeyAcks.pending = { accepted: 5, refused: 1, afterHandbackAccepted: 2, afterHandbackRefused: 0.5, pasteMatchStyleKeys: 3, pasteMatchStyleOptionKeys: 4, pasted: 9, bogus: -2 };
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [
    { edit_key_acks_accepted: 5, edit_key_acks_refused: 1, edit_key_acks_after_handback_accepted: 2, edit_key_acks_after_handback_refused: 0, paste_match_style_keys: 3, paste_match_style_option_keys: 4 },
  ]);
  assert.deepEqual(stub.editKeyAcks.pending, {});
});
