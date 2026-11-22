import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { settingsAdapter } = await import("../sync/settingsAdapter.ts");
const { parseSettings, searchEngines, DEFAULT_SETTINGS } = await import("./settings.ts");
const { createSuggestFetcher, allEngines, suggestRequestUrl, BUILT_IN_ENGINES } = await import("@ardia/core");

const S = () => useBrowser.getState();
const reset = () => useBrowser.setState({ settings: DEFAULT_SETTINGS, settingsMeta: { chosen: [], inferred: [] } });

const received = {
  id: "engine-x",
  name: "Example",
  keyword: "ex",
  url: "https://search.example/?q=%s",
  suggestUrl: "http://127.0.0.1:9/collect?q=%s",
  extra: { nested: true },
};

const requested = async (engine) => {
  const urls = [];
  const fetcher = createSuggestFetcher({ fetch: async (url) => (urls.push(url), { ok: false, text: async () => "" }), delay: 0 });
  fetcher.request(engine, "typed text", () => {});
  await new Promise((r) => setTimeout(r, 10));
  return urls;
};

test("a synced custom engine keeps only its declared fields and asks no suggestion endpoint", async () => {
  reset();
  settingsAdapter.apply(new Map([["set:customSearchEngines", { v: [received] }]]), ["set:customSearchEngines"]);
  assert.deepEqual(S().settings.customSearchEngines, [{ id: "engine-x", name: "Example", keyword: "ex", url: "https://search.example/?q=%s" }]);
  settingsAdapter.apply(new Map([["set:searchEngine", { v: "engine-x" }]]), ["set:searchEngine"]);
  const engine = searchEngines(S().settings).find((e) => e.id === "engine-x");
  assert.ok(engine);
  assert.equal(engine.suggestUrl, undefined);
  assert.deepEqual(await requested(engine), []);
});

test("custom engines loaded from disk drop unknown fields and bad search templates", () => {
  const settings = parseSettings({
    customSearchEngines: [
      received,
      { id: "a", name: "A", keyword: "a", url: "javascript:alert(1)//%s" },
      { id: "b", name: "B", keyword: "b", url: "https://b.example/search" },
      { id: "c", name: "C", keyword: "c", url: "http://c.example/?q=%s" },
    ],
  });
  assert.deepEqual(
    settings.customSearchEngines.map((e) => Object.keys(e).sort().join()),
    ["id,keyword,name,url", "id,keyword,name,url"],
  );
  assert.deepEqual(settings.customSearchEngines.map((e) => e.id), ["engine-x", "c"]);
});

test("updateSettings rebuilds custom engines whoever writes them", () => {
  reset();
  S().updateSettings({ customSearchEngines: [received, { id: "f", name: "F", keyword: "f", url: "file:///tmp/%s" }] });
  assert.deepEqual(S().settings.customSearchEngines, [{ id: "engine-x", name: "Example", keyword: "ex", url: "https://search.example/?q=%s" }]);
  S().updateSettings({ customSearchEngines: [received] }, { fromSync: true });
  assert.equal("suggestUrl" in S().settings.customSearchEngines[0], false);
});

test("the engine list never carries a suggestion endpoint for a custom engine", async () => {
  const engines = allEngines([received, { id: "bad", name: "Bad", keyword: "bad", url: "data:text/html,%s" }]);
  const custom = engines.filter((e) => e.custom);
  assert.deepEqual(custom.map((e) => e.id), ["engine-x"]);
  assert.equal(custom[0].suggestUrl, undefined);
  assert.equal(suggestRequestUrl(custom[0], "typed"), null);
  assert.equal(suggestRequestUrl({ ...custom[0], suggestUrl: received.suggestUrl }, "typed"), null);
  assert.ok(suggestRequestUrl(BUILT_IN_ENGINES[0], "typed")?.startsWith("https://www.google.com/complete/search?"));
});

test("a legacy custom search URL needs an http(s) template with the query placeholder", () => {
  const base = { ...DEFAULT_SETTINGS };
  assert.equal(searchEngines({ ...base, customSearchUrl: "javascript:alert(1)//%s" }).some((e) => e.id === "custom"), false);
  assert.equal(searchEngines({ ...base, customSearchUrl: "https://legacy.example/?q=%s" }).find((e) => e.id === "custom")?.url, "https://legacy.example/?q=%s");
});

test("what this version sends for custom engines is the shape older versions accept", () => {
  reset();
  S().updateSettings({ customSearchEngines: [received] });
  const { values } = settingsAdapter.extract(() => undefined);
  const sent = values.get("set:customSearchEngines").v;
  assert.deepEqual(sent, [{ id: "engine-x", name: "Example", keyword: "ex", url: "https://search.example/?q=%s" }]);
  assert.ok(sent.every((e) => ["id", "name", "keyword", "url"].every((k) => typeof e[k] === "string")));
});

test("the suggestion transport refuses a custom engine's endpoint and keeps built-in ones", async () => {
  const { browserSuggestFetch } = await import("../omnibox/suggestTransport.ts");
  const ddg = BUILT_IN_ENGINES.find((e) => e.id === "duckduckgo");
  const custom = allEngines([received]).find((e) => e.custom);
  let asked = 0;
  globalThis.acTestSuggest = async () => (asked++, { status: 200, body: "[]" });
  try {
    const refused = await browserSuggestFetch("")("http://127.0.0.1:9/collect?q=typed", { signal: new AbortController().signal, engine: { ...custom, suggestUrl: received.suggestUrl } });
    assert.equal(refused.ok, false);
    assert.equal(asked, 0);
    await browserSuggestFetch("")("https://duckduckgo.com/ac/?q=typed&type=list", { signal: new AbortController().signal, engine: ddg });
    assert.equal(asked, 1);
  } finally {
    globalThis.acTestSuggest = undefined;
  }
});
