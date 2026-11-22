import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";

globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });

const GOOGLE = {
  name: "Google",
  keyword: "google.com",
  url: "{google:baseURL}search?q={searchTerms}&{google:RLZ}{google:originalQueryForSuggestion}{google:assistedQueryStats}ie={inputEncoding}",
  prepopulateId: 1,
};
const DUCKDUCKGO = { name: "DuckDuckGo", keyword: "duckduckgo.com", url: "https://duckduckgo.com/?q={searchTerms}", prepopulateId: 92 };
const DOCS = { name: "Ardia Docs", keyword: "docs", url: "https://docs.ardia.example/find?q={searchTerms}&enc={inputEncoding}&{google:RLZ}" };

let engines = {};
globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    isBrowserUnlocked: () => true,
    forgetUnlockedKeys() {},
    cancelImport() {},
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) =>
      JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabs: [], tabGroups: [], credentials: [], cookieCount: 0, addressCount: 0, cardCount: 0,
        spaces: [], favorites: [], favicons: [], failed: [], warnings: [],
        ...(engines[profileId] ? { searchEngine: engines[profileId] } : {}),
      }),
  },
};

const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "300", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install-1", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
const client = await import("../telemetry/client.ts");
const local = await import("../telemetry/localStore.ts");
const { BUILT_IN_ENGINES } = await import("@ardia/core");
const { useBrowser } = await import("../browser/store.ts");
const { useImportFlow } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");
const { chromiumTemplateUrl, matchImportedEngine, takeOfferedEngine } = await import("./searchEngine.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");
const { chooseSource, confirmAnswer, sourcePatch, startOnboarding, useOnboarding } = await import("../onboarding/onboarding.ts");
client.startClient();
after(() => client.flush());

const S = () => useBrowser.getState();
const sent = () => (local.flushLocal(), stub.telemetryLocal.records().filter((r) => r.event === "search_engine_import"));
const fresh = () => {
  S().hydrate({});
  useOnboarding.setState({ windowId: null, leaving: false, redo: false });
};
const pick = (...keys) => Object.fromEntries(keys.map((k) => [k, sent().at(-1).properties[k]]));
const arc = {
  id: "arc", name: "Arc", family: "chromium", requiresExport: false, needsKeychain: false,
  profiles: [{ id: "Default", name: "Default", path: "Default", isDefault: true, available: ["bookmarks"] }],
};

async function importArc() {
  S().createWindow({ url: "https://start.example/" });
  useImportFlow.setState({ source: arc, sourceProfiles: ["Default"], spaces: [], target: "default", kinds: new Set(["bookmarks"]), step: { name: "choose", error: null } });
  await runImport(new Set(["bookmarks"]));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(useImportFlow.getState().step.name, "done");
  return useImportFlow.getState().step;
}

test("Chromium's engines map onto Ardia's: a built-in by its address, anything else as a custom engine, reused when imported again", () => {
  assert.equal(chromiumTemplateUrl(GOOGLE.url), "https://www.google.com/search?q=%s&ie=UTF-8");
  assert.equal(chromiumTemplateUrl(DOCS.url), "https://docs.ardia.example/find?q=%s&enc=UTF-8");
  assert.equal(matchImportedEngine(GOOGLE, BUILT_IN_ENGINES)?.id, "google");
  assert.equal(matchImportedEngine(DUCKDUCKGO, BUILT_IN_ENGINES)?.id, "duckduckgo");
  assert.equal(matchImportedEngine({ name: "Yahoo! UK", keyword: "uk.yahoo.com", url: "https://uk.search.yahoo.com/search?p={searchTerms}", prepopulateId: 2 }, BUILT_IN_ENGINES)?.id, "yahoo");
  assert.deepEqual(matchImportedEngine({ name: "Find", keyword: "google.com", url: "https://search.example/find?q={searchTerms}" }, BUILT_IN_ENGINES), {
    custom: { name: "Find", keyword: "search.example", url: "https://search.example/find?q=%s" },
  });
  assert.deepEqual(matchImportedEngine(DOCS, BUILT_IN_ENGINES), { custom: { name: "Ardia Docs", keyword: "docs", url: "https://docs.ardia.example/find?q=%s&enc=UTF-8" } });
  const again = [...BUILT_IN_ENGINES, { id: "docs-1", name: "Ardia Docs", keyword: "docs", url: "https://docs.ardia.example/find?q=%s&enc=UTF-8", custom: true }];
  assert.deepEqual(matchImportedEngine(DOCS, again), { id: "docs-1" });
  assert.equal(matchImportedEngine({ name: "Odd", keyword: "odd", url: "ftp://odd.example/{searchTerms}" }, BUILT_IN_ENGINES), null);
});

test("importing from Arc on DuckDuckGo makes it Ardia's engine, says so, and sends only the outcome", async () => {
  fresh();
  engines = { Default: DUCKDUCKGO };
  const step = await importArc();
  assert.equal(S().settings.searchEngine, "duckduckgo");
  assert.deepEqual(step.searchEngine, { name: "DuckDuckGo", offered: false, engine: DUCKDUCKGO });
  assert.deepEqual(pick("source", "outcome", "changed", "offered"), { source: "arc", outcome: "built_in", changed: true, offered: false });
  assert.ok(!JSON.stringify(sent().at(-1)).toLowerCase().includes("duckduckgo"), "never which engine");
});

test("an engine the user chose stays; the done screen offers the source's, and taking it switches once", async () => {
  fresh();
  S().setSearchEngine("kagi");
  engines = { Default: DUCKDUCKGO };
  takeImportRuns();
  const step = await importArc();
  assert.equal(S().settings.searchEngine, "kagi");
  assert.deepEqual(step.searchEngine, { name: "DuckDuckGo", offered: true, engine: DUCKDUCKGO });
  assert.deepEqual(pick("changed", "offered"), { changed: false, offered: true });
  takeOfferedEngine();
  takeOfferedEngine();
  assert.equal(S().settings.searchEngine, "duckduckgo");
  assert.equal(takeImportRuns().import_search_engine_offers_taken, 1);
});

test("a source on its own default leaves Ardia's engine alone", async () => {
  fresh();
  engines = {};
  const step = await importArc();
  assert.equal(S().settings.searchEngine, "google");
  assert.equal(step.searchEngine, undefined);
  assert.equal(pick("outcome").outcome, "source_default");
});

test("in onboarding, the browser preset doesn't put Google back over an imported engine", async () => {
  fresh();
  startOnboarding(S().createWindow(), "source");
  chooseSource("arc");
  assert.equal(sourcePatch().searchEngine, "google");
  engines = { Default: DUCKDUCKGO };
  await importArc();
  const patch = sourcePatch();
  assert.equal("searchEngine" in patch, false);
  confirmAnswer("source", patch, []);
  assert.equal(S().settings.searchEngine, "duckduckgo");
  fresh();
});
