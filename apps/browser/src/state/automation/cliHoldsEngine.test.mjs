import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { cliHoldsClockForTests, releaseAllCliHolds } = await import("../tabs/cliHolds.ts");
const { pushCliHoldsToEngine } = await import("./cliHoldsEngine.ts");
const { engineVeto } = await import("../tabs/sleepPolicy.ts");
const { onlyAutomaticProtections } = await import("../tabs/sleepRefusals.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "cli-holds-engine-test");

let leaseClock = 0;
cliHoldsClockForTests(() => leaseClock);
const pushed = [];
const seconds = [];
let kept = 0;
let answerWith = null;
globalThis.acTestCliHeld = (tabs) => {
  pushed.push(tabs.map((t) => t.tabId).sort());
  seconds.push(Object.fromEntries(tabs.map((t) => [t.tabId, Math.round((t.until - Date.now()) / 1000)])));
  const next = answerWith;
  answerWith = null;
  if (next) return next();
  const answer = { kept };
  kept = 0;
  return answer;
};

after(() => {
  releaseAllCliHolds();
  cliHoldsClockForTests(() => performance.now());
  delete globalThis.acTestCliHeld;
  S().updateSettings({ cliControl: false });
});

const { ok } = socketClient(312);

const { consentToken } = await import("../telemetry/client.ts");
const settled = () => pushCliHoldsToEngine(consentToken());

test("every hold change hands the engine the tabs held right now, and the socket stopping hands it none", async () => {
  releaseAllCliHolds();
  const { windowId } = await freshWindow("https://shown.example/");
  const ids = ["https://one.example/", "https://two.example/"].map((url) => S().newTab(windowId, { url, background: true }));
  await settled();
  pushed.length = 0;
  const first = await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 60 });
  assert.equal(first.engineKeeps, true);
  assert.deepEqual(pushed.at(-1), [ids[0]], "tabs.hold answers only once the engine has the tab");
  assert.deepEqual(seconds.at(-1), { [ids[0]]: 60 }, "with the seconds its hold has left, so the engine ends it even if the app forgets");
  await ok("tabs.hold", { session: "b", tabs: [ids[1], ids[0]], seconds: 30 });
  assert.deepEqual(pushed.at(-1), [...ids].sort(), "both sessions' tabs");
  assert.deepEqual(seconds.at(-1), { [ids[0]]: 60, [ids[1]]: 30 }, "a tab two sessions hold lasts as long as the longer hold");
  await ok("tabs.release", { session: "a" });
  await settled();
  assert.deepEqual(seconds.at(-1), { [ids[0]]: 30, [ids[1]]: 30 }, "one session's release leaves the other's hold, now the shorter one");
  leaseClock += 61_000;
  await settled();
  assert.deepEqual(pushed.at(-1), [], "a hold that ran out is gone from the engine too");
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 60 });
  releaseAllCliHolds();
  await settled();
  assert.deepEqual(pushed.at(-1), [], "stopping the socket releases every hold, and the engine hears it");
});

test("the discards Chromium asked for on held tabs are counted for the sharing period they happened in", async () => {
  await settled();
  takeTabSleepCounts();
  kept = 2;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 2, "counted since the last push, which sharing covered");
  setConsentPeriod(false, "cli-holds-engine-test");
  await settled();
  kept = 3;
  setConsentPeriod(true, "cli-holds-engine-test");
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 0, "what the engine counted while sharing was off isn't sent once it's back on");
  kept = 1;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 1, "the next period, all under sharing, counts again");
});

test("the engine's kept-by code 103 is a CLI session, and a person's own Sleep Tab still wins over it", () => {
  assert.equal(engineVeto([103]), "cliSession");
  assert.equal(engineVeto([103, 100]), "postedDocument", "a form post outranks it");
  assert.equal(onlyAutomaticProtections([103]), true, "Sleep Tab from the menu goes past it");
  assert.equal(onlyAutomaticProtections([103, 5]), false, "but not past audio");
});

