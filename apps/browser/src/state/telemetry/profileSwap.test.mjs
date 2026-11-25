import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame = (frame) => {
  queueMicrotask(() => frame(0));
  return 0;
};
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "300", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install-1", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const local = await import("./localStore.ts");
const { useBrowser } = await import("../browser/store.ts");
const { SWAP_WAIT_MS, noteProfileSwapped, profileSwapProperties, profileSwitched, switchIdOf } = await import("./profileSwap.ts");
useBrowser.getState().hydrate({});
client.startClient();
after(() => client.setSharing(false, "settings"));

const switchTo = (windowId, profile, profiles, via) => {
  profileSwitched(windowId, "p0", profile, profiles, via);
  return switchIdOf(windowId);
};

const switches = () => {
  local.flushLocal();
  return stub.telemetryLocal.records().filter((r) => r.event === "profile_switched");
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a native swap report adds swap_ms, profile_loaded and held_timed_out beside switch_ms and profiles", async () => {
  const before = switches().length;
  const switchId = switchTo("w1", "p1", 8, { via_switcher: true });
  noteProfileSwapped("w1", { switchId, selection: "p1", profileLoaded: false, activeMs: 412.4, swapMs: 2841.6, heldTimedOut: true });
  await settle();
  const [event] = switches().slice(before);
  assert.ok(event);
  assert.equal(event.properties.swap_ms, 2842);
  assert.equal(event.properties.swap_active_ms, 412);
  assert.equal(event.properties.profile_loaded, false);
  assert.equal(event.properties.held_timed_out, true);
  assert.equal(event.properties.profiles, 8);
  assert.equal(event.properties.via_switcher, true);
  assert.equal(typeof event.properties.switch_ms, "number");
});

test("a report for another window leaves the event waiting, and a loaded, drawn swap is recorded as such", async () => {
  const before = switches().length;
  const switchId = switchTo("w2", "p1", 3, {});
  noteProfileSwapped("w3", { switchId, selection: "p1", profileLoaded: true, activeMs: 1, swapMs: 2, heldTimedOut: false });
  await settle();
  assert.equal(switches().length, before);
  noteProfileSwapped("w2", { switchId, selection: "p1", profileLoaded: true, activeMs: 3, swapMs: 40, heldTimedOut: false });
  await settle();
  const [event] = switches().slice(before);
  assert.equal(event.properties.swap_ms, 40);
  assert.equal(event.properties.profile_loaded, true);
  assert.equal(event.properties.held_timed_out, false);
});

test("a report from before the switch, or with no switch id, is dropped, not given to the switch", async () => {
  const before = switches().length;
  const earlier = switchIdOf("w4");
  const switchId = switchTo("w4", "p1", 2, {});
  noteProfileSwapped("w4", { switchId: earlier, selection: "p1", profileLoaded: true, activeMs: 1, swapMs: 9, heldTimedOut: false });
  noteProfileSwapped("w4", { selection: "p1", profileLoaded: true, activeMs: 1, swapMs: 8, heldTimedOut: false });
  noteProfileSwapped("w4", {});
  await settle();
  assert.equal(switches().length, before);
  noteProfileSwapped("w4", { switchId, selection: "p1", profileLoaded: false, activeMs: 5, swapMs: 77, heldTimedOut: false });
  await settle();
  assert.equal(switches().slice(before)[0].properties.swap_ms, 77);
});

test("switches A to B to C in one window each get only their own report, even for the same profile", async () => {
  const before = switches().length;
  const toB = switchTo("w6", "p2", 3, { via_switcher: true, via_shortcut: false });
  const toC = switchTo("w6", "p3", 3, { via_switcher: false, via_shortcut: false });
  const backToB = switchTo("w6", "p2", 3, { via_switcher: false, via_shortcut: true });
  assert.ok(toB < toC && toC < backToB);
  noteProfileSwapped("w6", { switchId: toC, selection: "p3", profileLoaded: true, activeMs: 2, swapMs: 30, heldTimedOut: false });
  await settle();
  assert.equal(switches().length, before + 1);
  assert.equal(switches()[before].properties.swap_ms, 30);
  noteProfileSwapped("w6", { switchId: backToB, selection: "p2", profileLoaded: true, activeMs: 1, swapMs: 12, heldTimedOut: false });
  noteProfileSwapped("w6", { switchId: toB, selection: "p2", profileLoaded: false, activeMs: 400, swapMs: 2900, heldTimedOut: true });
  await settle();
  const which = (e) => (e.properties.via_switcher ? "toB" : e.properties.via_shortcut ? "backToB" : "toC");
  const got = Object.fromEntries(switches().slice(before).map((e) => [which(e), [e.properties.swap_ms, e.properties.profile_loaded]]));
  assert.deepEqual(got, { toC: [30, true], backToB: [12, true], toB: [2900, false] });
});

test("a switch between profiles that share one engine profile goes out without waiting for a native swap", async () => {
  const before = switches().length;
  const s = useBrowser.getState();
  const owner = s.createProfile({ name: "Owner" });
  const sharer = useBrowser.getState().createProfile({ name: "Sharer", shareWith: owner });
  const was = switchIdOf("w8");
  profileSwitched("w8", owner, sharer, 3, {});
  await settle();
  assert.equal(switchIdOf("w8"), was, "no native report is expected");
  const [event] = switches().slice(before);
  assert.ok(event);
  for (const key of ["swap_ms", "swap_active_ms", "profile_loaded", "held_timed_out"]) assert.equal(key in event.properties, false);
});

test("with no native report the event still goes out after the wait, without the swap fields", async (t) => {
  const before = switches().length;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  switchTo("w5", "p1", 4, {});
  await settle();
  t.mock.timers.tick(SWAP_WAIT_MS - 1);
  await settle();
  assert.equal(switches().length, before);
  t.mock.timers.tick(1);
  await settle();
  t.mock.timers.reset();
  const [event] = switches().slice(before);
  assert.ok(event);
  assert.equal(typeof event.properties.switch_ms, "number");
  assert.equal(event.properties.profiles, 4);
  for (const key of ["swap_ms", "swap_active_ms", "profile_loaded", "held_timed_out"]) assert.equal(key in event.properties, false);
});

test("only numbers and booleans come through, and a bad value is skipped", () => {
  assert.deepEqual(profileSwapProperties(null), {});
  assert.deepEqual(profileSwapProperties({ swapMs: "https://example.com", activeMs: -1, profileLoaded: "yes", heldTimedOut: false, url: "https://example.com" }), { held_timed_out: false });
  assert.deepEqual(profileSwapProperties({ swapMs: Number.NaN, activeMs: 12.5, profileLoaded: true }), { swap_active_ms: 13, profile_loaded: true });
});
