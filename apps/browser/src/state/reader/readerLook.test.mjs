import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setLive, drainLive } = await import("../tabs/tabLive.ts");
const { startReader, toggleReader, readerState } = await import("./reader.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");

const S = () => useBrowser.getState();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = startReader();
after(() => stop());

let page = 0;
function openPlanted(report) {
  S().hydrate({});
  useBrowser.setState({ settings: DEFAULT_SETTINGS, settingsMeta: { chosen: [], inferred: [] } });
  const w = S().createWindow({ url: `http://127.0.0.1:9/article-${++page}` });
  const tab = activeTabId(S(), w);
  const calls = [];
  webviews.set(tab, { evaluate: async (code) => (calls.push(code), typeof report === "function" ? report(code) : report) });
  return { tab, calls };
}

const look = () => [S().settings.readerTextSize, S().settings.readerFont];
const chosen = () => S().settingsMeta.chosen.filter((k) => k.startsWith("reader"));

test("the load-time check never writes a look the page reports", async () => {
  const { calls } = openPlanted({ active: true, readerable: true, look: { dark: false, size: 4, font: "sans" } });
  await wait(400);
  assert.ok(calls.some((c) => c.includes(".check(")));
  assert.deepEqual(look(), ["medium", "serif"]);
  assert.deepEqual(chosen(), []);
});

test("a page report's size that isn't one of the five sizes is ignored", async () => {
  for (const size of ["length", "constructor", 5, -1, 1.5, "4", null]) {
    const { tab } = openPlanted({ active: true, readerable: true, look: { dark: false, size, font: "sans" } });
    await wait(300);
    await toggleReader(tab);
    assert.equal(typeof S().settings.readerTextSize, "string");
    assert.ok(["small", "medium", "large", "larger", "largest"].includes(S().settings.readerTextSize), String(size));
    assert.equal(S().settings.readerTextSize, "medium");
  }
});

test("a malformed report leaves the reader state well-formed", async () => {
  const { tab } = openPlanted({ active: "yes", readerable: 1, look: "big" });
  await wait(300);
  const state = readerState(tab);
  assert.equal(typeof state.active, "boolean");
  assert.equal(typeof state.available, "boolean");
  assert.equal(state.active, false);
  assert.deepEqual(look(), ["medium", "serif"]);
});

test("a page can't set the look on the document where the user opened Reader", async () => {
  let reported = { active: false, readerable: true };
  const { tab } = openPlanted(() => reported);
  await wait(300);
  reported = { active: true, readerable: true, look: { dark: false, size: 3, font: "sans" } };
  await toggleReader(tab);
  reported = { active: true, look: { dark: false, size: 4, font: "sans" } };
  await wait(1300);
  reported = { active: false, look: { dark: false, size: 0, font: "sans" } };
  await toggleReader(tab);
  assert.deepEqual(look(), ["medium", "serif"]);
  assert.deepEqual(chosen(), []);
});

test("the browser's Reader Text controls set the look and send it to the open reader", async () => {
  const { stepReaderSize, toggleReaderFont } = await import("./reader.ts");
  let reported = { active: false, readerable: true };
  const { tab, calls } = openPlanted(() => reported);
  await wait(300);
  reported = { active: true, readerable: true };
  await toggleReader(tab);
  stepReaderSize(1);
  stepReaderSize(1);
  toggleReaderFont();
  assert.deepEqual(look(), ["larger", "sans"]);
  for (let i = 0; i < 6; i++) stepReaderSize(1);
  assert.equal(S().settings.readerTextSize, "largest");
  for (let i = 0; i < 6; i++) stepReaderSize(-1);
  assert.equal(S().settings.readerTextSize, "small");
  await wait(20);
  const pushed = calls.filter((c) => c.includes(".setLook("));
  assert.ok(pushed.length > 0);
  assert.ok(pushed.at(-1).includes('"size":0') && pushed.at(-1).includes('"font":"sans"'), pushed.at(-1));
});

test("the periodic state read writes nothing for a reader the user didn't open", async () => {
  openPlanted({ active: true, readerable: true, look: { dark: false, size: 0, font: "sans" } });
  await wait(1600);
  assert.deepEqual(look(), ["medium", "serif"]);
});

test("updateSettings keeps only known settings with values their spec accepts, for every caller", async () => {
  const { takeSettingsWriteCounts } = await import("../telemetry/settingsWriteCounts.ts");
  const client = await import("../telemetry/client.ts");
  client.setSharing(true, "settings");
  takeSettingsWriteCounts();
  useBrowser.setState({ settings: DEFAULT_SETTINGS, settingsMeta: { chosen: [], inferred: [] } });
  S().updateSettings({ readerTextSize: 5, readerFont: "comic", notASetting: true, showFullUrl: true });
  assert.equal(S().settings.readerTextSize, "medium");
  assert.equal(S().settings.readerFont, "serif");
  assert.equal("notASetting" in S().settings, false);
  assert.equal(S().settings.showFullUrl, true);
  assert.deepEqual(S().settingsMeta.chosen, ["showFullUrl"]);
  S().updateSettings({ readerTextSize: Array, sidebarSide: "middle", __proto__: { polluted: 1 } }, { fromSync: true });
  assert.equal(S().settings.readerTextSize, "medium");
  assert.equal(S().settings.sidebarSide, "left");
  S().updateSettings({ readerTextSize: "largest" }, { fromSync: true });
  assert.equal(S().settings.readerTextSize, "largest");
  assert.equal(takeSettingsWriteCounts().settings_writes_rejected, 5);
  client.setSharing(false, "settings");
  useBrowser.setState({ settings: DEFAULT_SETTINGS, settingsMeta: { chosen: [], inferred: [] } });
});

const reload = (tab) => {
  setLive(tab, { isLoading: true });
  drainLive();
  setLive(tab, { isLoading: false });
  drainLive();
};

test("a reload while Reader is open writes nothing the new page reports", async () => {
  let reported = { active: false, readerable: true };
  const { tab } = openPlanted(() => reported);
  await wait(300);
  reported = { active: true, readerable: true, look: { dark: false, size: 3, font: "sans" } };
  await toggleReader(tab);
  assert.deepEqual(look(), ["medium", "serif"]);
  reload(tab);
  reported = { active: true, readerable: true, look: { dark: false, size: 0, font: "sans" } };
  await wait(1700);
  assert.deepEqual(look(), ["medium", "serif"]);
});

test("a toggle whose page is replaced while it runs keeps nothing", async () => {
  let reported = { active: false, readerable: true };
  let tabId;
  const { tab } = openPlanted((code) => {
    if (code.includes(".toggle(")) reload(tabId);
    return reported;
  });
  tabId = tab;
  await wait(300);
  reported = { active: true, readerable: true, look: { dark: false, size: 4, font: "sans" } };
  await toggleReader(tab);
  assert.deepEqual(look(), ["medium", "serif"]);
  reported = { active: true, readerable: true, look: { dark: false, size: 0, font: "sans" } };
  await wait(1700);
  assert.deepEqual(look(), ["medium", "serif"]);
});
