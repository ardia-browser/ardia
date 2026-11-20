import assert from "node:assert/strict";
import { after, test } from "node:test";

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = realSetTimeout(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { takePagerCounts } = await import("./pagerCounts.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activateMeasured } = await import("../extensions/actions.ts");
const { extensionProfile, useExtensions } = await import("../extensions/store.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const queued = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events;
const usageSince = async (seen) => {
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  return queued().slice(seen).filter((e) => e.event === "usage_counts");
};
const countedIn = (events, field) => events.reduce((sum, e) => sum + (e.properties[field] ?? 0), 0);

test("a pinned toolbar extension clicked in a private window with sharing off isn't counted when its anchor is measured after sharing turns on", async () => {
  sharing(true);
  S().hydrate({});
  S().createWindow({ url: "https://a.example/" });
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const ext = { id: "ext-a", name: "A", enabled: true, incognito: true, popup: "", actionTitle: "", actionIcon: "", icon: "" };
  useExtensions.setState({ lists: { ...useExtensions.getState().lists, [extensionProfile(S(), priv)]: [ext] } });
  await usageSince(0);
  sharing(false);
  let measured = () => {};
  const clicked = activateMeasured(priv, ext, () => new Promise((resolve) => (measured = resolve)));
  sharing(true);
  const seen = queued().length;
  measured({ x: 0, y: 0, width: 28, height: 28 });
  await clicked;
  assert.equal(countedIn(await usageSince(seen), "private_window_extension_opens"), 0);
});

test("a pinch on Little Ardia that began with sharing off isn't counted when it ends after sharing turns on", async () => {
  sharing(false);
  const begun = client.consentToken();
  sharing(true);
  await usageSince(0);
  const seen = queued().length;
  usage.notePinch("littleArdia", "close", begun);
  usage.notePinch("littleArdia", "open", begun);
  const events = await usageSince(seen);
  assert.equal(countedIn(events, "little_ardia_pinch_closes") + countedIn(events, "little_ardia_pinch_opens"), 0);
});

test("a swipe to close Little Ardia that began with sharing off isn't counted when it ends after sharing turns on", async () => {
  sharing(false);
  const begun = client.consentToken();
  sharing(true);
  await usageSince(0);
  const seen = queued().length;
  usage.noteSwipeClose(true, begun);
  usage.noteSwipeClose(false, begun);
  const events = await usageSince(seen);
  assert.equal(countedIn(events, "little_ardia_swipe_closes") + countedIn(events, "little_ardia_swipe_close_cancels"), 0);
});

test("a profile dot drag that began with sharing off isn't counted as a reorder when it's released after sharing turns on", async () => {
  sharing(false);
  const begun = client.consentToken();
  sharing(true);
  takePagerCounts();
  const { noteProfileDotReorder } = await import("./pagerCounts.ts");
  noteProfileDotReorder(begun);
  assert.equal(takePagerCounts().profile_dot_reorders, 0);
  noteProfileDotReorder(client.consentToken());
  assert.equal(takePagerCounts().profile_dot_reorders, 1);
});
