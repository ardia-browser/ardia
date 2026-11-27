import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const work = await import("./workCounts.ts");
const { takeSyncWorkCounts, withSyncWorkCounts } = work;
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

const adapter = (applied) => ({
  prefix: "b:",
  extract: () => ({ values: new Map([["b:1", 1], ["b:2", 2], ["b:3", 3]]) }),
  apply: () => applied,
});

test("shared-folder ungroup counts one action across its mirrors and respects consent periods", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const { pinKeyOf } = await import("../browser/model.ts");
  const { noteSharedGroupUngroup } = await import("./sharedGroupCounts.ts");
  client.setSharing(true, "settings");
  const s = () => useBrowser.getState();
  s().hydrate({});
  const a = s().createWindow({ url: "https://one.example/" });
  const first = s().windows[a].tabIds[0];
  const b = s().createWindow({ url: "https://two.example/" });
  s().createWindow({ url: "https://three.example/" });
  s().updateSettings({ shareTabsAcrossWindows: true });
  const group = s().groupTabs([first], { pinned: true });
  const key = pinKeyOf(s().groups[group]);
  const mirror = Object.values(s().groups).find((g) => g.windowId === b && pinKeyOf(g) === key);
  work.takeWorkCounts();
  s().ungroup(mirror.id);
  assert.equal(work.takeWorkCounts().shared_groups_ungrouped, 1);
  assert.equal(work.takeWorkCounts().shared_groups_ungrouped, 0);
  s().hydrate({});
  const only = s().createWindow({ url: "https://solo.example/" });
  s().updateSettings({ shareTabsAcrossWindows: true });
  s().ungroup(s().groupTabs([s().windows[only].tabIds[0]], { pinned: true }));
  assert.equal(work.takeWorkCounts().shared_groups_ungrouped, 0, "a folder in one window is not counted");
  s().hydrate({});
  const c = s().createWindow({ url: "https://four.example/" });
  const d = s().createWindow({ url: "https://five.example/" });
  s().updateSettings({ shareTabsAcrossWindows: true });
  const pinned = s().groupTabs([s().windows[c].tabIds[0]], { pinned: true });
  const copy = Object.values(s().groups).find((g) => g.windowId === d && pinKeyOf(g) === pinKeyOf(s().groups[pinned]));
  work.takeWorkCounts();
  s().updateGroup(copy.id, { pinned: false });
  const unpinned = work.takeWorkCounts();
  assert.equal(unpinned.shared_groups_unpinned, 1, "unpinning a shared folder counts once across its mirrors");
  assert.equal(unpinned.shared_groups_ungrouped, 0);
  noteSharedGroupUngroup();
  client.setSharing(false, "settings");
  assert.equal(work.takeWorkCounts().shared_groups_ungrouped, 0, "stopping sharing drops pending counts");
  noteSharedGroupUngroup();
  client.setSharing(true, "settings");
  assert.equal(work.takeWorkCounts().shared_groups_ungrouped, 0, "actions with sharing off cannot carry into a later period");
});

test("nothing is counted while sharing is off", async () => {
  client.setSharing(false, "settings");
  const wrapped = withSyncWorkCounts("bookmark", adapter(true));
  assert.equal(wrapped.extract(() => undefined).values.size, 3);
  assert.equal(wrapped.apply(new Map([["b:1", 1]]), new Set(), () => undefined, {}), true);
  work.noteLiveSourceFetch(true);
  work.noteLiveSave(false);
  work.noteExtensionActionTabChangeSkipped();
  assert.ok(Object.values(takeSyncWorkCounts()).every((n) => n === 0));
  assert.ok(Object.values(work.takeLiveWorkCounts()).every((n) => n === 0));
});

