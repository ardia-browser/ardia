import assert from "node:assert/strict";
import { test } from "node:test";
import { createBudgetProbe, initialState, judge, LOOK_BUDGET, mode, otherWork, parseState, record, refresh, wantsMeasurement, type BudgetState, type FrameSample, type ProbeAttempt } from "../../../../packages/phone/src/lookBudgetRules.ts";

const frames = (count: number, totalMs: number, deadlineMs = 16.6): FrameSample => ({ totals: Array(count).fill(totalMs), deadlines: Array(count).fill(deadlineMs), windowMs: 2000 });
const over = judge(frames(50, 40));
const within = judge(frames(50, 9));
const noSystem = { reduceMotion: false, reduceTransparency: false };
const day = 24 * 60 * 60 * 1000;

test("a sample is over when the look keeps the phone busy more than a third of the time, and a few cheap frames decide nothing", () => {
  assert.equal(over.over, true, "50 frames of 40 ms in 2 s: busy all the time");
  assert.equal(over.busyShare, 1);
  assert.equal(within.over, false, "50 frames of 9 ms in 2 s: busy 22% of the time");
  const mostlyFast: FrameSample = { totals: [...Array(36).fill(8), ...Array(14).fill(30)], deadlines: Array(50).fill(16.6), windowMs: 2000 };
  assert.equal(judge(mostlyFast).over, true, "busy 35%: every frame's cost counts, the slow ones included");
  const fewSlow: FrameSample = { totals: [...Array(40).fill(8), ...Array(10).fill(30)], deadlines: Array(50).fill(16.6), windowMs: 2000 };
  assert.equal(judge(fewSlow).over, false, "busy 31% is within");
  const short = judge(frames(LOOK_BUDGET.minFrames - 1, 9));
  assert.equal(short.conclusive, false, "19 cheap frames are too few to say anything");
  assert.equal(short.over, false);
  const struggling = judge(frames(12, 150));
  assert.equal(struggling.conclusive, true, "a phone that drew only 12 frames because each took 150 ms has said enough");
  assert.equal(struggling.over, true);
});

test("a paced deck is judged by its duty cycle: the display's deadline is reported but decides nothing", () => {
  const pacedTwoSeconds = (costMs: number, count = 39) => ({ totals: Array(count).fill(costMs), deadlines: Array(count).fill(11.7), refreshMs: 1000 / 120, windowMs: 2000 });
  const f4Sync15 = judge(pacedTwoSeconds(28.9));
  assert.equal(f4Sync15.over, true, "39 frames of 28.9 ms in 2 s");
  assert.ok(Math.abs(f4Sync15.busyShare! - 0.56) < 0.01, `busy ${f4Sync15.busyShare}`);
  assert.equal(f4Sync15.keepsUp, true);
  assert.equal(f4Sync15.missedShare, 1, "every frame missed the display's deadline, which is reported only");
  const sixteen = judge(pacedTwoSeconds(16));
  assert.equal(sixteen.over, false, "16 ms paced frames miss every 120 Hz deadline but keep the phone busy 31% of the time");
  assert.equal(sixteen.missedShare, 1);
  const eighteen = judge(pacedTwoSeconds(18));
  assert.equal(eighteen.over, true, "18 ms frames at that pace: busy 35%");
  const m3 = judge({ totals: Array(37).fill(48.4), deadlines: Array(37).fill(16.7), refreshMs: 1000 / 60, windowMs: 2000 });
  assert.equal(m3.over, true);
  assert.deepEqual(Object.keys(pacedTwoSeconds(9)).sort(), ["deadlines", "refreshMs", "totals", "windowMs"], "a sample carries no timestamps, so a gap between frames cannot count");
});