test("a hold that ends while an earlier update is still on its way never reaches the engine, and a refused update says so", async () => {
  releaseAllCliHolds();
  await settled();
  const { windowId } = await freshWindow("https://shown.example/");
  const id = S().newTab(windowId, { url: "https://late.example/", background: true });
  let finish;
  let stallReached;
  const reached = new Promise((resolve) => (stallReached = resolve));
  answerWith = () => {
    stallReached();
    return new Promise((resolve) => (finish = () => resolve({ kept: 0 })));
  };
  const stalled = settled();
  await reached;
  const holding = ok("tabs.hold", { session: "late", tabs: [id], seconds: 60 });
  releaseAllCliHolds();
  const before = pushed.length;
  finish();
  await stalled;
  const reply = await holding;
  await settled();
  assert.ok(pushed.slice(before).every((tabs) => !tabs.includes(id)), "every update after the stall carries what's held when it is sent: nothing");
  assert.equal(reply.engineKeeps, false, "a hold released before its update reached the engine isn't reported as kept");
  answerWith = () => {
    throw new Error("the engine refused");
  };
  const refused = await ok("tabs.hold", { session: "late", tabs: [id], seconds: 60 });
  assert.equal(refused.engineKeeps, false, "the client learns Chromium may still discard the tab");
  releaseAllCliHolds();
  await settled();
});

test("a drain that fails leaves its counts to the period they were made in", async () => {
  await settled();
  takeTabSleepCounts();
  setConsentPeriod(false, "cli-holds-engine-test");
  await settled();
  setConsentPeriod(true, "cli-holds-engine-test");
  answerWith = () => {
    throw new Error("the engine refused");
  };
  await settled();
  kept = 2;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 0, "the period began with sharing off, and a failed drain didn't start a new one");
  kept = 1;
  await settled();
  assert.equal(takeTabSleepCounts().chrome_discards_kept_for_cli, 1);
});

test("a one-second hold reaches the engine with the time it ends, not a rounded-down nothing", async () => {
  releaseAllCliHolds();
  await settled();
  const { windowId } = await freshWindow("https://shown.example/");
  const id = S().newTab(windowId, { url: "https://brief.example/", background: true });
  const reply = await ok("tabs.hold", { session: "brief", tabs: [id], seconds: 1 });
  assert.equal(reply.engineKeeps, true);
  assert.deepEqual(pushed.at(-1), [id], "the engine got the tab");
  assert.equal(seconds.at(-1)[id], 1);
  releaseAllCliHolds();
  await settled();
});

test("engineKeeps is true only when the engine marked every held tab", async () => {
  releaseAllCliHolds();
  await settled();
  const { windowId } = await freshWindow("https://shown.example/");
  const id = S().newTab(windowId, { url: "https://unmarked.example/", background: true });
  answerWith = () => ({ kept: 0, marked: [] });
  const unmarked = await ok("tabs.hold", { session: "mark", tabs: [id], seconds: 60 });
  assert.equal(unmarked.engineKeeps, false, "a tab the engine found no page for, or whose hold had ended, isn't reported as kept");
  const marked = await ok("tabs.hold", { session: "mark", tabs: [id], seconds: 60 });
  assert.equal(marked.engineKeeps, true);
  releaseAllCliHolds();
  await settled();
});

test("a hold that ends while the engine's answer is on its way isn't reported kept, and a release answers only once the engine let go", async () => {
  releaseAllCliHolds();
  await settled();
  const { windowId } = await freshWindow("https://shown.example/");
  const id = S().newTab(windowId, { url: "https://slow.example/", background: true });
  let finish;
  answerWith = () => new Promise((resolve) => (finish = () => resolve({ kept: 0, marked: [id] })));
  const holding = ok("tabs.hold", { session: "slow", tabs: [id], seconds: 1 });
  while (!finish) await new Promise((done) => setImmediate(done));
  leaseClock += 1_500;
  finish();
  assert.equal((await holding).engineKeeps, false, "the hold ran out before the answer went out");
  await ok("tabs.hold", { session: "slow", tabs: [id], seconds: 60 });
  let cleared;
  answerWith = () => new Promise((resolve) => (cleared = () => resolve({ kept: 0, marked: [] })));
  let answered = false;
  const releasing = ok("tabs.release", { session: "slow" }).then((reply) => ((answered = true), reply));
  while (!cleared) await new Promise((done) => setImmediate(done));
  assert.equal(answered, false, "tabs.release waits for the engine to let the tab go");
  cleared();
  assert.deepEqual((await releasing).released, [id]);
  assert.deepEqual(pushed.at(-1), [], "the engine heard the release");
});
