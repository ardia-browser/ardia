import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { manifestHash } = await import("../plugins/appChecks.ts");

const FIXTURE = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const OWN = FIXTURE.replace('"password-manager"', '"apple-passwords"');
const HASH = "d8476938b3d33c28cb5494dd4fe670accce05a3f61b1d458c737a8f43505824e";
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
const profile = (id, passwordManager) => ({ id, name: id, color: "plum", icon: null, createdAt: 0, ...(passwordManager === undefined ? {} : { passwordManager }) });

let launches = 0;
async function launch() {
  const n = ++launches;
  const { startPlugins } = await import(`../plugins/start.ts?launch=${n}`);
  const lifecycle = await import("../plugins/lifecycle.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  startPlugins();
  await lifecycle.rescanPlugins(consentToken());
  const pm = await import(`./passwordManager.ts?launch=${n}`);
  pm.startPasswordManager();
  await settle();
  return { pm, lifecycle, consentToken };
}test("approving your own folder of that name over the bundled record moves the old choices to Ardia first, so the new plugin takes no profile by itself", async () => {
  const record = { enabled: true, approved: HASH, values: {}, applied: {} };
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": record } }));
  usePlugins.setState({ records: { "apple-passwords": record }, listings: {}, order: [], scanned: false });
  stub.pluginHost.folders = [{ name: "apple-passwords", status: "ok", text: OWN, folderId: "1:2" }];
  S().hydrate({ profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  const { lifecycle, pm, consentToken } = await launch();
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords", "nothing moves while the bundled record waits");
  assert.ok(lifecycle.requestPluginConsent("apple-passwords"));
  stub.refusedWrites.on = true;
  try {
    assert.equal(lifecycle.enablePlugin("apple-passwords", P().consent.hash), false);
  } finally {
    stub.refusedWrites.on = false;
  }
  lifecycle.dismissPluginConsent("apple-passwords");
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords", "an approval that couldn't be saved moves nobody, even after later changes");
  assert.equal(S().profiles.work.passwordManager, undefined);
  stub.passwordProviders.calls.length = 0;
  assert.ok(lifecycle.requestPluginConsent("apple-passwords"));
  assert.ok(lifecycle.enablePlugin("apple-passwords", P().consent.hash));
  await settle();
  const pushed = stub.passwordProviders.calls.filter((c) => c[0] === "setFieldProviders").map((c) => c[2]);
  assert.ok(pushed.every((profiles) => !profiles.includes("")), `the new plugin never gets the profile's fields: ${JSON.stringify(pushed)}`);
  assert.equal(P().records["apple-passwords"].approved, manifestHash(OWN, "1:2"));
  assert.equal(S().profiles.default.passwordManager, "ardia");
  assert.equal(S().profiles.work.passwordManager, "ardia");
  assert.equal(pm.currentPasswordManager("default"), "ardia");
});
