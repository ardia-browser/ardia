import assert from "node:assert/strict";
import { test } from "node:test";
import { appStateChanged } from "./appStateChange.ts";

const recorder = () => {
  const calls: string[] = [];
  const steps = {
    becameActive: () => void calls.push("becameActive"),
    resignActive: () => void calls.push("resignActive"),
    reportShownPage: () => void calls.push("reportShownPage"),
    rememberLaunchLook: () => void calls.push("rememberLaunchLook"),
  };
  return { calls, steps };
};

test("leaving reports the shown page before saving the launch look", () => {
  const { calls, steps } = recorder();
  appStateChanged("background", steps);
  assert.deepEqual(calls, ["resignActive", "reportShownPage", "rememberLaunchLook"]);
});

test("coming back reports the shown page after becoming active", () => {
  const { calls, steps } = recorder();
  appStateChanged("active", steps);
  assert.deepEqual(calls, ["becameActive", "reportShownPage"]);
});
