import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const { engineCalls } = await import("../../test-native/ardiacore.ts");
globalThis.fetch = async () => ({ status: 200 });
const { useBrowser } = await import("../../state/browser/store.ts");
const { activeTabId } = await import("../../state/browser/model.ts");
const { useSuggestions } = await import("./useSuggestions.ts");
const { currentBarActions } = await import("../../state/omnibox/barActions.ts");
const { runBarAction } = await import("../../state/omnibox/runBar.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { markTabReady } = await import("../../state/tabs/pageState.ts");
const { useSettingsNav } = await import("../../state/settings/settingsWindows.ts");
const { trackSuggestionChosen } = await import("../../state/telemetry/track.ts");
const client = await import("../../state/telemetry/client.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const settle = () => new Promise((r) => setImmediate(r));
const PAGE = "https://a.example/page";

function setup(url = PAGE, kind) {
  S().hydrate({});
  const w = S().createWindow(kind ? { url, kind } : { url });
  const tab = activeTabId(S(), w);
  const calls = { panels: [], pageCommands: [] };
  webviews.set(tab, { showDevTools: (panel) => calls.panels.push(panel), runPageCommand: (c) => calls.pageCommands.push(c) });
  return { w, tab, calls };
}

const rowOf = (s) => (s.kind === "action" ? `action:${s.id}` : s.kind);
function suggest(w, text) {
  const h = mount((p) => useSuggestions({ text: p.text, active: true, windowId: w, profileId: S().windows[w].profileId, scope: null }), { props: { text } });
  const rows = h.value.items.map(rowOf);
  h.unmount();
  return rows;
}

const tabUrls = (w) => S().windows[w].tabIds.map((id) => S().tabs[id].url);
const engineCalled = (domain, verb) => engineCalls.some((c) => c.domain === domain && c.verb === verb);

const ENTRIES = [
  {
    id: "inspectElements",
    title: "Inspect Elements",
    keywords: ["inspect element", "element picker"],
    page: true,
    ran: ({ calls }) => assert.deepEqual(calls.panels, ["inspect"]),
  },
  { id: "javaScriptConsole", title: "JavaScript Console", keywords: ["js console"], page: true, ran: ({ calls }) => assert.deepEqual(calls.panels, ["console"]) },
  {
    id: "viewSource",
    title: "View Source",
    keywords: ["page source"],
    page: true,
    ran: ({ w, tab }) => {
      assert.deepEqual(tabUrls(w), [PAGE, `view-source:${PAGE}`]);
      const opened = S().tabs[S().windows[w].tabIds[1]];
      assert.equal(opened.openerId, tab);
    },
  },
  { id: "savePage", title: "Save Page As", keywords: ["save as"], page: true, ran: ({ calls }) => assert.deepEqual(calls.pageCommands, ["savePage"]) },
  { id: "cast", title: "Cast", keywords: ["cast tab"], page: true, ran: () => assert.ok(engineCalled("media", "showCastDialog")) },
  { id: "taskManager", title: "Task Manager", keywords: ["open task manager"], ran: () => assert.ok(engineCalled("engine", "openTaskManager")) },
  { id: "manageExtensions", title: "Manage Extensions", keywords: [], ran: () => assert.equal(useSettingsNav.getState().pane, "extensions") },
  {
    id: "addExtension",
    title: "Add Extension",
    keywords: ["install extension"],
    ran: ({ w }) => assert.ok(tabUrls(w).includes("https://chromewebstore.google.com/category/extensions")),
  },
  {
    id: "newLittleArdia",
    title: "New Little Ardia Window",
    keywords: ["little arc", "mini window"],
    ran: ({ w }) => assert.equal(Object.values(S().windows).filter((x) => x.kind === "small" && x.id !== w).length, 1),
  },
];

for (const e of ENTRIES) {
  test(`${e.title}: Enter on its title${e.keywords.length ? " or a keyword" : ""} runs it, and it runs ${e.id}`, async () => {
    const env = setup();
    const action = currentBarActions(env.w).find((a) => a.id === e.id);
    assert.ok(action, "listed on a web page");
    assert.equal(action.title, e.title);
    assert.deepEqual(action.keywords ?? [], e.keywords);
    for (const typed of [e.title.toLowerCase(), ...e.keywords]) assert.equal(suggest(env.w, typed)[0], `action:${e.id}`, typed);
    engineCalls.length = 0;
    markTabReady(env.tab);
    runBarAction(e.id, env.w);
    await settle();
    e.ran(env);
  });
}

const COMMON_WORDS = [
  ["html", "search"],
  ["memory", "search"],
  ["processes", "search"],
  ["extensions", "search"],
  ["chromecast", "search"],
  ["download page", "search"],
  ["chrome web store", "search"],
  ["source", "search"],
  ["save", "search"],
  ["element", "search"],
  ["little", "search"],
  ["console", "action:devTools"],
  ["inspect", "action:devTools"],
];

for (const [typed, row] of COMMON_WORDS) {
  test(`"${typed}" keeps main's default row (${row})`, () => {
    const { w } = setup();
    assert.equal(suggest(w, typed)[0], row);
  });
}

test("with no page only the four app commands are offered; View Source needs a web page", () => {
  const ids = (w) => new Set(currentBarActions(w).map((a) => a.id));
  const appOnly = ENTRIES.filter((e) => !e.page).map((e) => e.id);
  const pageOnly = ENTRIES.filter((e) => e.page).map((e) => e.id);

  const empty = ids(setup("").w);
  for (const id of appOnly) assert.ok(empty.has(id), `${id} on an empty tab`);
  for (const id of pageOnly) assert.ok(!empty.has(id), `${id} not on an empty tab`);

  const internal = ids(setup("ardia://history").w);
  assert.ok(!internal.has("viewSource"), "no View Source on an internal page");
  for (const id of pageOnly.filter((id) => id !== "viewSource")) assert.ok(internal.has(id), `${id} on an internal page`);

  const file = ids(setup("file:///tmp/a.html").w);
  assert.ok(file.has("viewSource"), "View Source on a file");
});

test("in a private window the four app commands are offered and Add Extension opens the store there", () => {
  const env = setup(PAGE, "private");
  const ids = new Set(currentBarActions(env.w).map((a) => a.id));
  for (const e of ENTRIES) assert.ok(ids.has(e.id), e.id);
  runBarAction("addExtension", env.w);
  assert.ok(tabUrls(env.w).includes("https://chromewebstore.google.com/category/extensions"));
});

test("picking a command bar action counts which command it ran, never its profile or tab", async () => {
  client.setSharing(true, "onboarding");
  trackSuggestionChosen({ kind: "action", id: "viewSource" });
  trackSuggestionChosen({ kind: "action", id: "switchProfile:p_secret" });
  trackSuggestionChosen({ kind: "search" });
  await client.saveQueueNow();
  const sent = JSON.parse(stub.docs.get("telemetry-queue.json"))
    .events.filter((x) => x.event === "suggestion_chosen")
    .map((x) => [x.properties.type, x.properties.command]);
  assert.deepEqual(sent, [
    ["action", "viewSource"],
    ["action", "switchProfile"],
    ["search", undefined],
  ]);
});
