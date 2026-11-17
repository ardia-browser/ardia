import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "./preflight.mjs";

const ready = { platform: "win32", node: "24.22.3", pnpm: "11.1.3", expectedPnpm: "11.1.3", vs: "E:\\VS", sdk: true, expectedSdk: "10.0.26100.0", dependencies: true, policy: "RemoteSigned", gh: true };

test("a complete Windows host passes", () => {
  assert.ok(evaluate(ready).every((check) => check.passed));
});

test("missing compiler, dependencies and blocked scripts are all reported", () => {
  const failed = evaluate({ ...ready, vs: "", dependencies: false, policy: "Restricted" }).filter((check) => !check.passed);
  assert.deepEqual(failed.map((check) => check.name), ["msvc", "dependencies", "powershell"]);
  assert.ok(failed.every((check) => check.remedy.length));
});

test("a mismatched package manager and unknown policy fail closed", () => {
  assert.deepEqual(evaluate({ ...ready, pnpm: "10.0.0", policy: "" }).filter((check) => !check.passed).map((check) => check.name), ["pnpm", "powershell"]);
});

test("a non-Windows host with old Node cannot build the native app", () => {
  assert.deepEqual(evaluate({ ...ready, platform: "linux", node: "22.0.0" }).filter((check) => !check.passed).map((check) => check.name), ["platform", "node"]);
});
