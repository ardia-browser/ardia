import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeed } from "./seed.mjs";

const sessionOf = (seed) => (typeof seed["session.json"] === "string" ? JSON.parse(seed["session.json"]) : seed["session.json"]);
const hostOf = (url) => new URL(url).host;
const activeOf = (session) => new Set(Object.values(session.windows[0].activeTabIds));

test("the session's active tabs load from the bench origin and every other tab from its own host, so Chromium's same-host favicon fallback can't race into the launch counts", () => {
  const session = sessionOf(buildSeed("http://127.0.0.1:47817", "", { tabsOrigin: "http://[::1]:47817" }));
  const active = activeOf(session);
  assert.equal(active.size, 2);
  for (const tab of session.tabs) {
    assert.equal(hostOf(tab.url), active.has(tab.id) ? "127.0.0.1:47817" : "[::1]:47817", tab.id);
    if (tab.pinnedUrl) assert.equal(tab.pinnedUrl, tab.url, `${tab.id} keeps its pinned URL`);
  }
});

test("only the active tabs' pages answer late, so the address field's load fill shows in every launch instead of racing its 150 ms threshold", () => {
  const session = sessionOf(buildSeed("http://127.0.0.1:47817", "", { tabsOrigin: "http://[::1]:47817", activeDelayMs: 400 }));
  const active = activeOf(session);
  for (const tab of session.tabs) assert.equal(new URL(tab.url).searchParams.get("d"), active.has(tab.id) ? "400" : null, tab.id);
});

test("without options the seed keeps every tab on the bench origin with no delay, as micro-bench and census build it", () => {
  const session = sessionOf(buildSeed("http://127.0.0.1:47817"));
  assert.ok(session.tabs.every((tab) => hostOf(tab.url) === "127.0.0.1:47817" && !new URL(tab.url).search));
});
