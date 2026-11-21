import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { loadSession, SESSION_VERSION } = await import("../session/persist.ts");
const { DEFAULT_SETTINGS, parseSettings, parseSettingsMeta } = await import("./settings.ts");
const { isConfigSettingKey } = await import("./configAllowlist.ts");
const { settingsAdapter, SYNCED_SETTINGS } = await import("../sync/settingsAdapter.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { siteSwitchValue } = await import("../plugins/siteSwitches.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const RETIRED = "developerModeSites";
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const session = (settings, settingsMeta) => ({
  version: SESSION_VERSION,
  profiles: { default: PROFILE },
  profileOrder: ["default"],
  settings,
  settingsMeta,
  windows: [],
  windowOrder: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});

test("Developer Mode's site list is no longer a setting, a synced setting or a config key", () => {
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS, RETIRED), false);
  assert.equal(SYNCED_SETTINGS.includes(RETIRED), false);
  assert.equal(isConfigSettingKey(RETIRED), false);
  assert.equal(Object.hasOwn(parseSettings({ [RETIRED]: { localhost: true }, showFullUrl: true }), RETIRED), false);
  assert.equal(parseSettings({ [RETIRED]: { localhost: true }, showFullUrl: true }).showFullUrl, true);
});

test("a saved session drops the old site list and its chosen and inferred marks, and keeps the rest", () => {
  stub.docs.clear();
  stub.docs.set(
    "session.json",
    JSON.stringify(session({ [RETIRED]: { localhost: true, "example.com": true }, showFullUrl: true }, { chosen: [RETIRED, "showFullUrl"], inferred: [RETIRED] })),
  );
  S().hydrate(loadSession());
  assert.equal(Object.hasOwn(S().settings, RETIRED), false);
  assert.equal(S().settings.showFullUrl, true);
  assert.deepEqual(S().settingsMeta, { chosen: ["showFullUrl"], inferred: [] });
  assert.deepEqual(parseSettingsMeta({ chosen: [RETIRED, "notASetting", "showFullUrl"], inferred: "x" }), { chosen: ["showFullUrl"], inferred: [] });
});

test("an older Mac's synced site list arriving after the update changes no setting and turns on no plugin site switch", () => {
  stub.docs.clear();
  S().hydrate({});
  S().updateSettings({ showFullUrl: true });
  const settings = S().settings;
  const settingsMeta = S().settingsMeta;
  const records = usePlugins.getState().records;
  const key = `set:${RETIRED}`;
  settingsAdapter.apply(new Map([[key, { v: { localhost: true, "127.0.0.1": true, "example.com": true } }]]), [key]);
  assert.equal(S().settings, settings);
  assert.equal(S().settingsMeta, settingsMeta);
  assert.equal(usePlugins.getState().records, records);
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "https://example.com"]) {
    assert.equal(siteSwitchValue(usePlugins.getState(), "developer-mode", "on", origin), undefined, origin);
  }
});

test("this Mac publishes nothing for the old key, not even a deletion, so an older Mac keeps its own list", () => {
  stub.docs.clear();
  S().hydrate({});
  S().updateSettings({ showFullUrl: true });
  const key = `set:${RETIRED}`;
  const extraction = settingsAdapter.extract((k) => (k === key ? { v: { localhost: true } } : undefined));
  assert.equal(extraction.values.has(key), false);
  assert.equal(extraction.ignore(key), true);
  assert.ok(extraction.values.has("set:showFullUrl"));
});
