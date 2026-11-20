import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { passkeyTarget } = await import("./passkeyTarget.ts");

const provider = (id, state, save = true) => ({ id, name: id, state, capabilities: { save } });
const ARDIA = provider("ardia", "unlocked");
const names = { ardia: "Ardia", bitwarden: "Bitwarden", "1password": "1Password", protonpass: "Proton Pass" };
const nameOf = (id) => names[id] ?? id;

test("a passkey follows Save New Logins To when that manager can hold it", () => {
  const result = passkeyTarget([ARDIA, provider("bitwarden", "unlocked")], "bitwarden", nameOf);
  assert.deepEqual(result, { targets: ["ardia", "bitwarden"], target: "bitwarden", note: null });
});

test("the one connected manager is the default, as for logins", () => {
  assert.equal(passkeyTarget([ARDIA, provider("bitwarden", "unlocked")], "", nameOf).target, "bitwarden");
});

test("a manager that can't hold passkeys says so and saves to Ardia, never silently", () => {
  const result = passkeyTarget([ARDIA, provider("1password", "unlocked")], "1password", nameOf);
  assert.equal(result.target, "ardia");
  assert.deepEqual(result.targets, ["ardia"]);
  assert.match(result.note, /1Password can't keep passkeys/);
});

test("a locked Bitwarden is named, with what to do", () => {
  const result = passkeyTarget([ARDIA, provider("bitwarden", "locked")], "bitwarden", nameOf);
  assert.equal(result.target, "ardia");
  assert.match(result.note, /Bitwarden is locked/);
});

test("with only Ardia it's Ardia, with nothing to explain", () => {
  assert.deepEqual(passkeyTarget([ARDIA], "", nameOf), { targets: ["ardia"], target: "ardia", note: null });
});
