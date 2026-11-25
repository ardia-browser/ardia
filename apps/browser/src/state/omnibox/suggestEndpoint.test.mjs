import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SETTINGS, parseSettings, defaultSearchEngine } = await import("../settings/settings.ts");
const { BUILT_IN_ENGINES, allEngines } = await import("@ardia/core");
const { browserSuggestFetch } = await import("./suggestTransport.ts");
const { setLiveExtensionSearchEngines } = await import("../extensions/searchEngines.ts");

const S = () => useBrowser.getState();
const record = (over = {}) => ({ profile: "p1", extensionId: "ext", extensionName: "Ext", name: "Ext", keyword: "ex", url: "https://ext.example/s?q=%s", suggestUrl: "https://ext.example/suggest?q=%s", isDefault: true, ...over });
const engineOf = (rec) => allEngines([], [rec]).find((e) => e.extension);
const google = BUILT_IN_ENGINES.find((e) => e.id === "google");
const ddg = BUILT_IN_ENGINES.find((e) => e.id === "duckduckgo");

async function asks(profile, url, engine) {
  let asked = 0;
  globalThis.acTestSuggest = async () => (asked++, { status: 200, body: "[]" });
  try {
    await browserSuggestFetch(profile)(url, { signal: new AbortController().signal, engine });
  } finally {
    globalThis.acTestSuggest = undefined;
  }
  return asked;
}

test("a cached extension record from settings doesn't authorise a suggestion request", async () => {
  setLiveExtensionSearchEngines("p1", []);
  const cached = record({ suggestUrl: "https://cached.example/s?q=%s" });
  useBrowser.setState({ settings: { ...DEFAULT_SETTINGS, extensionSearchEngines: [cached] } });
  assert.equal(await asks("p1", "https://cached.example/s?q=typed", engineOf(cached)), 0);
});

test("a live extension engine's endpoint is allowed only for its own profile and engine", async () => {
  setLiveExtensionSearchEngines("p1", [record()]);
  setLiveExtensionSearchEngines("p2", []);
  assert.equal(await asks("p1", "https://ext.example/suggest?q=typed", engineOf(record())), 1);
  assert.equal(await asks("p2", "https://ext.example/suggest?q=typed", engineOf(record())), 0);
  assert.equal(await asks("p1", "https://ext.example/suggest?q=typed", google), 0);
});

test("a request is bound to the selected engine's own endpoint", async () => {
  assert.equal(await asks("p1", "https://duckduckgo.com/ac/?q=typed&type=list", ddg), 1);
  assert.equal(await asks("p1", "https://duckduckgo.com/ac/?q=typed&type=list", google), 0);
  assert.equal(await asks("p1", "https://duckduckgo.com/ac/?q=typed&type=list", undefined), 0);
  assert.equal(await asks("p1", "https://duckduckgo.com/ac/?q=typed&type=list", { ...ddg, id: "other", suggestUrl: ddg.suggestUrl }), 0);
});

test("a wrong-type endpoint is skipped without throwing", async () => {
  setLiveExtensionSearchEngines("p1", [record({ extensionId: "bad", suggestUrl: 5 }), record()]);
  assert.equal(await asks("p1", "https://ext.example/suggest?q=typed", engineOf(record({ extensionId: "bad" }))), 0);
  assert.equal(await asks("p1", "https://ext.example/suggest?q=typed", engineOf(record())), 1);
});

test("loading settings keeps only complete extension engine records", () => {
  for (const bad of [{ suggestUrl: 5 }, { isDefault: "yes" }, { extensionName: null }]) {
    const settings = parseSettings({ extensionSearchEngines: [record(bad)] });
    assert.deepEqual(settings.extensionSearchEngines, [], JSON.stringify(bad));
    assert.equal(defaultSearchEngine(settings).id, "google");
  }
  const { suggestUrl: _, ...noSuggest } = record();
  assert.equal(parseSettings({ extensionSearchEngines: [record(), noSuggest] }).extensionSearchEngines.length, 2);
});
