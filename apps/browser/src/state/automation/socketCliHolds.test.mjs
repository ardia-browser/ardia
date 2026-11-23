import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { planOverBudget } = await import("../tabs/loadedTabBudget.ts");
const { cliHoldsClockForTests, heldByCli, releaseAllCliHolds } = await import("../tabs/cliHolds.ts");
const { takeTabSleepCounts } = await import("../telemetry/tabSleepCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-cli-holds-test");

let leaseClock = 0;
cliHoldsClockForTests(() => leaseClock);

after(() => {
  releaseAllCliHolds();
  cliHoldsClockForTests(() => performance.now());
  S().updateSettings({ cliControl: false });
});

const { call, ok } = socketClient(311);
const MINUTE = 60_000;

async function hiddenTabs() {
  releaseAllCliHolds();
  const { windowId } = await freshWindow("https://shown.example/");
  const now = Date.now();
  const ids = ["https://one.example/", "https://two.example/"].map((url) => S().newTab(windowId, { url, background: true }));
  ids.forEach((id, i) => S().updateTab(id, { lastActiveAt: now - (i + 3) * 60 * MINUTE }));
  return { ids, loaded: Object.keys(S().tabs), now };
}

test("a tab the ardia command holds isn't put to sleep over the budget until the hold runs out or is released", async () => {
  const { ids, loaded, now } = await hiddenTabs();
  const budget = { tabs: 1, hiddenMs: 30 * MINUTE };
  takeTabSleepCounts();
  assert.deepEqual(planOverBudget(S(), loaded, budget, now).sleep.sort(), [...ids].sort(), "both hidden tabs may sleep before the hold");
  const held = await ok("tabs.hold", { session: "a", tabs: [ids[0], "tab-nope"], seconds: 60 });
  assert.deepEqual(held, { held: [ids[0]], gone: ["tab-nope"], seconds: 60 });
  const plan = planOverBudget(S(), loaded, budget, now);
  assert.deepEqual(plan.sleep, [ids[1]]);
  assert.deepEqual(plan.vetoed.find((v) => v.id === ids[0]), { id: ids[0], veto: "cliSession" });
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 60 });
  assert.equal(takeTabSleepCounts().cli_tabs_held, 1, "a renewal isn't a new hold");
  leaseClock += 61_000;
  assert.equal(heldByCli(ids[0]), false, "it runs out after the seconds given, on the app's own clock");
  await ok("tabs.hold", { session: "a", tabs: [ids[0]] });
  assert.deepEqual(await ok("tabs.release", { session: "a" }), { released: [ids[0]] });
  assert.deepEqual(planOverBudget(S(), loaded, budget, now).sleep.sort(), [...ids].sort());
});

test("each session's holds are its own: one releasing or moving on leaves another's hold in place", async () => {
  const { ids } = await hiddenTabs();
  await ok("tabs.hold", { session: "a", tabs: [ids[0]] });
  await ok("tabs.hold", { session: "b", tabs: [ids[0], ids[1]] });
  await ok("tabs.release", { session: "a" });
  assert.ok(heldByCli(ids[0]) && heldByCli(ids[1]), "b still holds both");
  await ok("tabs.hold", { session: "b", tabs: [ids[1]] });
  assert.equal(heldByCli(ids[0]), false, "a session's new list replaces its old one");
  assert.equal(heldByCli(ids[1]), true);
  for (const session of ["c", "d", "e"]) await ok("tabs.hold", { session, tabs: [ids[0]] });
  assert.equal((await call("tabs.hold", { session: "f", tabs: [ids[0]] })).error?.code, "refused", "at most four sessions hold at once");
});

test("tabs.hold caps the hold at five minutes and refuses bad input before holding anything", async () => {
  const { ids } = await hiddenTabs();
  for (const params of [
    { session: "a", tabs: [ids[0]], seconds: 301 },
    { session: "a", tabs: [] },
    { session: "a", tabs: Array.from({ length: 33 }, (_, i) => `t${i}`) },
    { session: "a b\nc", tabs: [ids[0]] },
    { tabs: [ids[0]] },
  ]) assert.equal((await call("tabs.hold", params)).error?.code, "bad_request", JSON.stringify(params));
  assert.equal(heldByCli(ids[0]), false);
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 300 });
  leaseClock += 299_000;
  assert.equal(heldByCli(ids[0]), true);
  leaseClock += 2_000;
  assert.equal(heldByCli(ids[0]), false);
});

test("turning the ardia command's control off ends every hold, and a hold sent after that is refused", async () => {
  const { ids } = await hiddenTabs();
  await ok("tabs.hold", { session: "a", tabs: ids });
  assert.ok(ids.every((id) => heldByCli(id)));
  S().updateSettings({ cliControl: false });
  for (let i = 0; i < 20 && ids.some((id) => heldByCli(id)); i++) await new Promise((r) => setImmediate(r));
  assert.ok(ids.every((id) => !heldByCli(id)), "the setting turning off released them");
  const late = await call("tabs.hold", { session: "a", tabs: ids });
  assert.ok(late.error, "the socket no longer takes holds");
  assert.ok(ids.every((id) => !heldByCli(id)));
});

test("a hold running out tells the profile tracker even when something read the holds first", async () => {
  const { ids } = await hiddenTabs();
  const { onCliHoldsChanged, tabsHeldByCli } = await import("../tabs/cliHolds.ts");
  let told = 0;
  const stop = onCliHoldsChanged(() => told++);
  await ok("tabs.hold", { session: "a", tabs: [ids[0]], seconds: 1 });
  told = 0;
  leaseClock += 1_500;
  assert.deepEqual(tabsHeldByCli(), [], "a read sees it ended");
  await new Promise((r) => setTimeout(r, 1_100));
  assert.equal(told, 1, "the expiry still told the listeners");
  stop();
});
