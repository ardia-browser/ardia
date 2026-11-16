import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteSelectionCopiedByKey, noteUrlCopied, takeUrlCopyCounts } from "./urlCopies.ts";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });
const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

const empty = { url_copies: 0, url_copies_while_pending: 0, selection_copy_keys: 0, selection_copy_key_tabs: 0, selection_plain_copy_keys: 0 };

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("address copies are counted, those taken before the first page apart, and taking them starts over", () => {
  noteUrlCopied(false);
  noteUrlCopied(true);
  noteUrlCopied(true);
  assert.deepEqual(takeUrlCopyCounts(), { ...empty, url_copies: 3, url_copies_while_pending: 2 });
  assert.deepEqual(takeUrlCopyCounts(), empty);
});

test("taken copy counts stay isolated from later copies and caller changes", () => {
  noteUrlCopied(true);
  noteSelectionCopiedByKey(2, true);
  const taken = takeUrlCopyCounts();
  noteUrlCopied(false);
  noteSelectionCopiedByKey(3, false);
  assert.deepEqual(taken, { ...empty, url_copies: 1, url_copies_while_pending: 1, selection_copy_keys: 1, selection_copy_key_tabs: 2, selection_plain_copy_keys: 1 });
  taken.url_copies = 99;
  assert.deepEqual(takeUrlCopyCounts(), { ...empty, url_copies: 1, selection_copy_keys: 1, selection_copy_key_tabs: 3 });
});

test("selection copies respect sharing and send their counts once even without other usage", async () => {
  client.loadChoice();
  noteSelectionCopiedByKey(3, true);
  usage.sessionEnding();
  assert.deepEqual(await usageCounts(), []);
  client.setSharing(true, "onboarding");
  noteSelectionCopiedByKey(3, false);
  noteSelectionCopiedByKey(2, true);
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].selection_copy_keys, 2);
  assert.equal(sent[0].selection_copy_key_tabs, 5);
  assert.equal(sent[0].selection_plain_copy_keys, 1);
  assert.equal(sent[0].url_copies, 0);
  usage.sessionEnding();
  assert.equal((await usageCounts()).length, 1);
});
