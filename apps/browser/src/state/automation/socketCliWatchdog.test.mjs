import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { cliHoldsClockForTests, cliHoldsLeft, heldByCli, releaseAllCliHolds } = await import("../tabs/cliHolds.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-cli-watchdog-test");

let leaseClock = 0;
cliHoldsClockForTests(() => leaseClock);
const pushes = [];
globalThis.acTestCliHeld = (tabs) => {
  pushes.push(tabs);
  return { kept: 0 };
};
const consoleAsks = [];
globalThis.acTestCliConsole = (args) => {
  consoleAsks.push(args);
  return { entries: [{ seq: 4, level: "error", exception: true, mainFrame: true, text: "Uncaught TypeError: x", source: "https://one.example/a.js", line: 3, time: 1 }], next: 4, last: 4, dropped: 0, errors: 1, more: false };
};

after(() => {
  releaseAllCliHolds();
  cliHoldsClockForTests(() => performance.now());
  delete globalThis.acTestCliHeld;
  delete globalThis.acTestCliConsole;
  S().updateSettings({ cliControl: false });
});

const daemon = socketClient(401);
const other = socketClient(402);

async function backgroundTabs() {
  releaseAllCliHolds();
  const { windowId } = await freshWindow("https://shown.example/");
  return ["https://one.example/", "https://two.example/"].map((url) => S().newTab(windowId, { url, background: true }));
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

test("a hold until disconnect needs no renewing and ends the moment its connection closes, however the command died", async () => {
  const ids = await backgroundTabs();
  takeTabSleepCounts();
  const held = await daemon.ok("tabs.hold", { session: "watch", tabs: [ids[0]], untilDisconnect: true, seconds: 5 });
  assert.equal(held.untilDisconnect, true);
  assert.equal(held.seconds, null, "a tethered hold has no timer");
  await other.ok("tabs.hold", { session: "timed", tabs: [ids[1]], seconds: 60 });
  leaseClock += 60 * 60_000;
  assert.equal(heldByCli(ids[0]), true, "an hour on, with nothing sent, the tethered hold still stands");
  assert.equal(heldByCli(ids[1]), false, "the timed one ran out as before");
  const left = cliHoldsLeft(1_000).find((hold) => hold.tabId === ids[0]);
  assert.ok(left && left.until <= 1_000 + 300_000, "the engine is told at most five minutes at a time and renewed by the app");
  stub.emitControlClose(402);
  assert.equal(heldByCli(ids[0]), true, "another connection closing leaves it alone");
  stub.emitControlClose(401);
  assert.equal(heldByCli(ids[0]), false, "its own connection closing ends it at once");
  await settle();
  const last = pushes.at(-1) ?? [];
  assert.ok(!last.some((hold) => hold.tabId === ids[0]), "the engine is told the hold ended");
  const counts = takeTabSleepCounts();
  assert.equal(counts.cli_tabs_held_until_disconnect, 1);
  assert.equal(counts.cli_holds_released_on_disconnect, 1);
});

test("two connections using one session name each keep their own tethered hold", async () => {
  const ids = await backgroundTabs();
  const first = socketClient(411);
  const second = socketClient(412);
  await first.ok("tabs.hold", { session: "same", tabs: [ids[0]], untilDisconnect: true });
  await second.ok("tabs.hold", { session: "same", tabs: [ids[1]], untilDisconnect: true });
  assert.ok(heldByCli(ids[0]) && heldByCli(ids[1]), "the second connection didn't replace the first one's hold");
  await second.ok("tabs.hold", { session: "same", tabs: [ids[1]], seconds: 30 });
  assert.equal(heldByCli(ids[0]), true, "a timed hold under the same name leaves the tethered one alone");
  assert.deepEqual((await second.ok("tabs.release", { session: "same" })).released, [ids[1]]);
  assert.equal(heldByCli(ids[0]), true, "another connection's release doesn't end it");
  stub.emitControlClose(411);
  assert.equal(heldByCli(ids[0]), false);
  stub.emitControlClose(412);
  releaseAllCliHolds();
});

test("a timed hold outlives the one-shot connection that sent it", async () => {
  const ids = await backgroundTabs();
  const oneShot = socketClient(403);
  await oneShot.ok("tabs.hold", { session: "once", tabs: [ids[0]], seconds: 60 });
  stub.emitControlClose(403);
  assert.equal(heldByCli(ids[0]), true);
  releaseAllCliHolds();
});

test("a live hold asks the engine to keep the tab drawing, and the ask ends with the hold", async () => {
  const ids = await backgroundTabs();
  takeTabSleepCounts();
  pushes.length = 0;
  const held = await daemon.ok("tabs.hold", { session: "live", tabs: [ids[0]], untilDisconnect: true, live: true });
  assert.equal(held.live, true);
  await settle();
  assert.deepEqual(pushes.at(-1)?.map(({ tabId, live }) => ({ tabId, live })), [{ tabId: ids[0], live: true }]);
  assert.equal(takeTabSleepCounts().cli_tabs_held_live, 1);
  await daemon.ok("tabs.hold", { session: "live", tabs: [ids[0]], untilDisconnect: true, live: true });
  assert.equal(takeTabSleepCounts().cli_tabs_held_live, 0, "renewing a live hold isn't a new one");
  await daemon.ok("tabs.hold", { session: "plain", tabs: [ids[1]], untilDisconnect: true });
  takeTabSleepCounts();
  await daemon.ok("tabs.hold", { session: "plain", tabs: [ids[1]], untilDisconnect: true, live: true });
  const renewed = takeTabSleepCounts();
  assert.equal(renewed.cli_tabs_held_live, 1, "turning live on for a tab already held counts it");
  assert.equal(renewed.cli_tabs_held, 0);
  await daemon.ok("tabs.release", { session: "plain" });
  await daemon.ok("tabs.release", { session: "live" });
  await settle();
  assert.deepEqual(pushes.at(-1), []);
});

test("a hold until disconnect from a caller with no connection is refused", async () => {
  const ids = await backgroundTabs();
  const { runSpec, servingWhile } = await import("./socketCatalog.ts");
  const { TAB_METHODS } = await import("./socketTabs.ts");
  const spec = TAB_METHODS.find((method) => method.name === "tabs.hold");
  const body = await runSpec(spec, { session: "x", tabs: [ids[0]], untilDisconnect: true }, servingWhile(() => true));
  assert.equal(body.error?.code, "refused");
  assert.equal(heldByCli(ids[0]), false);
});

test("tabs.consoleDelta hands the engine only a known tab and a whole watermark", async () => {
  const ids = await backgroundTabs();
  consoleAsks.length = 0;
  const delta = await daemon.ok("tabs.consoleDelta", { tab: ids[0], after: 3, generation: 2, limit: 50 });
  assert.equal(delta.next, 4);
  assert.equal(delta.entries[0].exception, true);
  assert.deepEqual(consoleAsks.map(({ tabId, after, generation, limit }) => ({ tabId, after, generation, limit })), [{ tabId: ids[0], after: 3, generation: 2, limit: 50 }]);
  for (const params of [{ tab: ids[0], after: -1 }, { tab: ids[0], after: 1.5 }, { tab: ids[0], limit: 0 }, { tab: ids[0], limit: 201 }, { tab: ids[0], generation: -2 }, { tab: ids[0], generation: "1" }, { after: 0 }, { tab: "tab-nope" }]) {
    const reply = await daemon.call("tabs.consoleDelta", params);
    assert.ok(reply.error, JSON.stringify(params));
  }
  assert.equal(consoleAsks.length, 1, "no bad request reached the engine");
});

test("every shared hostile input as a hold or console param is refused before the engine or the hold list sees it", async () => {
  const ids = await backgroundTabs();
  consoleAsks.length = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    for (const key of ["untilDisconnect", "live"]) {
      if (typeof value === "boolean" || value === undefined) continue;
      const reply = await daemon.call("tabs.hold", { session: "h", tabs: [ids[0]], [key]: value });
      assert.equal(reply.error?.code, "bad_request", `${key} ${id}`);
    }
    for (const key of ["after", "generation", "limit"]) {
      if (value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= 200)) continue;
      if (key !== "limit" && Number.isSafeInteger(value) && value >= 0) continue;
      const reply = await daemon.call("tabs.consoleDelta", { tab: ids[0], [key]: value });
      assert.equal(reply.error?.code, "bad_request", `${key} ${id}`);
    }
    if (value !== undefined) {
      const reply = await daemon.call("tabs.consoleDelta", { tab: value });
      assert.ok(reply.error, `tab ${id}`);
    }
  }
  assert.equal(heldByCli(ids[0]), false);
  assert.equal(consoleAsks.length, 0);
});
