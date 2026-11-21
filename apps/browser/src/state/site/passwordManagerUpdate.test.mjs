import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { manifestHash } = await import("../plugins/appChecks.ts");

const APPLE_PASSWORDS = JSON.stringify({
  $schema: "https://raw.githubusercontent.com/ardia-browser/ardia/main/docs/plugin.schema.json",
  manifest: 1,
  name: "apple-passwords",
  title: "Apple Passwords",
  description: "Fill logins and verification codes from the Passwords app on every site.",
  version: "1.0.0",
  requires: "0.2.47-nightly.8",
  official: true,
  icon: "key.fill",
  passwordManager: { fill: "system", fields: ["login", "oneTimeCode"], verificationCodeSetup: "system", passkeys: "system" },
});
const FOLDER = { name: "apple-passwords", status: "ok", text: APPLE_PASSWORDS, folderId: "bundled", bundled: true };
const PLUGINS_JSON = JSON.stringify({ version: 1, plugins: { "apple-passwords": { enabled: true, approved: manifestHash(APPLE_PASSWORDS, "bundled"), values: {}, applied: {} } } });
const HELD_OFF_JSON = JSON.stringify({ version: 1, offerToSaveHeldOff: [""] });
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0, passwordManager: "plugin:apple-passwords" };

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const saved = () => ({ plugins: stub.docs.get("plugins.json"), heldOff: stub.docs.get("password-manager.json") });

stub.docs.set("plugins.json", PLUGINS_JSON);
stub.docs.set("password-manager.json", HELD_OFF_JSON);
stub.profileToggles.user.set("", { passwords: false });
stub.pluginHost.folders = [FOLDER];
S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
S().createWindow({ url: "https://a.example/", profileId: "default" });

async function launch(n) {
  const profiles = S().profiles;
  const before = saved();
  let profileChanges = 0;
  const stop = useBrowser.subscribe((s, prev) => void (s.profiles !== prev.profiles && profileChanges++));
  const { startPlugins } = await import(`../plugins/start.ts?launch=${n}`);
  const lifecycle = await import("../plugins/lifecycle.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  startPlugins();
  await lifecycle.rescanPlugins(consentToken());
  const pm = await import(`./passwordManager.ts?launch=${n}`);
  pm.startPasswordManager();
  await settle();
  stop();
  return { pm, profiles, before, profileChanges };
}

for (const n of [1, 2]) {
  test(`launch ${n}: a 0.2.47 profile on Apple Passwords stays on it, untouched, with offer to save still held off`, async () => {
    const { pm, profiles, before, profileChanges } = await launch(n);
    assert.equal(usePlugins.getState().records["apple-passwords"]?.enabled, true, "the enabled record is kept");
    assert.ok(usePlugins.getState().listings["apple-passwords"]?.manifest?.passwordManager, "the plugin is a password manager again");
    assert.equal(pm.currentPasswordManager("default"), "plugin:apple-passwords");
    assert.equal(S().profiles, profiles, "the profiles store didn't change");
    assert.equal(profileChanges, 0);
    assert.equal(S().profiles.default.passwordManager, "plugin:apple-passwords");
    assert.deepEqual(saved(), before, "plugins.json and password-manager.json weren't rewritten");
    assert.equal(stub.profileToggles.user.get("")?.passwords, false, "offer to save stays off");
    assert.deepEqual(stub.passwordProviders.calls.filter((c) => c[0] === "setFieldProviders").at(-1)?.slice(2), [[""]], "the key is offered in its fields again");
  });
}
