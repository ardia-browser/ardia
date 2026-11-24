import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const { readSiteBlocker } = await import("./siteControls.ts");
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");

const blocker = ardiaCoreNativeModules.ArdiaContentBlocker;
const fakeCall = blocker.call;
const answering = (replies) => {
  const asked = [];
  blocker.call = async (verb) => {
    asked.push(verb);
    const reply = replies[verb];
    if (reply instanceof Error) throw reply;
    return JSON.stringify(reply ?? null);
  };
  return asked;
};

afterEach(() => {
  blocker.call = fakeCall;
  PLATFORM_FEATURES.contentBlocker = true;
});

test("an engine with no blocker answers its state with null, as Windows does, and the site's blocker reads as none instead of rejecting", async () => {
  answering({ state: null, isAllowed: false });
  assert.equal(await readSiteBlocker("example.com"), null);
});

test("a blocker the engine reports comes back with whether this site is allowed", async () => {
  answering({ state: { enabled: true, lists: [] }, isAllowed: true });
  assert.deepEqual(await readSiteBlocker("example.com"), { enabled: true, allowed: true });
  answering({ state: { enabled: false, lists: [] }, isAllowed: new Error("refused") });
  assert.deepEqual(await readSiteBlocker("example.com"), { enabled: false, allowed: false });
});

test("a failed state read is no blocker, not an unhandled rejection", async () => {
  answering({ state: new Error("refused"), isAllowed: false });
  assert.equal(await readSiteBlocker("example.com"), null);
});

test("a platform without a blocker never asks the engine", async () => {
  PLATFORM_FEATURES.contentBlocker = false;
  const asked = answering({ state: { enabled: true, lists: [] }, isAllowed: false });
  assert.equal(await readSiteBlocker("example.com"), null);
  assert.deepEqual(asked, []);
});
