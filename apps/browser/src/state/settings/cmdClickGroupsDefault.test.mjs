import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { loadSession, SESSION_VERSION } = await import("../session/persist.ts");
const { versionedJson } = await import("../../lib/savedDocument.ts");
const { savedDocumentValue } = await import("../session/documentJson.ts");
const { CMD_CLICK_GROUPS_DEFAULT_APPLIED: APPLIED, TOOLBAR_SCROLL_DEFAULT_APPLIED } = await import("./retiredDefaults.ts");
const { DEFAULT_SETTINGS } = await import("./settings.ts");
const { settingsAdapter, settleSettingsFromSavedSync } = await import("../sync/settingsAdapter.ts");
const { PRESETS } = await import("../onboarding/presets.ts");
const { search } = await import("../../components/settings/searchMatch.ts");
const { findSetting, SETTINGS_INDEX } = await import("../../components/settings/settingsIndex.ts");
const { flushPersistence, startPersistence } = await import("../session/persist.ts");
const onboarding = await import("../onboarding/onboarding.ts");
const { questionKeys } = await import("../onboarding/questions.ts");
const { tabLayoutOf } = await import("../browser/model.ts");
const { usePlugins } = await import("../plugins/store.ts");
const stub = await import("../../test-native/index.ts");

usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const KEY = "cmdClickCreatesTabGroup";
const ROW = `shortcuts.${KEY}`;
const PROFILE = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const doc = (settings, settingsMeta) => ({
  version: SESSION_VERSION,
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
const reload = () => {
  stub.docs.set("session.json", versionedJson(savedDocumentValue("session.json", S()), SESSION_VERSION));
  S().hydrate(loadSession());
  return S().settings[KEY];
};

test("a new install doesn't group ⌘-clicked links: the setting is off by default and the fresh install is marked", () => {
  assert.equal(DEFAULT_SETTINGS[KEY], false);
  stub.docs.clear();
  S().hydrate({});
  assert.equal(S().settings[KEY], false);
  assert.ok(S().settingsMeta.inferred.includes(APPLIED));
});

test("no onboarding preset turns it on, and the Dia preset leaves it to the default instead of writing an off", () => {
  assert.equal(KEY in PRESETS.dia, false);
  for (const preset of Object.values(PRESETS)) assert.notEqual(preset[KEY], true);
});

test("the old default on that the user never touched turns off and stays unchosen, so sync doesn't publish it", () => {
  const saved = { ...DEFAULT_SETTINGS, [KEY]: true, tabLayout: "top" };
  assert.deepEqual(load(doc(saved, { chosen: ["tabLayout"], inferred: [] })), { on: false, chosen: false, inferred: false });
  assert.equal(S().settings.tabLayout, "top");
  assert.equal(pushed(), false);
});

test("an on filled in before Ardia tracked choices (chosen and inferred) turns off; a session with no meta turns off", () => {
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY, "tabLayout"], inferred: [KEY, "tabLayout"] })), { on: false, chosen: false, inferred: false });
  assert.deepEqual(S().settingsMeta, { chosen: ["tabLayout"], inferred: ["tabLayout", TOOLBAR_SCROLL_DEFAULT_APPLIED, APPLIED, "tabSwitcherOrder:fromShortcuts"] });
  assert.equal(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true })).on, false);
});

test("an on the user turned on by hand stays on and still syncs", () => {
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY], inferred: [] })), { on: true, chosen: true, inferred: false });
  assert.equal(pushed(), true);
  assert.equal(reload(), true);
});

test("an off the user chose stays off and chosen", () => {
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: false }, { chosen: [KEY], inferred: [] })), { on: false, chosen: true, inferred: false });
});

test("the flip runs once per install: an on turned on later survives relaunches", () => {
  load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [] }));
  assert.equal(S().settings[KEY], false);
  S().updateSettings({ [KEY]: true });
  assert.equal(reload(), true);
  assert.equal(reload(), true);
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: true }]]), [`set:${KEY}`]);
  assert.equal(reload(), true);
});

test("an on chosen on another Mac still applies here after the flip", () => {
  load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [] }));
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: true }]]), [`set:${KEY}`]);
  assert.equal(S().settings[KEY], true);
});

test("the settings row explains itself and turns up for tab-group and grouping searches", () => {
  const row = findSetting(ROW);
  assert.ok(row.explained && row.description?.includes("tab group"));
  for (const query of ["cmd click", "ctrl click", "tab group", "auto group", "grouping", "nested tabs"]) {
    assert.ok(search(SETTINGS_INDEX, query).some((h) => h.entry.id === ROW), query);
  }
});

test("a true the old onboarding saved as chosen (the Dia prefill or a click, saved state can't tell them apart) is an explicit choice and stays on", () => {
  stub.docs.set("onboarding.json", JSON.stringify({ version: 1, completedAt: 1, source: "dia", preset: "dia", picked: { tabsMore: [] } }));
  assert.deepEqual(load(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY, "tabLayout", "peekModifier"], inferred: [] })), { on: true, chosen: true, inferred: false });
  assert.equal(pushed(), true);
  stub.docs.delete("onboarding.json");
});

