import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { pagerFor } = await import("./profilePager.ts");
const { engineProfile } = await import("../browser/model.ts");
const { nativeWindowProfile } = await import("./hooks.ts");

const S = () => useBrowser.getState();

test("a window that exists keeps one pager; a missing window gets a throwaway that isn't kept", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(pagerFor(w), pagerFor(w));
  assert.notEqual(pagerFor("w-gone"), pagerFor("w-gone"));
});

const { pagerSnapshots } = await import("../../test-native/ardiacore.ts");
const { takePagerCounts } = await import("../telemetry/pagerCounts.ts");
globalThis.fetch = async () => ({ status: 200 });
const telemetry = await import("../telemetry/client.ts");
telemetry.setSharing(true, "onboarding");
after(() => telemetry.setSharing(false, "settings"));

let sequence = 100;
function threeProfiles() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().createProfile({ name: "B" });
  const c = S().createProfile({ name: "C" });
  const order = S().profileOrder;
  S().switchProfile(w, order[0]);
  takePagerCounts();
  const pager = pagerFor(w);
  const native = (phase, selected, event, position = selected) => {
    const snapshot = { sequence: ++sequence, selectionSequence: sequence, position, selected, phase, velocity: 0, count: order.length, profileId: order[selected] };
    pagerSnapshots.set(w, snapshot);
    if (event) pager.onNativeState({ phase: event, sequence: snapshot.sequence, position, selected, velocity: 0, profileId: order[selected] });
  };
  return { w, order, pager, native, b, c, held: () => pager.state.getState().held, warm: () => pager.state.getState().pages.map((p) => p.id) };
}

test("a swipe holds the sidebar's page on the profile it started from until the pages come to rest", () => {
  const { w, order, native, held } = threeProfiles();
  native("tracking", 0, "began");
  assert.equal(held(), order[0]);
  native("settling", 1, "selected");
  assert.equal(S().windows[w].profileId, order[1], "the window switches when the swipe is let go");
  assert.equal(held(), order[0], "the sidebar keeps its page until the pages rest");
  native("idle", 1, "settled");
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_switches_after_rest, 1);
});

test("a rubber band at the edge holds and lets go without counting a held switch", () => {
  const { native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("settling", 0);
  native("idle", 0, "settled");
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_switches_after_rest, 0);
});

test("a fast double swipe keeps holding the first profile and lands on the last one", () => {
  const { w, order, native, held, warm } = threeProfiles();
  assert.deepEqual(warm(), [order[0], order[1]]);
  native("tracking", 0, "began");
  native("settling", 1, "selected");
  native("tracking", 1, "began");
  native("settling", 2, "selected");
  assert.equal(S().windows[w].profileId, order[2]);
  assert.equal(held(), order[0]);
  assert.deepEqual(warm(), [order[0], order[1]], "far neighbours wait; the page sliding out stays warm");
  native("idle", 2, "settled");
  assert.equal(held(), null);
  assert.deepEqual(warm(), [order[1], order[2]], "the neighbours follow once the pages rest");
});

test("the page that slides out of a third quick swipe is kept warm while it moves", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  for (const name of ["B", "C", "D"]) S().createProfile({ name });
  const order = S().profileOrder;
  S().switchProfile(w, order[0]);
  const pager = pagerFor(w);
  const native = (phase, selected, event) => {
    pagerSnapshots.set(w, { sequence: ++sequence, selectionSequence: sequence, position: selected, selected, phase, velocity: 0, count: order.length, profileId: order[selected] });
    pager.onNativeState({ phase: event, sequence, position: selected, selected, velocity: 0, profileId: order[selected] });
  };
  native("tracking", 0, "began");
  native("settling", 1, "selected");
  native("settling", 2, "selected");
  native("settling", 3, "selected");
  assert.deepEqual(pager.state.getState().pages.map((p) => p.id), [order[0], order[1], order[2]]);
  native("idle", 3, "settled");
  assert.deepEqual(pager.state.getState().pages.map((p) => p.id), [order[2], order[3]]);
});

test("a hold the native pager never ends with an event is let go at the first look that finds the pages resting on their target", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("settling", 1, "selected", 0.4);
  t.mock.timers.tick(50);
  assert.notEqual(held(), null, "still moving");
  native("idle", 1);
  t.mock.timers.tick(50);
  assert.equal(held(), null, "let go within one look of the pages resting");
  const counts = takePagerCounts();
  assert.equal(counts.profile_pager_rests_seen_by_watch, 1);
  assert.equal(counts.profile_pager_switches_after_rest, 1);
});

test("an idle pager that never reaches its target still lets go after a second", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("idle", 1, "selected", 0.5);
  t.mock.timers.tick(950);
  assert.notEqual(held(), null);
  t.mock.timers.tick(50);
  assert.equal(held(), null);
});

test("Linux's pager says selected before it starts settling, still resting on the old page, and that holds too", () => {
  const { w, order, native, held } = threeProfiles();
  native("idle", 1, "selected", 0);
  assert.equal(S().windows[w].profileId, order[1]);
  assert.equal(held(), order[0], "an idle report that isn't on its target is a page still to move");
  native("settling", 1, null, 0.6);
  native("idle", 1, "settled");
  assert.equal(held(), null);
});

