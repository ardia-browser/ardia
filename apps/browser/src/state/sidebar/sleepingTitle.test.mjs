import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { iconMarks, titleStruck } = await import("./rowState.ts");
const { useLifecycle, isSleeping } = await import("../tabs/sleepingTabs.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

const struck = (id) => titleStruck(S().settings.strikeSleepingTabs, isSleeping(id), iconMarks(S(), id));

function session() {
  S().hydrate({});
  useLifecycle.setState({ discarded: {} });
  const w = S().createWindow({ url: "https://a.com/" });
  const awake = S().windows[w].tabIds[0];
  const asleep = S().newTab(w, { url: "https://b.com/", background: true });
  const background = S().newTab(w, { url: "https://c.com/", background: true });
  useLifecycle.setState({ discarded: { [asleep]: true } });
  return { awake, asleep, background };
}

test("strike through sleeping tabs is off by default", () => {
  assert.equal(DEFAULT_SETTINGS.strikeSleepingTabs, false);
  session();
  assert.equal(S().settings.strikeSleepingTabs, false);
});

test("only a discarded tab's title is struck, and only with the setting on", () => {
  const { awake, asleep, background } = session();
  assert.deepEqual([awake, asleep, background].map(struck), [false, false, false]);
  S().updateSettings({ strikeSleepingTabs: true });
  assert.deepEqual([awake, asleep, background].map(struck), [false, true, false]);
});

test("a tab that wakes loses the strike at once", () => {
  const { asleep } = session();
  S().updateSettings({ strikeSleepingTabs: true });
  assert.equal(struck(asleep), true);
  useLifecycle.setState({ discarded: {} });
  assert.equal(struck(asleep), false);
});

test("a closed pinned tab is struck only when Fade icons of unloaded tabs treats it as asleep too", () => {
  const { background } = session();
  S().pinTabs([background], true);
  S().closeTabs([background]);
  S().updateSettings({ strikeSleepingTabs: true });
  assert.equal(struck(background), false);
  S().updateSettings({ fadeUnloadedTabs: true });
  assert.equal(struck(background), true);
  S().updateSettings({ strikeSleepingTabs: false });
  assert.equal(struck(background), false);
});

test("a closed Top App is struck when it loses its tile, as its icon fades then", () => {
  const { background } = session();
  S().pinTabs([background], true);
  S().closeTabs([background]);
  S().updateSettings({ strikeSleepingTabs: true });
  assert.equal(struck(background), false);
  S().updateSettings({ closedTopAppTiles: false });
  assert.equal(struck(background), true);
});
