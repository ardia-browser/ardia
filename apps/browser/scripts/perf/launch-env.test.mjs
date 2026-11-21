import assert from "node:assert/strict";
import test from "node:test";
import { sideLaunchEnv } from "./launch-env.mjs";

const shared = ["DYLD_INSERT_LIBRARIES=/tmp/shared.dylib", "ARDIA_X=1"];
const controlOnly = ["DYLD_INSERT_LIBRARIES=/tmp/control.dylib", "ARDIA_SWITCHES=freezeWatchOff=on"];

test("the control loads the shared libraries and its own, and gets its own variables", () => {
  const { extra, libraries } = sideLaunchEnv(shared, controlOnly, "control", ["ARDIA_INSTANCE=1"]);
  assert.deepEqual(libraries, ["/tmp/shared.dylib", "/tmp/control.dylib"]);
  assert.deepEqual(extra, ["ARDIA_X=1", "ARDIA_SWITCHES=freezeWatchOff=on", "ARDIA_INSTANCE=1"]);
});

test("the switches written for a launch are the whole value after ARDIA_SWITCHES=", () => {
  assert.equal(sideLaunchEnv([], controlOnly, "control").switches, "freezeWatchOff=on");
  assert.equal(sideLaunchEnv(["ARDIA_SWITCHES=a=on,b=off"], [], "candidate").switches, "a=on,b=off");
  assert.equal(sideLaunchEnv([], controlOnly, "candidate").switches, undefined);
});

test("the candidate gets none of the control's libraries or variables", () => {
  const { extra, libraries } = sideLaunchEnv(shared, controlOnly, "candidate");
  assert.deepEqual(libraries, ["/tmp/shared.dylib"]);
  assert.deepEqual(extra, ["ARDIA_X=1"]);
});