test("a phone that cannot keep up at all fails even when its few frames add up to little", () => {
  const slow = judge({ totals: Array(20).fill(110), deadlines: Array(20).fill(16.7), windowMs: 2000 });
  assert.equal(slow.paceMs, 100);
  assert.equal(slow.keepsUp, false, "the median frame, 110 ms, is longer than the 100 ms pace it was drawn at");
  assert.equal(slow.over, true);
  const oneSpike = judge({ totals: [...Array(39).fill(6), 400], deadlines: Array(40).fill(11.7), windowMs: 2000 });
  assert.equal(oneSpike.keepsUp, true, "one 400 ms frame among 6 ms ones is not a phone that cannot keep up");
  assert.equal(oneSpike.over, false, `busy ${oneSpike.busyShare}`);
});

test("a sample in which anything but the backdrop drew a frame decides nothing, however it measured", () => {
  const withPopupSliding = judge({ totals: Array(35).fill(15), deadlines: Array(35).fill(16.7), windowMs: 2000, foreignFrames: 6 });
  assert.equal(withPopupSliding.conclusive, false);
  assert.equal(withPopupSliding.over, false);
  assert.equal(withPopupSliding.foreignFrames, 6);
  const tooBusyButTainted = judge({ totals: Array(35).fill(40), deadlines: Array(35).fill(16.7), windowMs: 2000, foreignFrames: 1 });
  assert.equal(tooBusyButTainted.conclusive, false, "an over-budget reading with a foreign frame in it can't degrade the phone either");
  const clean = judge({ totals: Array(35).fill(15), deadlines: Array(35).fill(16.7), windowMs: 2000, foreignFrames: 0 });
  assert.equal(clean.conclusive, true);
  assert.equal(clean.foreignFrames, undefined);
  assert.equal(record(initialState("1"), withPopupSliding, 1000).verdict, "unknown", "a dropped sample changes nothing stored");
});

test("busy counts each frame's work, not its wait for the vsync, plus the backdrop's own ticks between frames", () => {
  const f4Sync17b = { totals: Array(34).fill(13), deadlines: Array(34).fill(11.7), waits: Array(34).fill(7), windowMs: 2000 };
  const judged = judge(f4Sync17b);
  assert.equal(judged.medianMs, 6, "13 ms frames of which 7 ms waited for the vsync");
  assert.equal(judged.waitMs, 7);
  assert.ok(Math.abs(judged.busyShare! - 0.102) < 0.001, `busy ${judged.busyShare}`);
  assert.equal(judged.over, false);
  const withTicks = judge({ ...f4Sync17b, tickMs: 68 });
  assert.ok(Math.abs(withTicks.busyShare! - 0.136) < 0.001, "34 ticks of 2 ms between frames count too");
  assert.equal(withTicks.tickMs, 68);
  const old = judge({ totals: Array(34).fill(13), deadlines: Array(34).fill(11.7), windowMs: 2000 });
  assert.ok(Math.abs(old.busyShare! - 0.221) < 0.001, "a sampler that sends no waits is judged on the whole frame, as before");
});

test("fixed frame stats always give the same two shares: work plus other main-thread work, and whole frames as judged through sync17b", () => {
  const totals = [12.4, 13.1, 11.8, 15.2, 12.9, 13.6, 12.2, 14.0, 12.7, 13.3];
  const waits = [6.1, 7.0, 5.2, 8.4, 6.6, 7.3, 5.9, 7.7, 6.4, 6.8];
  const judged = judge({ totals, deadlines: Array(10).fill(11.7), waits, windowMs: 1000, mainThreadMs: 21.5, tickMs: 18 });
  const work = totals.reduce((sum, total, index) => sum + total - waits[index]!, 0);
  assert.equal(Math.round(work * 10) / 10, 63.8);
  assert.equal(Math.round(judged.busyShare! * 10000) / 10000, 0.0853, "(63.8 ms of frame work + 21.5 ms of other main-thread work) / 1000 ms");
  assert.equal(Math.round(judged.wholeFrameBusyShare! * 10000) / 10000, 0.1312, "131.2 ms of whole frames / 1000 ms");
  assert.equal(judged.mainThreadMs, 21.5);
  assert.equal(judged.tickMs, 18, "the ticks are reported, and counted inside the main-thread work, not twice");
  assert.equal(Math.round(judged.waitMs! * 10) / 10, 6.7);
  const again = judge({ totals: [...totals], deadlines: Array(10).fill(11.7), waits: [...waits], windowMs: 1000, mainThreadMs: 21.5, tickMs: 18 });
  assert.deepEqual(again, judged);
});

