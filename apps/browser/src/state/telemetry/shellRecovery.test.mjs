import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { shellRecoveryProperties, SHELL_RECOVERY_DOC } = await import("./shellRecovery.ts");

const reading = (contents) => (name) => (name === SHELL_RECOVERY_DOC ? contents : null);

test("the previous session's shell recoveries become app_launched properties", () => {
  assert.equal(SHELL_RECOVERY_DOC, "shell-recovery-previous.json");
  assert.deepEqual(shellRecoveryProperties(reading('{"attempts":3,"recovered":2,"exhausted":1}\n')), {
    prev_shell_recovery_attempts: 3,
    prev_shell_recovery_recovered: 2,
    prev_shell_recovery_exhausted: 1,
  });
});

test("a session where every window came back reports no exhaustion beyond zero", () => {
  assert.deepEqual(shellRecoveryProperties(reading('{"attempts":2,"recovered":2,"exhausted":0}')), {
    prev_shell_recovery_attempts: 2,
    prev_shell_recovery_recovered: 2,
    prev_shell_recovery_exhausted: 0,
  });
});

test("a session with no recoveries adds nothing", () => {
  assert.deepEqual(shellRecoveryProperties(reading("{}\n")), {});
  assert.deepEqual(shellRecoveryProperties(reading('{"attempts":0,"recovered":0,"exhausted":0}')), {});
});

test("no file, a broken file or odd values add nothing, and counts are capped", () => {
  assert.deepEqual(shellRecoveryProperties(reading(null)), {});
  assert.deepEqual(shellRecoveryProperties(reading("{not json")), {});
  assert.deepEqual(shellRecoveryProperties(reading("[3,2,1]")), {});
  assert.deepEqual(shellRecoveryProperties(reading('{"attempts":-1,"recovered":"2","exhausted":true}')), {});
  assert.deepEqual(shellRecoveryProperties(() => { throw new Error("no documents"); }), {});
  assert.deepEqual(shellRecoveryProperties(reading('{"attempts":4294967295,"recovered":1.6,"url":"https://example.com"}')), {
    prev_shell_recovery_attempts: 1000,
    prev_shell_recovery_recovered: 2,
  });
});
