import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const local = await import("./localStore.ts");
const { telemetryLocal } = await import("../../test-native/telemetryLocal.ts");
after(() => client.setSharing(false, "settings"));

const { COUNT_EVENTS } = await import("./countEvents.ts");
const SKIPPED = new Set(["client.ts", "localStore.ts", "index.ts", "usageClient.ts"]);
const modules = [];
for (const name of readdirSync(new URL(".", import.meta.url)).sort()) {
  if (!/\.tsx?$/.test(name) || name.includes(".test.") || SKIPPED.has(name)) continue;
  modules.push([name, await import(`./${name}`)]);
}
const noters = modules.flatMap(([name, exports]) =>
  Object.entries(exports).flatMap(([fn, value]) => (typeof value === "function" && /^(note|track)[A-Z]/.test(fn) ? [[`${name}:${fn}`, value]] : [])),
);
const ARGS = [[], [1, true, 1], ["tab", true, 2], [{ rows: 1, splits: 1, done: 1, failed: 0, secretsLeft: 0, withheld: 0 }, 1], [true], [false, false]];

async function noteEverything() {
  for (const [, fn] of noters) {
    for (const args of ARGS) {
      try {
        const result = fn(...args);
        if (result && typeof result.then === "function") await result.catch(() => null);
      } catch {}
    }
  }
}

const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const clearLocal = () => (local.flushLocal(), telemetryLocal.reset());
const queuedEvents = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events;
const countLines = () => {
  local.flushLocal();
  return telemetryLocal.records().filter((r) => COUNT_EVENTS.has(r.event) || (r.properties?.gone_this_session ?? 0) > 0);
};

test(`with sharing off, none of the ${"count modules'"} note functions leaves a count in the local copy or the send queue`, async () => {
  assert.ok(noters.length > 100, `only ${noters.length} note functions found`);
  sharing(false);
  clearLocal();
  await noteEverything();
  usage.emitWindowUsage(client.consentNow());
  usage.sessionEnding();
  await client.saveQueueNow();
  assert.deepEqual(countLines().map((r) => `${r.event} ${JSON.stringify(r.properties).slice(0, 120)}`), []);
  assert.deepEqual(queuedEvents().filter((e) => COUNT_EVENTS.has(e.event)), []);
});

test("turning sharing off drops every count noted while it was on, and none of them is sent once it is back on", async () => {
  sharing(true);
  usage.emitWindowUsage(client.consentNow());
  await noteEverything();
  sharing(false);
  clearLocal();
  sharing(true);
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  const sent = queuedEvents().filter((e) => COUNT_EVENTS.has(e.event));
  const nonZero = sent.flatMap((e) => Object.entries(e.properties).filter(([key, value]) => typeof value === "number" && value > 0 && !["hour_of_day", "counted_minutes"].includes(key)).map(([key]) => `${e.event}.${key}`));
  assert.deepEqual(nonZero, []);
  assert.deepEqual(countLines().filter((r) => r.sent === false), []);
});

test("a count captured with a token from before sharing went off is not recorded or queued, and the boundary drain records nothing", async () => {
  sharing(true);
  const before = client.consentNow();
  sharing(false);
  clearLocal();
  client.capture("usage_counts", { tabs_opened: 2 }, before);
  client.capture("tab_presses", { presses: 2 }, before);
  usage.emitWindowUsage(null);
  await client.saveQueueNow();
  assert.deepEqual(countLines(), []);
  assert.deepEqual(queuedEvents().filter((e) => COUNT_EVENTS.has(e.event)), []);
  sharing(true);
  client.capture("usage_counts", { tabs_opened: 2 }, client.consentNow());
  await client.saveQueueNow();
  assert.equal(queuedEvents().filter((e) => e.event === "usage_counts" && e.properties.tabs_opened === 2).length, 1, "a count with the current token still goes out");
});

test("events, errors and logs are still kept on this Mac with sharing off, as Settings › Privacy says", () => {
  sharing(false);
  clearLocal();
  client.capture("report_sheet_opened", { source: "menu" }, client.consentNow());
  client.queueLog("error", "boom", {}, client.consentNow());
  local.flushLocal();
  assert.deepEqual(telemetryLocal.records().map((r) => [r.kind, r.sent, r.event ?? r.message]), [["event", false, "report_sheet_opened"], ["log", false, "boom"]]);
});

const presses = await import("./tabPresses.ts");
const scrolls = await import("./sidebarScrollCounts.ts");
const cli = await import("./cliCounts.ts");
const drags = await import("./stuckDrags.ts");
const track = await import("./track.ts");
const relayModule = await import("./relay.ts");

test("presses, scrolls and imports made while sharing is off are never sent after sharing turns on", async () => {
  sharing(false);
  clearLocal();
  presses.notePressStarted();
  presses.notePressEnded("click");
  scrolls.noteSidebarScrolled(10_000);
  usage.noteImportedPins({ rows: 3, splits: 1 });
  sharing(true);
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  const sent = queuedEvents().filter((e) => COUNT_EVENTS.has(e.event));
  assert.deepEqual(sent.flatMap((e) => ["presses", "sidebar_scrolls", "imported_pinned_rows"].filter((key) => (e.properties[key] ?? 0) > 0)), []);
  assert.deepEqual(countLines(), []);
});

