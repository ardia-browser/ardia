import assert from "node:assert/strict";
import test from "node:test";
import { deliverLaunch, LAUNCH_LEAD_GRACE_MS, measureLaunch } from "./launchMeasure.ts";

function consentPeriods() {
  let current = "period-1";
  return {
    token: () => current,
    stillValid: (token) => typeof token === "string" && token === current,
    off: () => (current = null),
    on: (next) => (current = next),
  };
}

test("a launch measured in one consent period is delivered in that period", () => {
  const consent = consentPeriods();
  const sample = { committedAt: 1_000, contentAt: 1_020, usableAt: 1_100, consent: consent.token() };
  const sent = [];
  assert.equal(deliverLaunch(sample, 1_500, consent.stillValid, (s) => sent.push(s)), true);
  assert.deepEqual(sent, [sample]);
});

test("sharing turned off and on again between the measurement and leadership drops the launch", () => {
  const consent = consentPeriods();
  const sample = { committedAt: 1_000, contentAt: 1_020, usableAt: 1_100, consent: consent.token() };
  consent.off();
  consent.on("period-2");
  const sent = [];
  assert.equal(deliverLaunch(sample, 1_500, consent.stillValid, (s) => sent.push(s)), false);
  assert.deepEqual(sent, []);
});

test("a launch measured while sharing was off is never delivered, even once sharing is on", () => {
  const consent = consentPeriods();
  consent.off();
  const sample = { committedAt: 1_000, contentAt: 1_020, usableAt: 1_100, consent: consent.token() };
  consent.on("period-2");
  assert.equal(deliverLaunch(sample, 1_200, consent.stillValid, () => assert.fail("sent")), false);
});

test("leadership that arrives after the grace drops the launch", () => {
  const consent = consentPeriods();
  const sample = { committedAt: 1_000, contentAt: 1_020, usableAt: 1_100, consent: consent.token() };
  assert.equal(deliverLaunch(sample, 1_100 + LAUNCH_LEAD_GRACE_MS + 1, consent.stillValid, () => assert.fail("sent")), false);
});

test("first paint and usability are measured from commit, before leadership", () => {
  let clock = 1_000;
  const painted = [];
  const later = [];
  let result = null;
  measureLaunch(1_000, (contentAt, usableAt) => (result = { contentAt, usableAt }), {
    now: () => clock,
    afterPaint: (run) => painted.push(run),
    later: (run) => later.push(run),
  });
  clock = 1_016;
  painted.shift()();
  assert.equal(result, null);
  clock = 1_030;
  later.shift()();
  assert.deepEqual(result, { contentAt: 1_016, usableAt: 1_030 });
});
