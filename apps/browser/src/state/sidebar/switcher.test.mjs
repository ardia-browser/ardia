import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { activeTabId } from "../browser/model.ts";
import { sessionTabIds, switcherTabIds } from "../pins/recentTabs.ts";
import { shellNativeModules } from "../../test-native/index.ts";
import { useLifecycle } from "../tabs/sleepingTabs.ts";
import { sidebarUi } from "./sidebarUi.ts";
import { cancelSwitcher, closeSwitcherRow, commitSwitcher, moveSwitcher, subscribeSwitcherTabChanges, switcherStep, SHOW_AFTER_MS } from "./switcher.ts";

const S = () => useBrowser.getState();
const subscriptions = [];
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
afterEach(() => {
  cancelSwitcher();
  useLifecycle.setState({ discarded: {} });
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
});

function setup() {
  cancelSwitcher();
  S().hydrate({});
  S().updateSettings({ tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" });
  useLifecycle.setState({ discarded: {} });
  const work = S().createProfile({ name: "Work" });
  const window = S().createWindow({ url: "https://personal.example" });
  const personal = activeTabId(S(), window);
  const second = S().newTab(window, { url: "https://second.example", background: true });
  const other = S().newTab(window, { url: "https://work.example", profileId: work, background: true });
  for (const id of [second, other, personal]) S().activate(id);
  const now = Date.now() + 100;
  S().updateTab(personal, { lastActiveAt: now - 20, unseen: false });
  S().updateTab(second, { lastActiveAt: now - 30, unseen: false });
  S().updateTab(other, { lastActiveAt: now - 10, unseen: false });
  subscriptions.push(subscribeSwitcherTabChanges(window));
  return { work, window, personal, second, other };
}

test("default scope stays in the current profile and puts its active tab first", () => {
  const { window, personal, second } = setup();
  assert.equal(S().settings.tabSwitcherScope, "currentProfile");
  switcherStep(window, false);
  assert.deepEqual(sidebarUi().switcher.ids, [personal, second]);
  assert.equal(sidebarUi().switcher.scope, "currentProfile");
});

test("in-order switching keeps the current profile's sidebar order", () => {
  const { window, personal, second } = setup();
  S().updateSettings({ tabSwitcherOrder: "inOrder", tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  const switcher = sidebarUi().switcher;
  assert.equal(switcher.scope, "currentProfile");
  assert.deepEqual(switcher.ids, [personal, second]);
});

test("all profiles uses window MRU and commits across profiles only when released", () => {
  const { window, personal, other, work } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  assert.equal(sidebarUi().switcher.ids[1], other);
  assert.equal(activeTabId(S(), window), personal);
  assert.equal(S().windows[window].profileId, "default");
  commitSwitcher();
  assert.equal(activeTabId(S(), window), other);
  assert.equal(S().windows[window].profileId, work);
  switcherStep(window, false);
  commitSwitcher();
  assert.equal(activeTabId(S(), window), personal);
});

test("cycling and cancel leave selection and unloaded background pages alone", () => {
  const { window, personal, other } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  S().updateTab(other, { page: { kind: "idle" } });
  switcherStep(window, false);
  const ids = sidebarUi().switcher.ids;
  S().updateTab(personal, { lastActiveAt: Date.now() + 100 });
  S().newTab(window, { url: "https://later.example", background: true });
  moveSwitcher(1);
  assert.deepEqual(sidebarUi().switcher.ids, ids);
  cancelSwitcher();
  assert.equal(activeTabId(S(), window), personal);
  assert.equal(S().tabs[other].page.kind, "idle");
});

test("shared-data scope includes a linked profile and skips a separate profile", () => {
  const { window, personal, other } = setup();
  const linked = S().createProfile({ name: "Linked", shareWith: "default" });
  const tab = S().newTab(window, { url: "https://linked.example", profileId: linked, background: true });
  S().activate(tab);
  S().activate(personal);
  S().updateTab(tab, { lastActiveAt: Date.now() + 200 });
  S().updateSettings({ tabSwitcherScope: "sharedData" });
  switcherStep(window, false);
  assert.equal(sidebarUi().switcher.ids[1], tab);
  assert.ok(!sidebarUi().switcher.ids.includes(other));
  commitSwitcher();
  assert.equal(activeTabId(S(), window), tab);
  assert.equal(S().windows[window].profileId, linked);
});

test("closing the highlighted background profile row advances without switching profiles", async () => {
  const { window, other, second, personal } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  mock.timers.tick(SHOW_AFTER_MS);
  await closeSwitcherRow();
  assert.equal(activeTabId(S(), window), personal);
  assert.equal(S().windows[window].profileId, "default");
  assert.ok(!S().tabs[other]);
  assert.deepEqual(sidebarUi().switcher.ids, [personal, second]);
  assert.equal(sidebarUi().switcher.ids[sidebarUi().switcher.index], second);
  commitSwitcher();
  assert.equal(activeTabId(S(), window), second);
});

test("private windows and other windows never enter the candidates", () => {
  const { window, work } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  const regular = S().createWindow({ profileId: work, url: "https://elsewhere.example" });
  const privateWindow = S().createWindow({ kind: "private", url: "https://private.example" });
  const privateTab = activeTabId(S(), privateWindow);
  const privateSecond = S().newTab(privateWindow, { url: "https://private2.example", background: true });
  assert.deepEqual(switcherTabIds(S(), privateWindow, "allProfiles"), [privateTab, privateSecond]);
  const ids = sessionTabIds(S(), window, 0, S().settings.tabSwitcherScope);
  assert.ok(!ids.includes(privateTab));
  assert.ok(!ids.includes(activeTabId(S(), regular)));
  S().activate(privateSecond);
  S().activate(privateTab);
  switcherStep(privateWindow, false);
  assert.equal(sidebarUi().switcher.scope, "currentProfile");
  assert.deepEqual(sidebarUi().switcher.ids, [privateTab, privateSecond]);
});

test("backward wraps and closing the window cancels the selector", () => {
  const { window, second } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, true);
  assert.equal(sidebarUi().switcher.ids[sidebarUi().switcher.index], second);
  S().closeWindow(window);
  assert.equal(sidebarUi().switcher, null);
});

test("moving a candidate to another profile removes it in current-profile scope", () => {
  const { window, personal, second, work } = setup();
  switcherStep(window, false);
  S().moveTabToProfile(second, work, { background: true });
  const switcher = sidebarUi().switcher;
  assert.ok(switcher, "switcher stays open while candidates remain");
  assert.deepEqual(switcher.ids, [personal]);
});

test("moving a candidate to another window removes it before commit", () => {
  const { window, other } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  const destination = S().createWindow({ url: "https://destination.example" });
  switcherStep(window, false);
  S().moveTabsToWindow([other], destination);
  assert.ok(!sidebarUi().switcher.ids.includes(other));
  const selected = sidebarUi().switcher.ids[sidebarUi().switcher.index];
  commitSwitcher();
  assert.equal(activeTabId(S(), window), selected);
});

test("commit uses an explicit candidate ID rather than the highlighted index", () => {
  const { window, second } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  assert.notEqual(sidebarUi().switcher.ids[sidebarUi().switcher.index], second);
  commitSwitcher(second);
  assert.equal(activeTabId(S(), window), second);
  assert.equal(sidebarUi().switcher, null);
});

test("commit rejects tabs created after the candidate order froze", () => {
  const { window, personal } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  const later = S().newTab(window, { url: "https://later.example", background: true });
  commitSwitcher(later);
  assert.equal(activeTabId(S(), window), personal);
});

test("changing scope immediately narrows the frozen all-profile candidates", () => {
  const { window, personal, second } = setup();
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  S().updateSettings({ tabSwitcherScope: "currentProfile" });
  assert.deepEqual(sidebarUi().switcher.ids, [personal, second]);
  assert.equal(sidebarUi().switcher.scope, "currentProfile");
});

test("unloaded pages are excluded and sleeping candidates disappear before commit", () => {
  const { window, personal, second, other } = setup();
  S().updateTab(other, { page: { kind: "idle" } });
  assert.deepEqual(sessionTabIds(S(), window, 0, "allProfiles"), [personal, second]);
  S().updateTab(other, { page: { kind: "asleep" } });
  assert.ok(!sessionTabIds(S(), window, 0, "allProfiles").includes(other));
  S().activate(other);
  S().activate(personal);
  S().updateSettings({ tabSwitcherScope: "allProfiles" });
  switcherStep(window, false);
  assert.ok(sidebarUi().switcher.ids.includes(other));
  useLifecycle.setState({ discarded: { [other]: true } });
  assert.ok(!sidebarUi().switcher.ids.includes(other));
  commitSwitcher(other);
  assert.equal(activeTabId(S(), window), personal);
});

test("accepting a pending row-close warning does not close a tab moved to another window", async () => {
  const { window, personal, second } = setup();
  S().closeTab(second);
  S().updateSettings({ tabSwitcherScope: "allProfiles", warnBeforeClosingLastTab: true, newTabOpens: "page" });
  const destination = S().createWindow({ url: "https://destination.example" });
  switcherStep(window, false);
  moveSwitcher(-1);
  assert.equal(sidebarUi().switcher.ids[sidebarUi().switcher.index], personal);
  const confirm = shellNativeModules.ArdiaDialogs.confirm;
  let answer;
  shellNativeModules.ArdiaDialogs.confirm = () => new Promise((resolve) => { answer = resolve; });
  let closing;
  try {
    mock.timers.tick(SHOW_AFTER_MS);
    closing = closeSwitcherRow();
    assert.equal(typeof answer, "function");
    S().moveTabsToWindow([personal], destination);
    assert.equal(S().tabs[personal].windowId, destination);
    answer({ confirmed: true, suppressed: false });
    await closing;
    assert.equal(S().tabs[personal]?.windowId, destination);
    assert.ok(S().windows[destination].tabIds.includes(personal));
  } finally {
    answer?.({ confirmed: false, suppressed: false });
    await closing;
    shellNativeModules.ArdiaDialogs.confirm = confirm;
  }
});
