import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
globalThis.fetch = async () => ({ status: 503 });
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { updateLive } = await import("./actions.ts");
const { pageOf, patchPage } = await import("./pageState.ts");
const { openLinkInSplit } = await import("../splits/actions.ts");
const client = await import("../telemetry/client.ts");
const { takeEngineSwitchCounts } = await import("../telemetry/engineSwitchCounts.ts");
const { navigateFromPage } = await import("./pageCommands.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  webviews.clear();
  S().hydrate({});
  client.loadChoice();
  client.setSharing(true, "settings");
  takeEngineSwitchCounts();
});

after(() => client.setSharing(false, "settings"));

test("back and forward page commands navigate a WebKit tab with history and count once per confirmed navigation", async () => {
  S().updateSettings({ engineMode: "webkit" });
  const win = S().createWindow({ url: "https://example.com/2" });
  const tabId = S().windows[win].tabIds[0];
  const calls = [];
  webviews.set(tabId, {
    goBack: () => {
      calls.push("back");
      return Promise.resolve();
    },
    goForward: () => {
      calls.push("forward");
      return Promise.resolve();
    },
  });
  updateLive(tabId, { canGoBack: true, canGoForward: true });

  navigateFromPage(tabId, "back");
  navigateFromPage(tabId, "forward");
  await flush();
  assert.deepEqual(calls, ["back", "forward"]);
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 2);
});

test("back and forward page commands without available history neither call the webview nor count telemetry", async () => {
  S().updateSettings({ engineMode: "webkit" });
  const win = S().createWindow({ url: "https://example.com/1" });
  const tabId = S().windows[win].tabIds[0];
  const calls = [];
  webviews.set(tabId, {
    goBack: () => {
      calls.push("back");
      return Promise.resolve();
    },
    goForward: () => {
      calls.push("forward");
      return Promise.resolve();
    },
  });
  updateLive(tabId, { canGoBack: false, canGoForward: false });

  navigateFromPage(tabId, "back");
  navigateFromPage(tabId, "forward");
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 0);
});

test("back page command with backToNewTab shows New Tab and counts navigation, and forward returns from New Tab", async () => {
  S().updateSettings({ engineMode: "webkit" });
  const win = S().createWindow({ url: "https://example.com/1" });
  const tabId = S().windows[win].tabIds[0];
  patchPage(tabId, { backToNewTab: true });
  updateLive(tabId, { canGoBack: false, canGoForward: false });

  navigateFromPage(tabId, "back");
  await flush();
  assert.ok(pageOf(tabId).newTabShown);
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 1);

  navigateFromPage(tabId, "forward");
  await flush();
  assert.equal(pageOf(tabId).newTabShown, null);
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 1);
});

test("back page command with a missing webview does not count telemetry", async () => {
  S().updateSettings({ engineMode: "webkit" });
  const win = S().createWindow({ url: "https://example.com/2" });
  const tabId = S().windows[win].tabIds[0];
  updateLive(tabId, { canGoBack: true, canGoForward: false });

  navigateFromPage(tabId, "back");
  await flush();
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 0);
});

test("cross-engine back counts telemetry only when confirmed", async () => {
  S().updateSettings({ engineMode: "automatic", engineSwitchAsksAboutUnsavedWork: true });
  const win = S().createWindow({ url: "https://www.netflix.com/browse" });
  const tabId = S().windows[win].tabIds[0];
  S().updateTab(tabId, { engine: "webkit", url: "https://www.netflix.com/browse" });
  patchPage(tabId, { engineBack: { engine: "chromium", url: "https://search.example/?q=film" } });
  updateLive(tabId, { canGoBack: false, canGoForward: false });
  webviews.set(tabId, { evaluate: () => Promise.resolve(true) });

  navigateFromPage(tabId, "back");
  await flush();
  assert.equal(S().tabs[tabId].engine, "webkit");
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 0);

  S().updateSettings({ engineSwitchAsksAboutUnsavedWork: false });
  navigateFromPage(tabId, "back");
  await flush();
  assert.equal(S().tabs[tabId].engine, "chromium");
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 1);
});

test("back page command targets an inactive split pane without affecting the active pane", async () => {
  S().updateSettings({ engineMode: "webkit" });
  const win = S().createWindow({ url: "https://a.example/2" });
  const paneA = S().windows[win].tabIds[0];
  openLinkInSplit(paneA, "https://b.example/2");
  const paneB = Object.values(S().tabs).find((t) => t.url === "https://b.example/2")?.id;
  assert.ok(paneB);
  S().activate(paneB);
  const calls = [];
  webviews.set(paneA, { goBack: () => (calls.push("paneA"), Promise.resolve()) });
  webviews.set(paneB, { goBack: () => (calls.push("paneB"), Promise.resolve()) });
  updateLive(paneA, { canGoBack: true, canGoForward: false });
  updateLive(paneB, { canGoBack: true, canGoForward: false });

  navigateFromPage(paneA, "back");
  await flush();
  assert.deepEqual(calls, ["paneA"]);
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 1);
});

test("back and forward page commands for an unknown tab are a safe no-op", async () => {
  navigateFromPage("missing-tab", "back");
  navigateFromPage("missing-tab", "forward");
  await flush();
  assert.equal(takeEngineSwitchCounts().webkit_mouse_navigations, 0);
});

test("TabWebView routes back and forward page commands to navigateFromPage", () => {
  const source = readFileSync(new URL("../../components/window/TabWebView.tsx", import.meta.url), "utf8");
  assert.match(source, /else if \(command === "back" \|\| command === "forward"\) navigateFromPage\(tabId, command\);/);
});
