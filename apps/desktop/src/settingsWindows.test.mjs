import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "../../browser/src/state/settings/settingsWindows.ts";
import { windows } from "../../browser/src/test-native/index.ts";
import * as linux from "./settingsWindows.ts";
import { setSessionFlush } from "./session.ts";

test("Linux Settings shares navigation actions and opens the requested native utility only after saving", async () => {
  assert.equal(linux.useSettingsNav, shared.useSettingsNav);
  assert.equal(linux.goToSettingsPane, shared.goToSettingsPane);
  windows.open.clear();
  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, scroll: 0, visit: 1, back: [], forward: [] });
  let saved;
  setSessionFlush(() => new Promise((resolve) => { saved = resolve; }));

  assert.equal(linux.openSettings("profiles", "work"), undefined);
  assert.equal(windows.open.has("settings"), false);
  assert.equal(shared.useSettingsNav.getState().pane, "profiles");
  assert.equal(shared.useSettingsNav.getState().profileId, "work");
  saved();
  await new Promise(setImmediate);
  assert.deepEqual(windows.open.get("settings"), {
    kind: "settings",
    title: "Settings",
    settings: { pane: "profiles", profileId: "work", detail: null },
  });
  assert.deepEqual(shared.useSettingsNav.getState().back, [{ pane: "general", profileId: null, detail: null, scroll: 0, visit: 1, shownProfile: null }]);

  linux.settingsBack();
  assert.equal(shared.useSettingsNav.getState().pane, "general");
  linux.settingsForward();
  assert.equal(shared.useSettingsNav.getState().pane, "profiles");
});

test("Linux Import retains its consume-once source and waits for the session save before native opening", async () => {
  windows.open.clear();
  linux.setPreferredImportSource("firefox");
  assert.equal(linux.takePreferredImportSource(), "firefox");
  assert.equal(linux.takePreferredImportSource(), null);
  let saved;
  setSessionFlush(() => new Promise((resolve) => { saved = resolve; }));
  assert.equal(linux.openImport("chromium"), undefined);
  assert.equal(windows.open.has("import"), false);
  saved();
  await new Promise(setImmediate);
  assert.deepEqual(windows.open.get("import"), {
    kind: "import",
    title: "Import from Another Browser",
    importSource: "chromium",
  });
});

test("Manage Extensions on Linux and Windows carries the Extensions row to the Settings window, which reveals it there; a detail page still opens on Linux", async () => {
  const { useSettingsSearch, setSettingsQuery } = await import("../../browser/src/state/settings/searchState.ts");
  const { navigateUtility } = await import("./utilityPlace.ts");
  windows.open.clear();
  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  setSessionFlush(() => Promise.resolve());
  linux.openSettings("profiles", "work", null, "profiles.extensions");
  await new Promise(setImmediate);
  const request = windows.open.get("settings");
  const { revealId, revealConsent, ...settings } = request.settings;
  assert.deepEqual(settings, { pane: "profiles", profileId: "work", detail: null, reveal: "profiles.extensions" });
  assert.match(revealId, /^[0-9a-f-]{36}$/);
  assert.equal(revealConsent, null);

  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  setSettingsQuery("cookies");
  useSettingsSearch.setState({ reveal: null });
  navigateUtility(JSON.parse(JSON.stringify(request.settings)));
  const nav = shared.useSettingsNav.getState();
  assert.deepEqual([nav.pane, nav.profileId, nav.detail], ["profiles", "work", null]);
  assert.equal(useSettingsSearch.getState().reveal?.id, "profiles.extensions");
  assert.equal(useSettingsSearch.getState().query, "");

  useSettingsSearch.setState({ reveal: null });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: "general.importBrowser", revealId: "other-pane" });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: "profiles.nope", revealId: "unknown-row" });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: 7, revealId: "not-a-string" });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: "profiles.extensions" });
  assert.equal(useSettingsSearch.getState().reveal, null, "a row from another pane, an unknown row, a non-string or a request without an id is ignored");

  linux.openSettings("profiles", "work", "site:https://example.com");
  await new Promise(setImmediate);
  assert.deepEqual(windows.open.get("settings").settings, { pane: "profiles", profileId: "work", detail: "site:https://example.com" });
});