test("the backdrop's scenes drawn off the main thread are the look's work too: reported and counted in the share", () => {
  const totals = [12.4, 13.1, 11.8, 15.2, 12.9, 13.6, 12.2, 14.0, 12.7, 13.3];
  const waits = [6.1, 7.0, 5.2, 8.4, 6.6, 7.3, 5.9, 7.7, 6.4, 6.8];
  const without = judge({ totals, deadlines: Array(10).fill(11.7), waits, windowMs: 1000, mainThreadMs: 21.5, tickMs: 0.4 });
  const withWorker = judge({ totals, deadlines: Array(10).fill(11.7), waits, windowMs: 1000, mainThreadMs: 21.5, tickMs: 0.4, sceneWorkerMs: 95 });
  assert.equal(withWorker.sceneWorkerMs, 95);
  assert.equal(Math.round((withWorker.busyShare! - without.busyShare!) * 1000) / 1000, 0.095, "95 ms of a second core's work in a 1000 ms window adds 9.5%");
  assert.equal(without.sceneWorkerMs, undefined);
});

test("the window is the sampler's own when it sends one, and the planned three seconds otherwise", () => {
  const sent = judge({ totals: Array(40).fill(10), deadlines: Array(40).fill(16.7), windowMs: 4000 });
  assert.equal(sent.busyShare, 0.1);
  const planned = judge({ totals: Array(40).fill(10), deadlines: Array(40).fill(16.7) });
  assert.equal(planned.windowMs, LOOK_BUDGET.sampleMs);
  assert.equal(Math.round(planned.busyShare! * 1000) / 1000, 0.133);
});

const pacedSample = (paceMs: number, workMs: number, sceneWorkerMs: number) => {
  const count = Math.floor(LOOK_BUDGET.sampleMs / paceMs);
  return { totals: Array(count).fill(workMs + 0.6), deadlines: Array(count).fill(11.7), waits: Array(count).fill(0.6), refreshMs: 1000 / 120, windowMs: LOOK_BUDGET.sampleMs, mainThreadMs: 30, tickMs: 15, sceneWorkerMs };
};

test("the sampler reaches a verdict at any pacing the deck uses: a frame every 59 ms and every 100 ms both fill the window's floor", () => {
  for (const paceMs of [59, 100]) {
    const sample = pacedSample(paceMs, 12, 60);
    assert.ok(sample.totals.length >= LOOK_BUDGET.minFrames, `${sample.totals.length} frames at ${paceMs} ms`);
    const judged = judge(sample);
    assert.equal(judged.conclusive, true, `a frame every ${paceMs} ms decides`);
    assert.equal(judged.paceMs, LOOK_BUDGET.sampleMs / sample.totals.length);
  }
  const old = judge({ totals: Array(18).fill(12.6), deadlines: Array(18).fill(11.7), windowMs: 2000 });
  assert.equal(old.conclusive, false, "sync22's 2 s window at 100 ms pacing had 18 frames and could not decide");
});

test("two agreeing measurements still degrade at slow pacing, and one alone never does", () => {
  const heavy = judge(pacedSample(100, 30, 300));
  assert.equal(heavy.conclusive, true);
  assert.equal(heavy.over, true);
  const once = record(initialState("1"), heavy, 1000);
  assert.equal(once.apply, "full");
  assert.equal(record(once, heavy, 2000).apply, "degraded");
});