test("running totals read after a consent change only set the baseline, so activity from before it is never counted", () => {
  sharing(true);
  cli.noteWindowlessPages({ given: 1, missed: 0 });
  drags.noteDragsEnded({ ownerGone: 1, debuggerUnowned: 0, nativeRefused: 0 }, client.consentNow());
  cli.takeCliCounts();
  drags.takeStuckDragCounts();
  sharing(false);
  sharing(true);
  cli.noteWindowlessPages({ given: 4, missed: 2 });
  drags.noteDragsEnded({ ownerGone: 3, debuggerUnowned: 0, nativeRefused: 0 }, client.consentNow());
  assert.deepEqual([cli.takeCliCounts().windowless_pages_given_geometry, drags.takeStuckDragCounts().stuck_drags_ended_owner_gone], [0, 0]);
  cli.noteWindowlessPages({ given: 5, missed: 2 });
  drags.noteDragsEnded({ ownerGone: 4, debuggerUnowned: 0, nativeRefused: 0 }, client.consentNow());
  assert.deepEqual([cli.takeCliCounts().windowless_pages_given_geometry, drags.takeStuckDragCounts().stuck_drags_ended_owner_gone], [1, 1]);
});

test("the first scroll after a consent change starts a new sequence, and a keystroke made before it isn't sampled after", () => {
  sharing(true);
  scrolls.takeSidebarScrollCounts();
  scrolls.noteSidebarScrolled(50_000);
  const key = track.omniboxKeyHeard();
  sharing(false);
  sharing(true);
  scrolls.takeSidebarScrollCounts();
  scrolls.noteSidebarScrolled(50_050);
  const counted = scrolls.takeSidebarScrollCounts();
  assert.deepEqual([counted.sidebar_scrolls, counted.sidebar_scroll_stalls], [1, 0]);
  track.takeOmniboxLatency();
  for (let i = 0; i < 10; i++) track.sampleOmniboxLatency(key);
  assert.deepEqual(track.takeOmniboxLatency(), []);
});

test("the local copy's hourly meters start from zero at a consent change", () => {
  sharing(true);
  for (let i = 0; i < 5; i++) client.queueLog("warn", "w", {}, client.consentNow());
  sharing(false);
  assert.ok(local.devLocalStore().bufferedMax <= 1, `buffered_max ${local.devLocalStore().bufferedMax} after the change`);
});

test("with a relay in place, a count taken before sharing went off isn't forwarded, and other events still are", () => {
  sharing(true);
  const before = client.consentNow();
  sharing(false);
  const forwarded = [];
  relayModule.setTelemetryRelay({ capture: (event) => forwarded.push(event), log: () => {}, resetId: async () => "", change: async () => true, installId: () => "" });
  try {
    client.capture("usage_counts", { tabs_opened: 1 }, before);
    client.capture("tab_presses", { presses: 1 }, client.consentNow());
    client.capture("report_sheet_opened", { source: "menu" }, client.consentNow());
    assert.deepEqual(forwarded.filter((event) => ["usage_counts", "tab_presses", "report_sheet_opened"].includes(event)), ["report_sheet_opened"]);
  } finally {
    relayModule.setTelemetryRelay(null);
  }
});

test("a press or a drag that began before a consent change counts nothing when it ends after it", () => {
  sharing(false);
  const press = { drift: "lt5", windowKey: true };
  presses.notePressStarted(false, true, press);
  const drag = {};
  presses.noteDragBegan(drag);
  sharing(true);
  presses.notePressOutUnanswered(press);
  presses.settleUnansweredPressOut();
  presses.noteSidebarDrop("gap", drag);
  presses.noteDragWithoutDrop(drag);
  const tally = presses.devTabPresses();
  assert.deepEqual([tally.press_out_no_press, tally.drift_lt5, tally.drops_gap, tally.drags_without_drop], [0, 0, 0, 0]);
  const fresh = {};
  presses.noteDragBegan(fresh);
  presses.noteSidebarDrop("gap", fresh);
  assert.equal(presses.devTabPresses().drops_gap, 1);
});

test("a stale CLI reply after a consent change neither counts nor uses up the new baseline", () => {
  sharing(true);
  drags.noteDragsEnded({ ownerGone: 1, debuggerUnowned: 0, nativeRefused: 0 }, client.consentNow());
  const before = client.consentNow();
  drags.takeStuckDragCounts();
  sharing(false);
  sharing(true);
  drags.noteDragsEnded({ ownerGone: 1, debuggerUnowned: 0, nativeRefused: 0 }, before);
  drags.noteDragsEnded({ ownerGone: 4, debuggerUnowned: 0, nativeRefused: 0 }, client.consentNow());
  assert.equal(drags.takeStuckDragCounts().stuck_drags_ended_owner_gone, 0, "the fresh reading only sets the baseline");
  drags.noteDragsEnded({ ownerGone: 5, debuggerUnowned: 0, nativeRefused: 0 }, client.consentNow());
  assert.equal(drags.takeStuckDragCounts().stuck_drags_ended_owner_gone, 1);
});

test("the omnibox's every-fifth sampling starts over at a consent change", () => {
  sharing(true);
  track.takeOmniboxLatency();
  for (let i = 0; i < 4; i++) track.sampleOmniboxLatency(track.omniboxKeyHeard());
  sharing(false);
  sharing(true);
  track.sampleOmniboxLatency(track.omniboxKeyHeard());
  assert.deepEqual(track.takeOmniboxLatency(), []);
});
