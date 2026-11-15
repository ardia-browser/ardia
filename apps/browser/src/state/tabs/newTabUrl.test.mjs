import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { customNewTabUrl } = await import("../settings/settings.ts");
const { runCommand } = await import("../commands/commands.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");
const { unshownSettings } = await import("../../components/settings/settingsIndex.ts");
const { toggleNewTabBar } = await import("../omnibox/newTabBar.ts");
const { setOpeningGate } = await import("./openingGate.ts");
const { registerHeroBar } = await import("../omnibox/barState.ts");
const { startAutomation } = await import("../automation/controlSocket.ts");
const { reloadHooks, useHookRules } = await import("../automation/hookRules.ts");
const { approveRule, resetApprovalsForTests } = await import("../automation/approvals.ts");
const { approvalFor } = await import("../automation/hookPolicy.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const shownUrl = (w) => S().tabs[activeTabId(S(), w)].url;
const hidden = () => unshownSettings(S().settings, { top: false, glass: true }).split("\n");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const reset = (settings = {}) => {
  S().hydrate({});
  S().updateSettings(settings);
};

test("with no address set, ⌘T, the New Tab row and a new window open the New Tab page", () => {
  reset();
  const w = S().createWindow();
  assert.equal(shownUrl(w), "");
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), "");
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), "");
});

test("with an address set, ⌘T opens it in a new tab", () => {
  reset({ newTabUrl: "example.com" });
  const w = S().createWindow({ url: "https://a.com/" });
  const before = S().windows[w].tabIds.length;
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(S().windows[w].tabIds.length, before + 1);
  assert.equal(shownUrl(w), "https://example.com");
});

test("the sidebar's New Tab row, a group's New Tab and a new window open it too", () => {
  reset({ newTabUrl: "https://start.example.org/home" });
  const w = S().createWindow();
  assert.equal(shownUrl(w), "https://start.example.org/home", "a new window");
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), "https://start.example.org/home", "the New Tab row");
  const group = S().groupTabs([activeTabId(S(), w)]);
  const id = S().newTabInGroup(group);
  assert.equal(S().tabs[id].url, "https://start.example.org/home", "a group's New Tab");
});

test("links, typed addresses and Little Ardia keep their own address", () => {
  reset({ newTabUrl: "example.com" });
  const w = S().createWindow({ url: "https://a.com/" });
  const id = S().newTab(w, { url: "https://b.com/", newTabCommand: true });
  assert.equal(S().tabs[id].url, "https://b.com/");
  const link = S().newTab(w, { url: "https://c.com/", openerId: id });
  assert.equal(S().tabs[link].url, "https://c.com/");
  const small = S().createWindow({ kind: "small", url: "https://d.com/" });
  assert.equal(shownUrl(small), "https://d.com/");
  const blank = S().newTab(w);
  assert.equal(S().tabs[blank].url, "", "a tab made by the app, not by New Tab, stays empty");
});

test("an address that isn't one, or Ardia's own New Tab or Settings, falls back to the New Tab page", () => {
  for (const newTabUrl of ["", "   ", "hello world", "javascript:alert(1)", "ardia://newtab", "ardia://settings/tabs"]) {
    reset({ newTabUrl });
    assert.equal(customNewTabUrl(S().settings), undefined, newTabUrl);
    const w = S().createWindow({ url: "https://a.com/" });
    runCommand({ command: "newTab", arg: null, windowId: w });
    assert.equal(shownUrl(w), "", newTabUrl);
  }
});

