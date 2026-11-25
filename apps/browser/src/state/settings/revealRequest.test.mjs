import assert from "node:assert/strict";
import { mock, test } from "node:test";
const { openSettings, replaceSettingsPlace, goToSettingsPane, useSettingsNav } = await import("./settingsWindows.ts");
const { REVEAL_MEASURE_MS, revealSettingRow, revealTargetShown, revealWanted, runReveal, setSettingsQuery, useSettingsSearch } = await import("./searchState.ts");
const usage = await import("../telemetry/usage.ts");
const client = await import("../telemetry/client.ts");
const { consentToken } = await import("../telemetry/choice.ts");
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const nav = () => useSettingsNav.getState();
const request = () => useSettingsSearch.getState().reveal;
const at = (pane, profileId = null, detail = null) => useSettingsNav.setState({ pane, profileId, detail, back: [], forward: [] });

let missesSeen = 0;
async function revealMisses() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  const total = events.reduce((sum, e) => sum + (e.settings_reveal_misses ?? 0), 0);
  const added = total - missesSeen;
  missesSeen = total;
  return added;
}

function anchor() {
  const calls = [];
  return { calls, still: () => true, measure: (found, failed) => calls.push({ found, failed }) };
}

test("S1: Manage Extensions commits the destination before it asks for the row, so the request names that destination", () => {
  at("general");
  let seen = null;
  const unsubscribe = useSettingsSearch.subscribe((s) => {
    if (s.reveal && !seen) seen = { pane: nav().pane, profileId: nav().profileId };
  });
  setSettingsQuery("cookies");
  openSettings("profiles", "work", null, "profiles.extensions");
  unsubscribe();
  assert.deepEqual(seen, { pane: "profiles", profileId: "work" }, "navigation was already at the destination when the reveal was published");
  assert.deepEqual(request().target, { pane: "profiles", profileId: "work", detail: null });
  assert.equal(revealWanted(request(), nav()), true);
  assert.equal(useSettingsSearch.getState().query, "");
});

test("S2: a request for profile B is dropped when the user moves on to C before B shows, and never follows C", () => {
  at("profiles", "a");
  openSettings("profiles", "b", null, "profiles.extensions");
  const forB = request();
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "a", detail: null }, forB), false, "A is still shown while B loads");
  replaceSettingsPlace("c");
  assert.equal(revealWanted(forB, nav()), false, "C supersedes B's request");
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "c", detail: null }, forB), false);
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "b", detail: "extension:x" }, forB), false, "B's extension page is not B's overview");
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "b", detail: null }, forB), true);
});

test("S2 (round 2): navigating A, then B, then back to A drops A's request on the way out, so it never fires again", () => {
  at("profiles", "a");
  revealSettingRow("profiles.extensions", consentToken());
  const forA = request();
  replaceSettingsPlace("b");
  assert.equal(request(), null, "leaving A's place cancels its request in the navigation action itself");
  replaceSettingsPlace("a");
  assert.equal(request(), null);
  assert.equal(revealWanted(forA, nav()), false);
});

test("S3: a measurement answered after a newer request neither scrolls, flashes nor clears the newer one", () => {
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const first = request();
  const old = anchor();
  const placed = [];
  runReveal(first, "profiles.extensions", () => old, (y) => placed.push(["first", y]));
  revealSettingRow("profiles.extensions", consentToken());
  const second = request();
  assert.notEqual(second.token, first.token);
  old.calls[0].found(400, 30);
  old.calls[0].failed();
  assert.deepEqual(placed, []);
  assert.equal(request().token, second.token, "the newer request is still pending");
  const fresh = anchor();
  runReveal(second, "profiles.extensions", () => fresh, (y) => placed.push(["second", y]));
  fresh.calls[0].found(500, 30);
  assert.deepEqual(placed, [["second", 500]]);
  assert.equal(request(), null);
  assert.equal(useSettingsSearch.getState().flash.id, "profiles.extensions");
});

test("S3: an answer from an anchor that was replaced, success or failure, measures the replacement instead", () => {
  at("profiles", "work");
  for (const outcome of ["found", "failed"]) {
    revealSettingRow("profiles.extensions", consentToken());
    const asked = request();
    let current = anchor();
    const first = current;
    const placed = [];
    runReveal(asked, "profiles.extensions", () => current, (y) => placed.push(y));
    current = anchor();
    first.still = () => false;
    if (outcome === "found") first.calls[0].found(300, 30);
    else first.calls[0].failed();
    assert.deepEqual(placed, [], `${outcome}: nothing scrolls from the replaced anchor`);
    assert.equal(request()?.token, asked.token, `${outcome}: the request stays pending`);
    assert.equal(current.calls.length, 1, `${outcome}: the replacement is measured`);
    current.calls[0].found(320, 30);
    assert.deepEqual(placed, [320]);
    assert.equal(request(), null);
  }
});

test("S3: once the attempt is cleaned up, a late success neither scrolls nor ends the request", () => {
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const asked = request();
  const late = anchor();
  const placed = [];
  const stop = runReveal(asked, "profiles.extensions", () => late, (y) => placed.push(y));
  stop();
  late.calls[0].found(300, 30);
  late.calls[0].failed();
  assert.deepEqual(placed, []);
  assert.equal(request()?.token, asked.token);
});