const O = () => onboarding.useOnboarding.getState();
const TABS_MORE = questionKeys("tabsMore");
const tabsMoreValues = () => onboarding.resolveDraft(TABS_MORE, O().draft, onboarding.draftPreset(O()), { ...S().settings, tabLayout: tabLayoutOf(S(), O().windowId) }, S().settingsMeta.chosen);
const redoAsDia = (on) => {
  stub.docs.clear();
  S().hydrate({});
  stub.docs.set("onboarding.json", JSON.stringify({ version: 1, completedAt: 1, source: "chrome", preset: "chrome" }));
  const id = S().createWindow();
  settingsAdapter.apply(new Map([[`set:${KEY}`, { v: on }]]), [`set:${KEY}`]);
  assert.equal(S().settings[KEY], on);
  assert.equal(onboarding.redoOnboarding(id), id);
  onboarding.chooseSource("dia");
  onboarding.confirmAnswer("source", onboarding.sourcePatch(), ["Coming from Dia"]);
  assert.ok(onboarding.questionsFor("tabs").some((q) => q.id === "tabsMore"), "coming from Dia asks about the tab habits it no longer answers");
};
const settleOnboarding = () => {
  onboarding.cancelOnboarding();
  onboarding.useOnboarding.setState({ windowId: null, leaving: false, redo: false });
  stub.docs.delete("onboarding.json");
};

test("redoing onboarding as Dia on a Mac where sync turned grouping on keeps it on and publishes nothing for it", () => {
  redoAsDia(true);
  assert.equal(tabsMoreValues()[KEY], true, "the checkbox shows the setting as it is");
  onboarding.confirmAnswer("tabsMore", onboarding.touchedOrPresetPatch(TABS_MORE, tabsMoreValues()), []);
  assert.deepEqual({ on: S().settings[KEY], chosen: S().settingsMeta.chosen.includes(KEY) }, { on: true, chosen: false });
  assert.equal(pushed(), false);
  settleOnboarding();
});

test("unticking the box while redoing onboarding as Dia is a choice: it turns off and syncs", () => {
  redoAsDia(true);
  onboarding.setOnboardingDraft({ [KEY]: false });
  onboarding.confirmAnswer("tabsMore", onboarding.touchedOrPresetPatch(TABS_MORE, tabsMoreValues()), []);
  assert.deepEqual({ on: S().settings[KEY], chosen: S().settingsMeta.chosen.includes(KEY) }, { on: false, chosen: true });
  assert.equal(pushed(), true);
  settleOnboarding();
});

const launchWith = async (saved, overrides) => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(saved));
  const before = stub.docs.get("session.json");
  const stop = startPersistence(overrides);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushPersistence();
  stop();
  const after = stub.docs.get("session.json");
  return { written: after !== before, saved: JSON.parse(after) };
};

test("a launch that retires the old on writes the session even when nothing else changed, so the off and its marker reach disk", async () => {
  const { written, saved } = await launchWith(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [TOOLBAR_SCROLL_DEFAULT_APPLIED] }));
  assert.equal(written, true);
  assert.ok(saved.settingsMeta.inferred.includes(APPLIED));
  assert.notEqual(saved.settings[KEY], true);
});

test("a launch that only marks the flip, with no on to retire, leaves the write to the next real change", async () => {
  const { written } = await launchWith(doc({ ...DEFAULT_SETTINGS, [KEY]: false }, { chosen: [], inferred: [TOOLBAR_SCROLL_DEFAULT_APPLIED] }));
  assert.equal(written, false);
});

test("a launch with every default already retired doesn't rewrite the session", async () => {
  const { written } = await launchWith(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [KEY], inferred: [TOOLBAR_SCROLL_DEFAULT_APPLIED, APPLIED] }));
  assert.equal(written, false);
});

test("a launch that waits for locked Settings sync keeps the saved on and writes no marker yet", async () => {
  const { written } = await launchWith(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [TOOLBAR_SCROLL_DEFAULT_APPLIED] }), { retiredDefaultsWaitForSync: true });
  assert.equal(written, false);
  assert.deepEqual({ on: S().settings[KEY], retired: S().settingsMeta.inferred.includes(APPLIED) }, { on: true, retired: false });
});

const launchThenUnlock = async (records) => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(doc({ ...DEFAULT_SETTINGS, [KEY]: true }, { chosen: [], inferred: [TOOLBAR_SCROLL_DEFAULT_APPLIED] })));
  const stop = startPersistence({ retiredDefaultsWaitForSync: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushPersistence();
  const waiting = stub.docs.get("session.json");
  settleSettingsFromSavedSync({ records, unapplied: [] }, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushPersistence();
  stop();
  return { waiting: JSON.parse(waiting), saved: JSON.parse(stub.docs.get("session.json")) };
};

test("when locked sync unlocks with no say on grouping, the on retires and the off and its marker are written", async () => {
  const { waiting, saved } = await launchThenUnlock({});
  assert.equal(waiting.settingsMeta.inferred.includes(APPLIED), false);
  assert.ok(saved.settingsMeta.inferred.includes(APPLIED));
  assert.notEqual(saved.settings[KEY], true);
});

test("when locked sync unlocks holding a synced on, the on stays and only its marker is written", async () => {
  const { saved } = await launchThenUnlock({ [`set:${KEY}`]: { v: { v: true } } });
  assert.ok(saved.settingsMeta.inferred.includes(APPLIED));
  assert.equal(saved.settings[KEY], true);
  assert.equal(saved.settingsMeta.chosen.includes(KEY), false);
});
