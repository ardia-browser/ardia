import assert from "node:assert/strict";
import { test } from "node:test";
import { appInfo, docs, shellNativeModules } from "../../test-native/index.ts";

appInfo.isolatedInstance = true;
docs.set("perf-probe", "");
globalThis.expo = { ...globalThis.expo, modules: { ...globalThis.expo?.modules, ArdiaApp: shellNativeModules.ArdiaApp, ArdiaDocuments: shellNativeModules.ArdiaDocuments } };
const native = shellNativeModules.ArdiaCalendar;
const reached = [];
for (const name of Object.keys(native)) {
  const real = native[name];
  native[name] = (...args) => {
    reached.push(name);
    return typeof real === "function" ? real(...args) : real;
  };
}
native.authorizationStatus = () => (reached.push("authorizationStatus"), "fullAccess");

const { isPerfRun } = await import("../app/perfRun.ts");
const { refreshCalendar, startCalendar, useCalendar } = await import("./calendar.ts");
const { slowTimersForTests } = await import("../../platform/slowTimers.ts");

test("a perf run reads the calendar fixture and never asks EventKit, so a bench copy can't read the owner's calendar", async () => {
  assert.equal(isPerfRun, true);
  startCalendar();
  await refreshCalendar();
  assert.equal(useCalendar.getState().access, "fixture");
  assert.deepEqual(useCalendar.getState().events, []);
  assert.deepEqual(reached, [], "no ArdiaCalendar call");
  slowTimersForTests(Date.now).clear();
});
