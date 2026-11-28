import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { mayBeBang } = await import("./bangs.ts");
const { SETTING_SPECS } = await import("../settings/settings.ts");
const { isConfigSettingKey } = await import("../settings/configAllowlist.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");

const S = () => useBrowser.getState();

test("Bangs is on by default, synced, allowed in config files and reported in the settings snapshot", () => {
  assert.equal(SETTING_SPECS.bangs.default, true);
  assert.equal(SETTING_SPECS.bangs.synced, true);
  assert.ok(isConfigSettingKey("bangs"));
  S().hydrate({});
  assert.equal(settingsSnapshot(S().settings).setting_bangs, "true");
  S().updateSettings({ bangs: false });
  assert.equal(settingsSnapshot(S().settings).setting_bangs, "false");
});

test("with Bangs off, Return on a bang goes to the search engine as typed; on, it waits for the bang list", () => {
  S().hydrate({});
  for (const text of ["!gpt test", "test !gpt", "!w Ada Lovelace"]) assert.equal(mayBeBang(text), true, text);
  S().updateSettings({ bangs: false });
  for (const text of ["!gpt test", "test !gpt", "!w Ada Lovelace"]) assert.equal(mayBeBang(text), false, text);
  S().updateSettings({ bangs: true });
  assert.equal(mayBeBang("?!gpt test"), false);
  assert.equal(mayBeBang("!gpt test"), true);
});
