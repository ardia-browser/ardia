import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-removal-test");

const FIXTURE = readFileSync(new URL("../../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8");
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const native = shellNativeModules.ArdiaPlugins;
const unlink = native.unlinkPrograms;
after(() => {
  native.unlinkPrograms = unlink;
  lifecycle.disablePlugin("example");
});

test("plugins.remove re-checks control after unlinking programs and keeps the files once it's off", async () => {
  useBrowser.getState().hydrate({});
  startPlugins();
  host.removed.length = 0;
  host.folders = [{ name: "example", status: "ok", text: FIXTURE }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("example"));
  assert.ok(lifecycle.enablePlugin("example", P().consent.hash));
  lifecycle.dismissPluginConsent();
  let on = true;
  native.unlinkPrograms = async (name, programs, remove) => {
    const answer = await unlink(name, programs, remove);
    if (remove) on = false;
    return answer;
  };
  const outcome = await lifecycle.removePlugin("example", () => on);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /Control was turned off/);
  assert.deepEqual(host.removed, [], "its files are still there");
});