test("the display's deadline is still held to its refresh when reported: a stretched deadline cannot look met", () => {
  const m3First: FrameSample = { totals: Array(37).fill(49.5), deadlines: Array(37).fill(33.2), refreshMs: 1000 / 60 };
  const judged = judge(m3First);
  assert.equal(judged.deadlineMs, 1000 / 60);
  assert.equal(judged.stretched, 37);
  assert.equal(judged.missedShare, 1);
  const f4: FrameSample = { totals: Array(40).fill(9), deadlines: Array(40).fill(11.7), refreshMs: 1000 / 120 };
  assert.equal(judge(f4).deadlineMs, 11.7);
  assert.equal(judge(f4).stretched, 0);
  const iPhone: FrameSample = { totals: Array(40).fill(9), deadlines: Array(40).fill(16.7) };
  assert.equal(judge(iPhone).refreshMs, undefined);
});

test("one bad measurement never degrades; two on separate deck opens do, and the look changes only for the next build", () => {
  let state = initialState("1");
  state = record(state, over, 1000);
  assert.equal(state.apply, "full");
  assert.equal(state.pendingOver, true);
  state = record(state, over, 2000);
  assert.equal(state.verdict, "fail");
  assert.equal(state.apply, "degraded");
  assert.equal(state.measuredAt, 2000);
});

test("a good measurement between two bad ones starts the agreement over", () => {
  let state = record(initialState("1"), over, 1000);
  state = record(state, within, 2000);
  assert.equal(state.verdict, "pass");
  assert.equal(state.pendingOver, false);
  state = refresh(state, "2", 3000);
  state = record(state, over, 4000);
  assert.equal(state.apply, "full");
});

test("an inconclusive sample changes nothing", () => {
  const before = record(initialState("1"), over, 1000);
  assert.deepEqual(record(before, judge(frames(3, 40)), 2000), before);
});

test("the verdict is kept per version: a pass is not measured again until the app updates", () => {
  let state = record(initialState("1"), within, 1000);
  assert.equal(wantsMeasurement(state, noSystem), false);
  state = refresh(state, "1", 1000 + 400 * day);
  assert.equal(wantsMeasurement(state, noSystem), false);
  state = refresh(state, "2", 1000 + 400 * day);
  assert.equal(state.verdict, "unknown");
  assert.equal(wantsMeasurement(state, noSystem), true);
});

test("a degraded phone gets a second chance after an update or thirty days, shown the full look to measure it", () => {
  const failed = record(record(initialState("1"), over, 1000), over, 2000);
  assert.equal(wantsMeasurement(failed, noSystem), false, "degraded: nothing to measure");
  assert.deepEqual(refresh(failed, "1", 2000 + 29 * day), failed);
  const later = refresh(failed, "1", 2000 + LOOK_BUDGET.retryAfterMs);
  assert.equal(later.apply, "full");
  assert.equal(wantsMeasurement(later, noSystem), true);
  const updated = refresh(failed, "2", 3000);
  assert.equal(updated.apply, "full");
  assert.equal(updated.version, "2");
  const passed = record(updated, within, 4000);
  assert.equal(passed.verdict, "pass");
});

test("a trial already under way survives a relaunch, so its two measurements can still agree", () => {
  const failed = record(record(initialState("1"), over, 1000), over, 2000);
  let trial = refresh(failed, "2", 3000);
  trial = record(trial, over, 4000);
  assert.equal(trial.pendingOver, true);
  const relaunched = refresh(trial, "2", 5000);
  assert.equal(relaunched.pendingOver, true);
  assert.equal(record(relaunched, over, 6000).apply, "degraded");
});

test("the system settings win: they always turn their half off, and the measurement can only take the look away", () => {
  assert.equal(mode("full", noSystem), "full");
  assert.equal(mode("full", { reduceMotion: true, reduceTransparency: false }), "no_motion");
  assert.equal(mode("full", { reduceMotion: false, reduceTransparency: true }), "no_blur");
  assert.equal(mode("full", { reduceMotion: true, reduceTransparency: true }), "neither");
  assert.equal(mode("degraded", noSystem), "neither");
  assert.equal(wantsMeasurement(initialState("1"), { reduceMotion: true, reduceTransparency: false }), false, "nothing moves to measure");
});

