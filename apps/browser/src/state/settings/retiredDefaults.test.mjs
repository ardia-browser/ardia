import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { loadSession, SESSION_MIGRATIONS, SESSION_VERSION } = await import("../session/persist.ts");
const { parseSaved, versionedJson } = await import("../../lib/savedDocument.ts");
const { savedDocumentValue } = await import("../session/documentJson.ts");
const { TOOLBAR_SCROLL_DEFAULT_APPLIED: APPLIED, CMD_CLICK_GROUPS_DEFAULT_APPLIED } = await import("./retiredDefaults.ts");
const { DEFAULT_SETTINGS } = await import("./settings.ts");
const { settingsAdapter } = await import("../sync/settingsAdapter.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const KEY = "hideToolbarWhileScrolling";
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const doc = (version, settings, settingsMeta) => ({
  version,
  profiles: { default: PROFILE },
  profileOrder: ["default"],
  settings,
  ...(settingsMeta ? { settingsMeta } : {}),
  windows: [],
  windowOrder: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});
const load = (saved) => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(saved));
  S().hydrate(loadSession());
  return { on: S().settings[KEY], chosen: S().settingsMeta.chosen.includes(KEY), inferred: S().settingsMeta.inferred.includes(KEY) };
};
const pushed = () => settingsAdapter.extract(() => undefined).values.has(`set:${KEY}`);

test("a new install keeps the toolbar while scrolling: hiding it is off by default", () => {
  assert.equal(DEFAULT_SETTINGS[KEY], false);
  stub.docs.clear();
  S().hydrate({});
  assert.equal(S().settings[KEY], false);
});

test("a saved on the user never touched turns off and stays unchosen, so sync doesn't publish it", () => {
  const saved = { ...DEFAULT_SETTINGS, [KEY]: true, tabLayout: "top" };
  assert.deepEqual(load(doc(SESSION_VERSION, saved, { chosen: ["tabLayout"], inferred: [] })), { on: false, chosen: false, inferred: false });
  assert.equal(S().settings.tabLayout, "top");
  assert.equal(pushed(), false);
});

test("an on from before Ardia tracked choices (every key chosen and inferred) turns off", () => {
  assert.deepEqual(load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY, "tabLayout"], inferred: [KEY, "tabLayout"] })), { on: false, chosen: false, inferred: false });
  assert.deepEqual(S().settingsMeta, { chosen: ["tabLayout"], inferred: ["tabLayout", APPLIED, CMD_CLICK_GROUPS_DEFAULT_APPLIED] });
  assert.equal(load(doc(6, { ...DEFAULT_SETTINGS, [KEY]: true })).on, false);
});

test("an on the user chose stays on and still syncs", () => {
  assert.deepEqual(load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY], inferred: [] })), { on: true, chosen: true, inferred: false });
  assert.equal(pushed(), true);
});

test("an off the user chose stays off", () => {
  assert.deepEqual(load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: false }, { chosen: [KEY], inferred: [] })), { on: false, chosen: true, inferred: false });
});

const reload = () => {
  stub.docs.set("session.json", versionedJson(savedDocumentValue("session.json", S()), SESSION_VERSION));
  S().hydrate(loadSession());
  return S().settings[KEY];
};

test("the flip runs once per install: an on that sync applies afterwards survives a relaunch with sync off", () => {
  load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [] }));
  assert.equal(S().settings[KEY], false);
  assert.ok(S().settingsMeta.inferred.includes(APPLIED));
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: true }]]), [`set:${KEY}`]);
  assert.equal(S().settingsMeta.chosen.includes(KEY), false);
  assert.equal(reload(), true);
  assert.equal(reload(), true);
});

test("0.2.47 keeps the marker (it saves settingsMeta lists as they are), so a rollback and return doesn't flip again", () => {
  load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: false }, { chosen: [], inferred: [] }));
  const saved = JSON.parse(versionedJson(savedDocumentValue("session.json", S()), SESSION_VERSION));
  const writtenBy0247 = { ...saved, settings: { ...saved.settings, [KEY]: true } };
  assert.ok(writtenBy0247.settingsMeta.inferred.includes(APPLIED));
  assert.equal(load(writtenBy0247).on, true);
});

test("a fresh install is marked too, so a later synced on is never flipped", () => {
  stub.docs.clear();
  S().hydrate({});
  assert.ok(S().settingsMeta.inferred.includes(APPLIED));
});

test("0.2.47 (session version 11, which refuses a newer file) still opens what this build saves", () => {
  assert.equal(SESSION_VERSION, 11);
  load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY], inferred: [] }));
  const saved = versionedJson(savedDocumentValue("session.json", S()), SESSION_VERSION);
  assert.notEqual(parseSaved(saved, 11, SESSION_MIGRATIONS), null);
  assert.equal(parseSaved(versionedJson({ tabs: [] }, 12), 11, SESSION_MIGRATIONS), null);
});

test("an on chosen on another Mac still applies here, since the unchosen local value never wins", () => {
  load(doc(SESSION_VERSION, { ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [] }));
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: true }]]), [`set:${KEY}`]);
  assert.equal(S().settings[KEY], true);
});