test("only web addresses and Ardia's own pages open as the New Tab page: Chrome's debug and internal pages and app links fall back", () => {
  for (const newTabUrl of ["chrome://quit", "chrome://restart", "chrome://inducebrowsercrashforrealz", "chrome://crash", "chrome://kill", "chrome://hang", "chrome://flags", "chrome://settings", "chrome://newtab", "about:quit", "about:crash", "ardia://quit", "view-source:https://a.com/", "mailto:me@example.com", "tel:123", "slack://open", "facetime:me@example.com", "file:///etc/hosts", "data:text/html,hi", "ftp://example.com/"]) {
    reset({ newTabUrl });
    assert.equal(customNewTabUrl(S().settings), undefined, newTabUrl);
    const w = S().createWindow();
    assert.equal(shownUrl(w), "", newTabUrl);
  }
  for (const [newTabUrl, url] of [["example.com", "https://example.com"], ["http://127.0.0.1:8765/opener.html", "http://127.0.0.1:8765/opener.html"], ["ardia://history", "ardia://history"], ["chrome://bookmarks", "ardia://bookmarks"], ["about:blank", "about:blank"]]) {
    reset({ newTabUrl });
    assert.equal(customNewTabUrl(S().settings), url, newTabUrl);
  }
});

test("a tab.opening rule that cancels or rewrites applies to the address a new window and a group's New Tab open, as on ⌘T", () => {
  reset({ newTabUrl: "https://home.example/" });
  const seen = [];
  let verdict = { cancel: true };
  setOpeningGate((url, context) => {
    seen.push([url, context.via]);
    return verdict;
  });
  try {
    const cancelled = S().createWindow();
    assert.equal(shownUrl(cancelled), "", "a cancel leaves the new window on the New Tab page");
    const group = S().groupTabs([activeTabId(S(), cancelled)]);
    const before = S().windows[cancelled].tabIds.length;
    assert.equal(S().newTabInGroup(group), "", "a cancel opens no tab in the group");
    assert.equal(S().windows[cancelled].tabIds.length, before);
    verdict = { url: "https://elsewhere.example/" };
    const redirected = S().createWindow();
    assert.equal(shownUrl(redirected), "https://elsewhere.example/", "a rewrite wins in a new window");
    const id = S().newTabInGroup(group);
    assert.equal(S().tabs[id].url, "https://elsewhere.example/", "a rewrite wins in a group's New Tab");
    assert.deepEqual(seen, Array(4).fill(["https://home.example/", "newTab"]));
    verdict = null;
    assert.equal(shownUrl(S().createWindow()), "https://home.example/", "no answer opens the address");
  } finally {
    setOpeningGate(null);
  }
});

test("a tab.opening rule that answers later can still cancel or rewrite the address a new window and a group's New Tab open", async () => {
  reset({ newTabUrl: "https://home.example/" });
  const answers = [];
  setOpeningGate(() => new Promise((resolve) => answers.push(resolve)));
  try {
    const w = S().createWindow();
    const first = activeTabId(S(), w);
    assert.equal(S().tabs[first].page.nav, undefined, "the new window's tab waits for the answer");
    answers.shift()({ url: "https://elsewhere.example/" });
    await tick();
    assert.equal(S().tabs[first].page.nav?.url, "https://elsewhere.example/");
    const group = S().groupTabs([first]);
    const waiting = S().newTabInGroup(group);
    assert.equal(S().tabs[waiting].page.nav, undefined, "the group's tab waits for the answer");
    answers.shift()({ cancel: true });
    await tick();
    assert.equal(S().tabs[waiting], undefined, "a cancel closes the waiting tab");
    const other = S().createWindow();
    const blank = activeTabId(S(), other);
    answers.shift()({ cancel: true });
    await tick();
    assert.ok(S().tabs[blank], "a cancel keeps the new window, on the New Tab page");
    assert.equal(shownUrl(other), "");
  } finally {
    setOpeningGate(null);
  }
});

test("with ⌘T opening the command bar, the address is ignored and its row is hidden", () => {
  reset({ newTabOpens: "commandBar", newTabUrl: "example.com" });
  assert.equal(customNewTabUrl(S().settings), undefined);
  const w = S().createWindow();
  assert.equal(shownUrl(w), "");
  assert.ok(hidden().includes("tabs.newTabUrl"));
  S().updateSettings({ newTabOpens: "page" });
  assert.ok(!hidden().includes("tabs.newTabUrl"));
});