test("a second Settings renderer started from the host's cached payload doesn't replay a reveal the first one already showed", async () => {
  const stored = new Map();
  globalThis.sessionStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, String(value)) };
  const { useSettingsSearch } = await import("../../browser/src/state/settings/searchState.ts");
  windows.open.clear();
  setSessionFlush(() => Promise.resolve());
  linux.openSettings("profiles", "work", null, "profiles.extensions");
  await new Promise(setImmediate);
  const payload = JSON.parse(JSON.stringify(windows.open.get("settings").settings));
  assert.equal(typeof payload.revealId, "string");

  const first = await import("./utilityPlace.ts?renderer=first");
  useSettingsSearch.setState({ reveal: null });
  first.navigateUtility(payload);
  assert.equal(useSettingsSearch.getState().reveal?.id, "profiles.extensions");
  useSettingsSearch.setState({ reveal: null });
  first.navigateUtility(payload);
  assert.equal(useSettingsSearch.getState().reveal, null, "the ready reply repeats the bootstrap payload: shown once");

  const second = await import("./utilityPlace.ts?renderer=second");
  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  second.navigateUtility(payload);
  const nav = shared.useSettingsNav.getState();
  assert.deepEqual([nav.pane, nav.profileId], ["profiles", "work"], "the destination is still restored");
  assert.equal(useSettingsSearch.getState().reveal, null, "the consumed reveal isn't replayed");

  linux.openSettings("profiles", "work", null, "profiles.extensions");
  await new Promise(setImmediate);
  second.navigateUtility(JSON.parse(JSON.stringify(windows.open.get("settings").settings)));
  assert.equal(useSettingsSearch.getState().reveal?.id, "profiles.extensions", "a new Manage Extensions request still reveals");
  delete globalThis.sessionStorage;
});

test("in-memory reveal deduplication still holds when readable sessionStorage rejects writes", async (t) => {
  const { useSettingsSearch } = await import("../../browser/src/state/settings/searchState.ts");
  globalThis.sessionStorage = {
    getItem: () => JSON.stringify(["older-reveal"]),
    setItem: () => { throw new Error("quota exceeded"); },
  };
  t.after(() => { delete globalThis.sessionStorage; });
  const renderer = await import("./utilityPlace.ts?renderer=readonly-storage");
  const payload = { pane: "profiles", profileId: "work", detail: null, reveal: "profiles.extensions", revealId: "unwritable-storage-reveal" };
  useSettingsSearch.setState({ reveal: null });
  renderer.navigateUtility(payload);
  assert.equal(useSettingsSearch.getState().reveal?.id, "profiles.extensions");
  useSettingsSearch.setState({ reveal: null });
  renderer.navigateUtility(payload);
  assert.equal(useSettingsSearch.getState().reveal, null);
});

test("Manage Extensions captures consent before the async session flush and never renews it after opting in", async (t) => {
  const { useSettingsSearch } = await import("../../browser/src/state/settings/searchState.ts");
  const { setConsentPeriod, consentToken } = await import("../../browser/src/state/telemetry/consentPeriod.ts");
  const { navigateUtility } = await import("./utilityPlace.ts");
  setConsentPeriod(false, null);
  t.after(() => setConsentPeriod(false, null));
  windows.open.clear();
  let saved;
  setSessionFlush(() => new Promise((resolve) => { saved = resolve; }));
  linux.openSettings("profiles", "work", null, "profiles.extensions");
  setConsentPeriod(true, "epoch-after-click");
  saved();
  await new Promise(setImmediate);
  const payload = JSON.parse(JSON.stringify(windows.open.get("settings").settings));
  assert.equal(payload.revealConsent, null);
  useSettingsSearch.setState({ reveal: null });
  navigateUtility(payload);
  assert.equal(useSettingsSearch.getState().reveal?.consent, null, "request made while sharing was off keeps null consent even after opt-in");
  assert.equal(consentToken(), "epoch-after-click");

  setSessionFlush(() => Promise.resolve());
  linux.openSettings("profiles", "work", null, "profiles.extensions");
  await new Promise(setImmediate);
  const consented = JSON.parse(JSON.stringify(windows.open.get("settings").settings));
  assert.equal(consented.revealConsent, "epoch-after-click");
  useSettingsSearch.setState({ reveal: null });
  navigateUtility(consented);
  assert.equal(useSettingsSearch.getState().reveal?.consent, "epoch-after-click");
});