test("S3: a measurement whose anchor was replaced since it was asked for does nothing", () => {
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const asked = request();
  let current = true;
  const placed = [];
  const replaced = { still: () => current, measure: (found) => { current = false; found(300, 30); } };
  let located = 0;
  runReveal(asked, "profiles.extensions", () => (located++ ? null : replaced), (y) => placed.push(y));
  assert.deepEqual(placed, []);
  assert.equal(located, 2, "it looked for the anchor again");
});

test("S4: a failed or unanswered measurement counts one miss and ends the request", async (t) => {
  client.setSharing(true, "onboarding");
  t.after(() => client.setSharing(false, "settings"));
  await revealMisses();
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const failing = anchor();
  runReveal(request(), "profiles.extensions", () => failing, () => {});
  failing.calls[0].failed();
  failing.calls[0].failed();
  assert.equal(request(), null);
  assert.equal(await revealMisses(), 1);

  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  revealSettingRow("profiles.extensions", consentToken());
  const silent = anchor();
  runReveal(request(), "profiles.extensions", () => silent, () => {});
  mock.timers.tick(REVEAL_MEASURE_MS - 1);
  assert.notEqual(request(), null);
  mock.timers.tick(1);
  assert.equal(request(), null);
  silent.calls[0].failed();
  assert.equal(await revealMisses(), 1, "the unanswered measurement counts once, a late answer adds nothing");

  revealSettingRow("profiles.extensions", consentToken());
  const stopped = runReveal(request(), "profiles.extensions", () => anchor(), () => {});
  goToSettingsPane("general");
  stopped();
  mock.timers.tick(REVEAL_MEASURE_MS);
  assert.equal(await revealMisses(), 0, "a request the user navigated away from isn't a miss");
});

test("S4 (round 2): consent is the one taken when the reveal was requested, so a request made while sharing was off never adds a miss after opting in", async (t) => {
  client.setSharing(false, "settings");
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const asked = request();
  client.setSharing(true, "onboarding");
  t.after(() => client.setSharing(false, "settings"));
  await revealMisses();
  const failing = anchor();
  runReveal(asked, "profiles.extensions", () => failing, () => {});
  failing.calls[0].failed();
  assert.equal(request(), null);
  assert.equal(await revealMisses(), 0);
});

test("S5 (round 2): a miss is handed to the relay at once, with the request's consent, where a window has one", async (t) => {
  client.setSharing(true, "onboarding");
  t.after(() => client.setSharing(false, "settings"));
  const relayed = [];
  usage.setCountsRelayNow((consent) => relayed.push(consent));
  t.after(() => usage.setCountsRelayNow(null));
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const asked = request();
  const failing = anchor();
  runReveal(asked, "profiles.extensions", () => failing, () => {});
  failing.calls[0].failed();
  assert.deepEqual(relayed, [asked.consent]);
  assert.notEqual(asked.consent, null);
});

test("S5: a miss with expired or absent consent never triggers the relay, leaving valid window counts intact", async (t) => {
  client.setSharing(false, "settings");
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const askedWhileOff = request();
  client.setSharing(true, "onboarding");
  t.after(() => client.setSharing(false, "settings"));
  const relayed = [];
  usage.setCountsRelayNow((consent) => {
    relayed.push(consent);
    usage.emitWindowUsage(consent);
  });
  t.after(() => usage.setCountsRelayNow(null));
  usage.noteSettingsSearch("started", consentToken());
  const failing = anchor();
  runReveal(askedWhileOff, "profiles.extensions", () => failing, () => {});
  failing.calls[0].failed();
  assert.deepEqual(relayed, [], "expired/absent consent must not invoke the relay");
  usage.emitWindowUsage(consentToken());
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  assert.ok(events.some((p) => (p.settings_searches ?? 0) >= 1), "valid counts in the current consent period survive");
});

test("S6 (round 3): a detached anchor that never calls back retries and measures its replacement within the deadline", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const asked = request();
  const detached = anchor();
  const replacement = anchor();
  let current = detached;
  const placed = [];
  const stop = runReveal(asked, "profiles.extensions", () => current, (y) => placed.push(y));
  t.after(stop);
  detached.still = () => false;
  current = replacement;
  mock.timers.tick(25);
  assert.equal(replacement.calls.length, 1, "the replacement anchor was measured even though the detached one stayed silent");
  replacement.calls[0].found(420, 30);
  assert.deepEqual(placed, [420]);
  assert.equal(request(), null);
});

test("S6 (round 3): an anchor missing on the first frame retries until it mounts within the deadline", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  at("profiles", "work");
  revealSettingRow("profiles.extensions", consentToken());
  const asked = request();
  let current = null;
  const placed = [];
  const stop = runReveal(asked, "profiles.extensions", () => current, (y) => placed.push(y));
  t.after(stop);
  assert.equal(request()?.token, asked.token, "missing on frame 1 does not immediately give up");
  const mounted = anchor();
  current = mounted;
  mock.timers.tick(25);
  assert.equal(mounted.calls.length, 1);
  mounted.calls[0].found(310, 30);
  assert.deepEqual(placed, [310]);
  assert.equal(request(), null);
});
