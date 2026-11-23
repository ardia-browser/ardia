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
  assert.equal(delegatedLine(off), "They sign in through the Proton Pass extension, which is off or missing.");
});

test("telemetry counts a system route as system, and only a delegated extension's final answers as delegated", () => {
  assert.deepEqual(routeOfDone({ outcome: "used", via: "system:1password" }), { via: "system", delegated: "system" });
  assert.deepEqual(routeOfDone({ outcome: "created", via: PROTON }), { via: "extension:proton", delegated: "extension" });
  assert.deepEqual(routeOfDone({ outcome: "extension", via: PROTON }), { via: "extension:proton", delegated: null });
  assert.deepEqual(routeOfDone({ outcome: "used", via: undefined }), { via: undefined, delegated: null });
});
