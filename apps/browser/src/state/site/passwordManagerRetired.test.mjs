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

test("a fresh install writes nothing and changes no profile at launch", async () => {
  stub.pluginHost.folders = [];
  S().hydrate({ profiles: { default: profile("default", undefined), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  const profiles = S().profiles;
  let changes = 0;
  const stop = useBrowser.subscribe((s, prev) => void (s.profiles !== prev.profiles && changes++));
  await launch();
  stop();
  assert.equal(S().profiles, profiles);
  assert.equal(changes, 0);
  assert.equal(stub.docs.has("plugins.json"), false);
  assert.equal(stub.docs.has("password-manager.json"), false);
});

test("a plugin of that name you installed yourself keeps its record and its profiles", async () => {
  stub.pluginHost.folders = [{ name: "apple-passwords", status: "ok", text: OWN, folderId: "1:2" }];
  const record = { enabled: true, approved: manifestHash(OWN, "1:2"), values: {}, applied: {} };
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": record } }));
  usePlugins.setState({ records: { "apple-passwords": record } });
  S().hydrate({ profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  const { pm, lifecycle, consentToken } = await launch();
  await lifecycle.rescanPlugins(consentToken());
  assert.deepEqual(P().records["apple-passwords"], record);
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords");
  assert.equal(S().profiles.work.passwordManager, undefined);
  assert.equal(pm.currentPasswordManager("default"), "plugin:apple-passwords");
});

test("a scan that fails stamps nothing and drops nothing, so a plugin of that name you installed keeps its profiles", async () => {
  const record = { enabled: true, approved: manifestHash(OWN, "1:2"), values: {}, applied: {} };
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": record } }));
  usePlugins.setState({ records: { "apple-passwords": record }, listings: {}, order: [], scanned: false });
  S().hydrate({ profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  stub.pluginHost.listFails = true;
  try {
    await launch();
  } finally {
    stub.pluginHost.listFails = false;
  }
  assert.equal(P().scanned, true);
  assert.deepEqual(P().records["apple-passwords"], record);
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords");
  assert.equal(S().profiles.work.passwordManager, undefined);
});

test("a record of that name Ardia didn't bundle survives a listing that comes back empty, and a removed plugin of that name keeps its profiles' choice", async () => {
  const own = { enabled: true, approved: manifestHash(OWN, "1:2"), values: {}, applied: {} };
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": own } }));
  usePlugins.setState({ records: { "apple-passwords": own }, listings: {}, order: [], scanned: false });
  stub.pluginHost.folders = [];
  S().hydrate({ profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  await launch();
  assert.deepEqual(P().records["apple-passwords"], own, "an empty listing, as a folder read error gives, never drops a record you approved yourself");
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords");
  assert.equal(S().profiles.work.passwordManager, undefined);

  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
  usePlugins.setState({ records: {}, listings: {}, order: [], scanned: false });
  await launch();
  assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords", "with no bundled record dropped this launch, nothing is stamped");
});

test("a disabled Apple Passwords record is dropped and leaves unset profiles alone; an explicit choice still reads Ardia", async () => {
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { "apple-passwords": { enabled: false, approved: HASH, values: {}, applied: {} } } }));
  usePlugins.setState({ records: JSON.parse(stub.docs.get("plugins.json")).plugins });
  S().hydrate({ profiles: { default: profile("default", "plugin:apple-passwords"), work: profile("work", undefined) }, profileOrder: ["default", "work"] });
  const { lifecycle, consentToken } = await launch();
  await lifecycle.rescanPlugins(consentToken());
  assert.equal(P().records["apple-passwords"], undefined);
  assert.equal(S().profiles.default.passwordManager, "ardia");
  assert.equal(S().profiles.work.passwordManager, undefined, "a rollback couldn't pick a plugin that was off, so there's nothing to stamp");
});
