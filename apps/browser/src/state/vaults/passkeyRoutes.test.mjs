import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { delegatedLine, delegatedManagers, systemRouteOf, systemSources } = await import("./passkeyRoutes.ts");
const { routeOfDone } = await import("./passkeys.ts");

const PROTON = "ghmbeldphafepmbegfdlkpapadhbakde";
const manager = (id, name, state, passkeysVia) => ({ id, name, state, capabilities: { save: true, passkeysVia } });
const onePassword = (state = "unlocked") => manager("1password", "1Password", state, [{ via: "system" }]);
const proton = (state = "locked") => manager("protonpass", "Proton Pass", state, [{ via: "extension", extensions: [PROTON] }, { via: "system" }]);

test("macOS's answer reads as available, needing the signed release, or turned off", () => {
  assert.equal(systemRouteOf({ entitled: false, status: "entitlementRequired" }), "needsRelease");
  assert.equal(systemRouteOf({ entitled: true, status: "denied" }), "denied");
  assert.equal(systemRouteOf({ entitled: true, status: "notDetermined" }), "available");
});

test("a signed-in manager's passkeys use its first route that works, and only a working system route is a Use passkeys from choice", () => {
  const extensions = [{ id: PROTON, name: "Proton Pass", icon: "" }];
  const ready = delegatedManagers([onePassword(), proton()], "available", extensions);
  assert.deepEqual(ready.map((m) => [m.id, m.via, m.status]), [["1password", "system", "ready"], ["protonpass", "extension", "ready"]]);
  assert.deepEqual(systemSources(ready).map((m) => m.id), ["1password"]);
  assert.deepEqual(delegatedManagers([proton()], "available", []).map((m) => [m.via, m.status]), [["system", "ready"]], "Proton falls to its next route");
  assert.deepEqual(delegatedManagers([onePassword("signedOut")], "available", []), []);
});

test("when no route works, Settings says why in one line and the sheets offer nothing", () => {
  const [release] = delegatedManagers([onePassword()], "needsRelease", []);
  assert.equal(release.status, "needsRelease");
  assert.match(delegatedLine(release), /signed release/);
  assert.deepEqual(systemSources([release]), []);
  const [denied] = delegatedManagers([onePassword()], "denied", []);
  assert.match(delegatedLine(denied), /Passkeys Access for Web Browsers/);
  const [off] = delegatedManagers([manager("protonpass", "Proton Pass", "unlocked", [{ via: "extension", extensions: [PROTON] }])], "available", []);
  assert.equal(delegatedLine(off), "They need the Proton Pass extension, which is off or not installed.");
});

test("telemetry counts a system route as system, and only a delegated extension's final answers as delegated", () => {
  assert.deepEqual(routeOfDone({ outcome: "used", via: "system:1password" }), { via: "system", delegated: "system" });
  assert.deepEqual(routeOfDone({ outcome: "created", via: PROTON }), { via: "extension:proton", delegated: "extension" });
  assert.deepEqual(routeOfDone({ outcome: "extension", via: PROTON }), { via: "extension:proton", delegated: null });
  assert.deepEqual(routeOfDone({ outcome: "used", via: undefined }), { via: undefined, delegated: null });
});

test("an autofill offer with the system route adds one 1Password row to the fill menu, which skips Touch ID and names who answers", async () => {
  const { passkeyItemsOf } = await import("./passkeyStore.ts");
  const { loginLines } = await import("../../components/vaults/rowText.ts");
  const { isTouchRow } = await import("./touchID.ts");
  const offer = {
    tabId: "t1", requestId: "r1", kind: "get", conditional: true, origin: "https://github.com", rpId: "github.com", system: true, private: false,
    passkeys: [{ id: "a1", provider: "ardia", rpId: "github.com", userName: "sam", displayName: "" }],
    delegates: [{ provider: "1password", via: "system" }, { provider: "protonpass", via: "extension" }],
  };
  const items = passkeyItemsOf(offer);
  assert.deepEqual(items.map((i) => i.passkey.credentialId), ["a1", "delegate:1password"]);
  const row = items[1];
  assert.deepEqual(row.passkey, { requestId: "r1", credentialId: "delegate:1password", delegated: true, system: true });
  const { brandOf } = await import("./brands.ts");
  assert.deepEqual(loginLines(row, "github.com"), { title: `Passkey from ${brandOf("1password").name}…`, detail: "github.com" });
  assert.equal(isTouchRow({ key: "k", kind: "login", item: row, userChose: false }), false);
  assert.equal(isTouchRow({ key: "k", kind: "login", item: items[0], userChose: false }), true);
  assert.deepEqual(passkeyItemsOf({ ...offer, delegates: [{ provider: "protonpass", via: "extension" }] }).map((i) => i.passkey.credentialId), ["a1"]);
});