test("Minimalism mode, which makes ⌘T open the command bar, ignores the address and hides its row", () => {
  reset({ minimalismMode: true, newTabUrl: "example.com" });
  assert.equal(customNewTabUrl(S().settings), undefined);
  assert.equal(shownUrl(S().createWindow()), "");
  assert.ok(hidden().includes("tabs.newTabUrl"));
  S().updateSettings({ minimalismMode: false });
  assert.equal(customNewTabUrl(S().settings), "https://example.com");
  assert.ok(!hidden().includes("tabs.newTabUrl"));
});

test("the address syncs like the other New Tab settings, and telemetry gets only whether one is set", () => {
  reset({ newTabUrl: "https://secret.example.com/path" });
  const snapshot = settingsSnapshot(S().settings);
  assert.equal(snapshot.custom_new_tab_url, "true");
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
  reset({ newTabUrl: "hello world" });
  assert.equal(settingsSnapshot(S().settings).custom_new_tab_url, "false");
});

test("with Reuse an empty New Tab page on, ⌘T on an empty New Tab page opens the address instead of focusing the page", () => {
  reset({ newTabUrl: "example.com", reuseEmptyNewTab: true });
  const w = S().createWindow({ url: "https://a.com/" });
  const empty = S().newTab(w);
  let focused = 0;
  const unregister = registerHeroBar(w, empty, () => void focused++);
  try {
    assert.equal(toggleNewTabBar(w), false, "the empty page isn't reused while an address is set");
    const before = S().windows[w].tabIds.length;
    runCommand({ command: "newTab", arg: null, windowId: w });
    assert.deepEqual([focused, S().windows[w].tabIds.length, shownUrl(w)], [0, before + 1, "https://example.com"]);
    S().updateSettings({ newTabUrl: "" });
    S().activate(empty);
    assert.equal(toggleNewTabBar(w), true, "with no address, the empty page is reused as before");
    assert.equal(focused, 1);
  } finally {
    unregister();
  }
});

let nextId = 0;
function call(method, params, connection) {
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id: ++nextId, method, params }) });
  return JSON.parse(stub.controlSocket.replies.slice(before).find((r) => r.connection === connection).line);
}

after(() => S().updateSettings({ cliControl: false }));

test("a tab.opening hook that answers later can still cancel or redirect the address ⌘T opens", async () => {
  const hooks = [{ name: "home", on: "tab.opening", run: ["~/bin/decide"] }];
  reset({ newTabUrl: "https://home.example/", cliControl: true });
  resetApprovalsForTests();
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks }));
  reloadHooks();
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  approveRule(approvalFor(useHookRules.getState().hooks[0]).key);
  const runner = 900;
  assert.deepEqual(call("subscribe", { events: ["tab.opened"], hooks }, runner).result.served, ["home"]);
  const w = S().createWindow({ url: "https://a.com/" });
  const decide = (from) => stub.controlSocket.broadcasts.slice(from).map((b) => JSON.parse(b.line)).find((l) => l.decide && l.event === "tab.opening");

  let from = stub.controlSocket.broadcasts.length;
  runCommand({ command: "newTab", arg: null, windowId: w });
  const cancelled = activeTabId(S(), w);
  let request = decide(from);
  assert.ok(request, "the hook is asked about the address");
  assert.equal(S().tabs[cancelled].page.nav, undefined, "the waiting tab doesn't load the address before the hook answers");
  call("answer", { decide: request.decide, answer: { cancel: true } }, runner);
  await tick();
  assert.equal(S().tabs[cancelled], undefined, "a cancel closes the waiting tab");

  from = stub.controlSocket.broadcasts.length;
  runCommand({ command: "newTab", arg: null, windowId: w });
  const redirected = activeTabId(S(), w);
  request = decide(from);
  call("answer", { decide: request.decide, answer: { url: "https://elsewhere.example/" } }, runner);
  await tick();
  assert.equal(S().tabs[redirected].page.nav?.url, "https://elsewhere.example/", "a replacement address wins");
});