test("the sync wrapper passes results through and counts passes, records and async applies", async () => {
  client.setSharing(true, "onboarding");
  const bookmarks = withSyncWorkCounts("bookmark", adapter(false));
  assert.equal(bookmarks.prefix, "b:");
  bookmarks.extract(() => undefined);
  bookmarks.extract(() => undefined);
  assert.equal(bookmarks.apply(new Map([["b:1", 1], ["b:2", 2], ["b:3", 3], ["b:4", 4]]), new Set(), () => undefined, {}), false);
  const history = withSyncWorkCounts("history", { prefix: "h:", extract: async () => null, apply: async () => undefined });
  assert.equal(await history.extract(() => undefined), null);
  await history.apply(new Map([["h:1", 1]]), new Set(), () => undefined, {});
  const taken = takeSyncWorkCounts();
  assert.equal(taken.sync_bookmark_extracts, 2);
  assert.equal(taken.sync_bookmark_applies, 1);
  assert.equal(taken.sync_bookmark_records_max, 4);
  assert.equal(taken.sync_history_extracts, 0, "an extraction that found nothing to read isn't a pass");
  assert.equal(taken.sync_history_applies, 1);
  assert.ok(taken.sync_bookmark_extract_ms_max <= taken.sync_bookmark_extract_ms_total);
  assert.ok(Object.values(takeSyncWorkCounts()).every((n) => n === 0), "taking the counts starts them again at zero");
});

test("a page title Sync left as this device had it is counted while sharing is on, and never after sharing went off", async () => {
  client.setSharing(true, "onboarding");
  takeSyncWorkCounts();
  work.noteSyncHistoryTitlesKept(2, client.consentToken());
  work.noteSyncHistoryTitlesKept(1, client.consentToken());
  assert.equal(takeSyncWorkCounts().sync_history_titles_kept, 3);
  const before = client.consentToken();
  client.setSharing(false, "settings");
  work.noteSyncHistoryTitlesKept(1, before);
  work.noteSyncHistoryTitlesKept(1, client.consentToken());
  assert.equal(takeSyncWorkCounts().sync_history_titles_kept, 0);
});

test("live and extension work reaches usage_counts once, then resets", async () => {
  client.setSharing(true, "onboarding");
  await usageCounts();
  const before = (await usageCounts()).length;
  work.noteLiveSourceFetch(false);
  work.noteLiveSourceFetch(true);
  work.noteLiveSourceFetch(true);
  work.noteLiveSave(true);
  work.noteLiveSave(false);
  work.noteLiveSave(true, "intent");
  work.noteLiveSave(false, "intent");
  work.noteExtensionActionRefresh();
  work.noteExtensionActionStateRequest();
  work.noteExtensionActionStateRequest();
  work.noteExtensionActionTabChangeSkipped();
  withSyncWorkCounts("history", adapter(true)).extract(() => undefined);
  usage.sessionEnding();
  const sent = (await usageCounts()).slice(before);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    [sent[0].live_source_fetches, sent[0].live_source_fetches_shared, sent[0].live_saves_written, sent[0].live_saves_unchanged, sent[0].live_save_intents_queued, sent[0].live_save_intents_unchanged, sent[0].extension_action_refreshes, sent[0].extension_action_state_requests, sent[0].extension_action_tab_changes_skipped, sent[0].sync_history_extracts, sent[0].sync_history_records_max],
    [1, 2, 1, 1, 1, 1, 1, 2, 1, 1, 3],
  );
  usage.sessionEnding();
  assert.equal((await usageCounts()).length - before, 1, "an hour with no work sends nothing more");
});

test("revoking sharing discards pending sync and live work before sharing resumes", () => {
  client.setSharing(true, "settings");
  withSyncWorkCounts("bookmark", adapter(true)).extract(() => undefined);
  work.noteLiveSourceFetch(false);
  work.noteLiveSave(true);
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  assert.ok(Object.values(work.takeWorkCounts()).every((n) => n === 0));
});

test("an async pass crossing revoked consent returns its result without adding later counts", async () => {
  client.setSharing(true, "settings");
  let finish;
  const wrapped = withSyncWorkCounts("history", { prefix: "h:", extract: () => null, apply: () => new Promise((resolve) => { finish = resolve; }) });
  const result = wrapped.apply(new Map([["h:1", 1]]), new Set(), () => undefined, {});
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  finish(true);
  assert.equal(await result, true);
  assert.ok(Object.values(work.takeWorkCounts()).every((n) => n === 0));
});
