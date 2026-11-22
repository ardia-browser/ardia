import assert from "node:assert/strict";
import { test } from "node:test";
import { importProfile, Unlocks } from "../../../../../packages/expo-windows/src/import/importer.ts";
import { fakeHost } from "./fixtures/windowsHost.mjs";

const quiet = { progress() {}, cancelled: () => false };
const result = (browserId, profileId) => importProfile(fakeHost(), new Unlocks(), browserId, profileId, ["bookmarks"], {}, quiet);

test("Windows: an Arc profile on DuckDuckGo brings its Web Data row, and a custom engine keeps its template", async () => {
  assert.deepEqual((await result("arc", "Default")).searchEngine, { name: "DuckDuckGo", keyword: "duckduckgo.com", url: "https://duckduckgo.com/?q={searchTerms}", prepopulateId: 92 });
  assert.deepEqual((await result("chrome", "Default")).searchEngine, { name: "Ardia Docs", keyword: "docs", url: "https://docs.ardia.example/find?q={searchTerms}&enc={inputEncoding}&{google:RLZ}" });
});

test("Windows: a profile on the browser's own default leaves the engine out", async () => {
  assert.equal("searchEngine" in (await result("arc", "Profile 1")), false);
});
