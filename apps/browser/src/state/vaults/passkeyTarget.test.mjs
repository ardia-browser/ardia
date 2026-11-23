import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { passkeyTarget, routeOfTarget, providerOfSystemRow, systemRowId } = await import("./passkeyTarget.ts");

const provider = (id, state, passkeys = false) => ({ id, name: id, state, capabilities: { save: true, passkeys } });
const ARDIA = provider("ardia", "unlocked");
const names = { ardia: "Ardia", holder: "Holder", plain: "Plain", "1password": "1Password", protonpass: "Proton Pass" };
const delegating = (id, state, via) => ({ id, name: id, state, capabilities: { save: true, passkeysVia: via } });
const SYSTEM = [{ via: "system" }];
const EXTENSION = [{ via: "extension", extensions: ["ghmbeldphafepmbegfdlkpapadhbakde"] }];
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

test("a manager whose passkeys are signed elsewhere is a Save To target when its route works on this request", () => {
  const providers = [ARDIA, delegating("1password", "unlocked", SYSTEM)];
  const result = passkeyTarget(providers, "1password", nameOf, [{ provider: "1password", via: "system" }]);
  assert.deepEqual(result, { targets: ["ardia", "1password"], target: "1password", note: null });
  assert.equal(routeOfTarget("1password", providers, [{ provider: "1password", via: "system" }]), "system");
});

test("a locked plugin still lets its app or extension save, since they unlock themselves", () => {
  const providers = [ARDIA, delegating("protonpass", "locked", EXTENSION)];
  const delegates = [{ provider: "protonpass", via: "extension" }];
  assert.equal(passkeyTarget(providers, "protonpass", nameOf, delegates).target, "protonpass");
  assert.equal(routeOfTarget("protonpass", providers, delegates), "extension");
});

test("when its route doesn't work here, the sheet saves to Ardia without a dead row or a note", () => {
  const result = passkeyTarget([ARDIA, delegating("1password", "unlocked", SYSTEM)], "1password", nameOf, []);
  assert.deepEqual(result, { targets: ["ardia"], target: "ardia", note: null });
});

test("Ardia and holders keep their own routes, and a system row's id names its provider", () => {
  const providers = [ARDIA, provider("holder", "unlocked", true)];
  assert.equal(routeOfTarget("ardia", providers), "ardia");
  assert.equal(routeOfTarget("holder", providers), "holder");
  assert.equal(providerOfSystemRow(systemRowId("1password")), "1password");
  assert.equal(providerOfSystemRow("abc"), null);
});
