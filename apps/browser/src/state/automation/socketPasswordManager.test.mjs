import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { choosePasswordManager } = await import("../site/passwordManager.ts");
const { pluginChoice } = await import("../site/passwordManagerChoice.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
setConsentPeriod(true, "socket-password-manager-test");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const P = () => usePlugins.getState();
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

after(() => {
  lifecycle.disablePlugin("password-manager");
  S().updateSettings({ cliControl: false });
});

test("passwords.list and passwords.remove refuse, naming the plugin, when a plugin keeps the profile's passwords", async () => {
  await freshWindow();
  const profile = S().settings.defaultProfileId;
  const { call, ok } = socketClient(281);
  const before = await ok("passwords.list", {});
  assert.ok(Array.isArray(before), "Ardia's own store answers while Ardia is the password manager");

  startPlugins();
  stub.pluginHost.folders = [{ name: "password-manager", status: "ok", text: MANIFEST }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(lifecycle.requestPluginConsent("password-manager"));
  assert.ok(lifecycle.enablePlugin("password-manager", P().consent.hash));
  await settle();
  choosePasswordManager(profile, pluginChoice("password-manager"));
  await settle();
  const title = P().listings["password-manager"].manifest.title;
  takeCliCounts();

  const listed = await call("passwords.list", {});
  assert.equal(listed.error?.code, "password_manager_plugin");
  assert.equal(listed.error.message, `This profile's passwords are kept by ${title}; Ardia's own password store isn't used.`);
  const removed = await call("passwords.remove", { origin: "https://a.example", username: "me" });
  assert.equal(removed.error?.code, "password_manager_plugin");
  assert.equal(takeCliCounts().cli_socket_password_manager_refusals, 2);

  choosePasswordManager(profile, "ardia");
  await settle();
  assert.ok(Array.isArray(await ok("passwords.list", {})), "back on Ardia, the store answers again");
});
