import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { passkeyTarget } = await import("./passkeyTarget.ts");

const provider = (id, state, passkeys = false) => ({ id, name: id, state, capabilities: { save: true, passkeys } });
const ARDIA = provider("ardia", "unlocked");
const names = { ardia: "Ardia", holder: "Holder", plain: "Plain" };
const nameOf = (id) => names[id] ?? id;

test("a passkey follows Save New Logins To when that manager can hold passkeys", () => {
  const result = passkeyTarget([ARDIA, provider("holder", "unlocked", true)], "holder", nameOf);
  assert.deepEqual(result, { targets: ["ardia", "holder"], target: "holder", note: null });
});

test("the one connected manager is the default, as for logins", () => {
  assert.equal(passkeyTarget([ARDIA, provider("holder", "unlocked", true)], "", nameOf).target, "holder");
});

test("a manager without the passkeys capability says so and saves to Ardia, never silently", () => {
  const result = passkeyTarget([ARDIA, provider("plain", "unlocked")], "plain", nameOf);
  assert.equal(result.target, "ardia");
  assert.deepEqual(result.targets, ["ardia"]);
  assert.match(result.note, /Plain can't keep passkeys/);
});

test("a locked passkey holder is named, with what to do", () => {
  const result = passkeyTarget([ARDIA, provider("holder", "locked", true)], "holder", nameOf);
  assert.equal(result.target, "ardia");
  assert.match(result.note, /Holder is locked/);
});

test("with only Ardia it's Ardia, with nothing to explain", () => {
  assert.deepEqual(passkeyTarget([ARDIA], "", nameOf), { targets: ["ardia"], target: "ardia", note: null });
});