test("a stored state that is missing or damaged starts over", () => {
  assert.equal(parseState(null), null);
  assert.equal(parseState("{"), null);
  assert.equal(parseState(JSON.stringify({ version: "1", verdict: "maybe", apply: "full" })), null);
  const kept: BudgetState = record(initialState("1"), over, 1000);
  assert.deepEqual(parseState(JSON.stringify(kept)), kept);
  assert.deepEqual(refresh(null, "3", 0), initialState("3"));
});

function fakeProbe() {
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  const asked: number[] = [];
  const recorded: FrameSample[] = [];
  const cancelled: number[] = [];
  const attempts: ProbeAttempt[] = [];
  let answer: (sample: FrameSample | null) => void = () => undefined;
  const probe = createBudgetProbe({
    sample: (millis) => {
      asked.push(now);
      assert.equal(millis, LOOK_BUDGET.sampleMs);
      return new Promise((resolve) => (answer = resolve));
    },
    schedule: (run, millis) => {
      const timer = { at: now + millis, run, cancelled: false };
      timers.push(timer);
      return () => (timer.cancelled = true);
    },
    record: (sample, attempt) => {
      recorded.push(sample);
      attempts.push(attempt);
    },
    cancelSample: () => cancelled.push(now),
  });
  const advance = (millis: number) => {
    now += millis;
    for (const timer of timers.filter((t) => !t.cancelled && t.at <= now)) {
      timer.cancelled = true;
      timer.run();
    }
  };
  const settle = async (sample: FrameSample | null) => {
    answer(sample);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { probe, advance, settle, asked, recorded, cancelled, attempts };
}

test("the probe skips the first second after the deck shows and samples only while it stays idle", async () => {
  const { probe, advance, settle, asked, recorded } = fakeProbe();
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs - 1);
  assert.deepEqual(asked, []);
  advance(1);
  assert.deepEqual(asked, [LOOK_BUDGET.skipAfterShownMs]);
  await settle(frames(50, 9));
  assert.equal(recorded.length, 1);
});

test("the deck stopping being idle cancels the wait, and a sample already running is dropped", async () => {
  const { probe, advance, settle, asked, recorded } = fakeProbe();
  probe.update(true, true);
  advance(500);
  probe.update(false, true);
  advance(2000);
  assert.deepEqual(asked, []);
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  assert.equal(asked.length, 1);
  probe.update(false, true);
  await settle(frames(50, 40));
  assert.equal(recorded.length, 0, "the sample overlapped a scroll or a sheet");
});

test("a sample with lost frame reports decides nothing, however it measured", () => {
  const lossy = judge({ totals: Array(35).fill(40), deadlines: Array(35).fill(16.7), windowMs: 2000, droppedReports: 2 });
  assert.equal(lossy.conclusive, false);
  assert.equal(lossy.over, false);
  assert.equal(lossy.droppedReports, 2);
  assert.equal(record(initialState("1"), lossy, 1000).verdict, "unknown");
  assert.equal(judge({ totals: Array(35).fill(15), deadlines: Array(35).fill(16.7), windowMs: 2000, droppedReports: 0 }).droppedReports, undefined);
});

test("stopping the probe while a sample runs tells the sampler to stop, and only then", async () => {
  const { probe, advance, settle, cancelled } = fakeProbe();
  probe.update(true, true);
  advance(500);
  probe.update(false, true);
  assert.deepEqual(cancelled, [], "nothing was sampling yet");
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  probe.stop();
  assert.equal(cancelled.length, 1);
  probe.stop();
  assert.equal(cancelled.length, 1, "a second stop has nothing to cancel");
  await settle(null);
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  await settle(frames(50, 9));
  probe.stop();
  assert.equal(cancelled.length, 1, "a finished sample is not cancelled");
});

