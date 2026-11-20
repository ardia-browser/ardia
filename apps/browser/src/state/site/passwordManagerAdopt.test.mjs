import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins, recordOf } = await import("../plugins/store.ts");
const { confirmConsentAs, presentSettingsConsent } = await import("../plugins/consentSurface.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const pm = await import("./passwordManager.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const folder = (name) => ({ name, status: "ok", bundled: true, text: MANIFEST.replace('"password-manager"', JSON.stringify(name)) });

let work = "";
let stop = () => {};

async function askToTurnOn(name) {
  stub.pluginHost.folders = [folder("system-passwords"), folder("more-passwords")];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(lifecycle.requestPluginConsent(name));
  return P().consent.id;
}

test("turning on a built-in password manager while never-chosen profiles are on Ardia asks for the owner, and a refusal keeps them on Ardia", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  work = S().createProfile({ name: "Work" });
  S().updateProfile(work, { passwordManager: "none" });
  startPlugins();
  pm.startPasswordManager();
  stop = presentSettingsConsent();
  const id = await askToTurnOn("system-passwords");
  stub.passwordsUnlock.answer = false;
  assert.equal(confirmConsentAs("settings", id), false, "the plugin waits for the owner check");
  await settle();
  assert.equal(recordOf(P(), "system-passwords").enabled, true, "the plugin still turns on");
  assert.equal(S().profiles.default.passwordManager, "ardia", "the never-chosen profile is kept on Ardia explicitly");
  assert.equal(S().profiles[work].passwordManager, "none", "an explicit choice is untouched");
});

test("with the owner confirmed, never-chosen profiles move to the built-in plugin as before", async () => {
  assert.ok(lifecycle.disablePlugin("system-passwords", consentToken()));
  const fresh = S().createProfile({ name: "Fresh" });
  assert.equal(pm.currentPasswordManager(fresh), "ardia");
  const id = await askToTurnOn("more-passwords");
  stub.passwordsUnlock.answer = true;
  confirmConsentAs("settings", id);
  await settle();
  assert.equal(recordOf(P(), "more-passwords").enabled, true);
  assert.equal(S().profiles[fresh].passwordManager, "plugin:more-passwords");
  assert.equal(S().profiles.default.passwordManager, "ardia");
  stop();
});