test("a drag lets the sidebar follow for the rest of that hold, even when the pager comes back to where it started and leaves again", () => {
  const { pager, order, native, held } = threeProfiles();
  const bypassed = () => pager.state.getState().bypassed;
  native("tracking", 0, "began");
  native("settling", 1, "selected", 0.3);
  pager.bypassHold();
  assert.equal(bypassed(), true);
  native("settling", 0, "selected", 0.6);
  native("settling", 1, "selected", 0.4);
  assert.equal(held(), order[0], "still the same hold");
  assert.equal(bypassed(), true, "the bypass lasts as long as the hold");
  native("idle", 1, "settled");
  assert.equal(held(), null);
  assert.equal(bypassed(), false, "a new hold starts waiting again");
  pager.bypassHold();
  assert.equal(bypassed(), false, "no hold, nothing to bypass");
});

test("the watch counts a rest only when it saw one: an idle pager that never reached its target lets go uncounted", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("idle", 1, "selected", 0.5);
  t.mock.timers.tick(1000);
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_rests_seen_by_watch, 0);
});

test("a pager with no snapshot left lets go of the hold without counting a rest it never saw", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { w, native, held } = threeProfiles();
  native("tracking", 0, "began");
  native("settling", 1, "selected", 0.4);
  pagerSnapshots.delete(w);
  t.mock.timers.tick(50);
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_rests_seen_by_watch, 0);
});

test("a profile switch from elsewhere during a hold lets the sidebar follow at once", () => {
  const { w, order, native, held } = threeProfiles();
  native("tracking", 0, "began");
  assert.equal(held(), order[0]);
  S().switchProfile(w, order[2]);
  assert.equal(held(), null);
  assert.equal(takePagerCounts().profile_pager_switches_after_rest, 0, "a switch from elsewhere is not one the sidebar waited on");
});

test("settle frames count under the consent their motion began with, once, even when the settled event comes late or after the snapshot moved on", () => {
  const { w, order, pager } = threeProfiles();
  const event = (phase, motion, selected, extra = {}) => pager.onNativeState({ phase, sequence: ++sequence, position: selected, selected, velocity: 0, profileId: order[selected], motion, ...extra });
  const frames = { frames: 30, longFrames: 2, worstGapMs: 25 };
  telemetry.setSharing(false, "settings");
  event("began", 1, 0);
  event("selected", 1, 1);
  telemetry.setSharing(true, "onboarding");
  event("began", 2, 1);
  event("settled", 1, 1, frames);
  let counts = takePagerCounts();
  assert.equal(counts.profile_pager_settle_frames, 0, "motion 1 began while sharing was off");
  event("selected", 2, 2);
  pagerSnapshots.set(w, { sequence: ++sequence, selectionSequence: sequence, position: 2, selected: 2, phase: "idle", velocity: 0, count: order.length, profileId: order[2] });
  event("selected", 2, 2);
  event("settled", 2, 2, frames);
  event("settled", 2, 2, frames);
  counts = takePagerCounts();
  assert.equal(counts.profile_pager_settle_frames, 30, "a selected that read the settle snapshot first doesn't swallow the sample, and a repeat counts once");
  assert.equal(counts.profile_pager_settles_with_long_frames, 1);
  assert.equal(counts.profile_pager_settles_sampled, 1, "the long-frame share has a denominator from the same settle, even when the store commit saw it first");
  assert.equal(counts.profile_pager_settle_worst_gap_ms, 25);
  event("settled", 3, 2, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 0, "a motion whose start was never seen isn't counted");
});

test("the window's native neighbour profiles follow the pager's warm pages, so the next neighbour is prepared at rest and not while the pages move", () => {
  const { w, order, native, pager } = threeProfiles();
  const neighbours = () => JSON.parse(nativeWindowProfile(S(), w, pager.state.getState().pages)[1]);
  const engine = (id) => engineProfile(S(), id);
  assert.deepEqual(neighbours(), [engine(order[1])]);
  native("tracking", 0, "began");
  native("settling", 1, "selected", 0.6);
  assert.equal(S().windows[w].profileId, order[1]);
  assert.deepEqual(neighbours(), [engine(order[0])], "the profile beyond isn't prepared mid-slide");
  native("idle", 1, "settled");
  assert.deepEqual(neighbours(), [engine(order[0]), engine(order[2])]);
});

test("only the motion just before a new one keeps its consent for a late settle; older and cancelled ones are dropped", () => {
  const { order, pager } = threeProfiles();
  const event = (phase, motion, selected, extra = {}) => pager.onNativeState({ phase, sequence: ++sequence, position: selected, selected, velocity: 0, profileId: order[selected], motion, ...extra });
  const frames = { frames: 30, longFrames: 1, worstGapMs: 20 };
  telemetry.setSharing(true, "onboarding");
  event("began", 101, 0);
  event("began", 205, 0);
  event("began", 309, 0);
  event("settled", 101, 0, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 0, "a motion two back was superseded");
  event("settled", 205, 0, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 30, "the one just before still counts once it settles late");
  event("selected", undefined, 0);
  event("began", 150, 0);
  event("settled", 309, 0, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 30);
});

test("a replayed began of a motion that already settled doesn't bring its consent back", () => {
  const { order, pager } = threeProfiles();
  const event = (phase, motion, selected, extra = {}) => pager.onNativeState({ phase, sequence: ++sequence, position: selected, selected, velocity: 0, profileId: order[selected], motion, ...extra });
  const frames = { frames: 20, longFrames: 1, worstGapMs: 20 };
  telemetry.setSharing(false, "settings");
  event("began", 410, 0);
  event("settled", 410, 0, frames);
  telemetry.setSharing(true, "onboarding");
  event("began", 410, 0);
  event("settled", 410, 0, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 0);
  event("began", 420, 0);
  event("began", 415, 0);
  event("settled", 415, 0, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 0, "a motion older than one already started is never started late");
  event("settled", 420, 0, frames);
  assert.equal(takePagerCounts().profile_pager_settle_frames, 20);
});