test("one deck open gives at most one measurement, and a phone that needs none is never sampled", async () => {
  const { probe, advance, settle, asked, recorded } = fakeProbe();
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  await settle(frames(50, 40));
  probe.update(false, true);
  probe.update(true, true);
  advance(10_000);
  assert.equal(asked.length, 1);
  assert.equal(recorded.length, 1);
  const quiet = fakeProbe();
  quiet.probe.update(true, false);
  quiet.advance(10_000);
  assert.deepEqual(quiet.asked, []);
});

test("the budget line splits the other main-thread work into the backdrop's ticks and the rest, with the count and the three longest", () => {
  const judged = judge({
    totals: Array(30).fill(10),
    deadlines: Array(30).fill(16.7),
    windowMs: 2000,
    mainThreadMs: 241.7,
    tickMs: 3.2,
    mainThreadMessages: 412,
    longestMessages: ["MessageQueueThreadHandler what 0 41.2 ms", "Handler Editor$Blink 6.0 ms", "ViewRootImpl$ViewRootHandler DeckBackdropView$$ExternalSyntheticLambda3 0.9 ms", "extra 0.1 ms"],
  });
  assert.equal(judged.longestMessages?.length, 3);
  assert.equal(
    otherWork(judged),
    "241.7 ms in 412 message(s): backdrop ticks 3.2 ms, the rest 238.5 ms; longest MessageQueueThreadHandler what 0 41.2 ms, Handler Editor$Blink 6.0 ms, ViewRootImpl$ViewRootHandler DeckBackdropView$$ExternalSyntheticLambda3 0.9 ms",
  );
});

test("a sample dropped for another view's frames is taken again after a quiet second, a few times per show", async () => {
  const { probe, advance, settle, asked, recorded, attempts } = fakeProbe();
  const late = { ...frames(50, 9), foreignFrames: 2, foreignViews: ["ReactViewGroup", "ScrollActionsView"] };
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  await settle(late);
  assert.deepEqual(attempts, [{ tries: 1, retrying: true }]);
  assert.equal(probe.measured, false, "one late redraw doesn't end the deck's chance of a verdict");
  advance(LOOK_BUDGET.quietBeforeRetryMs - 1);
  assert.equal(asked.length, 1);
  advance(1);
  assert.equal(asked.length, 2, "the next try starts after a quiet second");
  await settle(frames(50, 9));
  assert.equal(recorded.length, 2);
  assert.deepEqual(attempts[1], { tries: 2, retrying: false });
  assert.equal(probe.measured, true);
});

test("a deck that never goes quiet stops trying after the last try of its show", async () => {
  const { probe, advance, settle, asked, attempts } = fakeProbe();
  const late = { ...frames(50, 9), foreignFrames: 1 };
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  for (let tries = 1; tries <= LOOK_BUDGET.triesPerShow; tries++) {
    await settle(late);
    advance(LOOK_BUDGET.quietBeforeRetryMs);
  }
  assert.equal(asked.length, LOOK_BUDGET.triesPerShow);
  assert.deepEqual(attempts.at(-1), { tries: LOOK_BUDGET.triesPerShow, retrying: false });
  assert.equal(probe.measured, true);
});

test("a retry waiting for its quiet second is cancelled when the deck stops being idle", async () => {
  const { probe, advance, settle, asked } = fakeProbe();
  probe.update(true, true);
  advance(LOOK_BUDGET.skipAfterShownMs);
  await settle({ ...frames(50, 9), foreignFrames: 1 });
  probe.update(false, true);
  advance(LOOK_BUDGET.quietBeforeRetryMs * 3);
  assert.equal(asked.length, 1);
});

test("the judgement names the views that drew when a sample is dropped for them", () => {
  const named = judge({ totals: Array(35).fill(15), deadlines: Array(35).fill(16.7), windowMs: 2000, foreignFrames: 2, foreignViews: ["ReactViewGroup"] });
  assert.equal(named.conclusive, false);
  assert.deepEqual(named.foreignViews, ["ReactViewGroup"]);
  assert.equal(judge({ totals: Array(35).fill(15), deadlines: Array(35).fill(16.7), windowMs: 2000, foreignViews: ["ReactViewGroup"] }).foreignViews, undefined);
});
