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
}

test("a failed first scan leaves the migration for the next scan that works", async () => {
  const record = { enabled: true, approved: HASH, values: {}, applied: {} };
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": record } }));
  usePlugins.setState({ records: { "apple-passwords": record }, listings: {}, order: [], scanned: false });
  stub.pluginHost.folders = [];
  S().hydrate({ profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  stub.pluginHost.listFails = true;
  let lifecycle, consentToken;
  try {
    ({ lifecycle, consentToken } = await launch());
  } finally {
    stub.pluginHost.listFails = false;
  }
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords");
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().records["apple-passwords"], undefined);
  assert.equal(S().profiles.default.passwordManager, "ardia");
  assert.equal(S().profiles.work.passwordManager, "ardia", "the dropped record was on, so the unset profile is stamped too");
});
