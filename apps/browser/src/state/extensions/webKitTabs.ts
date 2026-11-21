import { replyToWebKitTabs, setWebKitTabLayout, type WebKitTabLayout, type WebKitTabsRequest } from "../../platform/extensions";
import type { StripState } from "../../platform/tabs";
import { focus, openWindow } from "../browser/actions";
import { changedIds } from "../browser/changes";
import { activeTabId, engineProfile, incognitoOriginal, isIncognitoProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { isPeekTab } from "../peek/peek";
import { asAdoptId } from "../tabs/adoptIds";
import { chromeChanged } from "../tabs/liveTabs";
import { errorText } from "../../lib/errors";
import { extensionProfile, readyTabOf, useExtensions } from "./store";

type Request<O extends WebKitTabsRequest["op"]> = Extract<WebKitTabsRequest, { op: O }>;
type Reply = { tabId?: string; windowId?: string };

const CHROMIUM_SOURCES = 3;
const store = () => useBrowser.getState();
const fail = (message: string): never => {
  throw new Error(message);
};

export function answerWebKitTabs(request: WebKitTabsRequest) {
  let reply: Reply & { error?: string };
  try {
    reply = run(request) ?? {};
  } catch (error) {
    reply = { error: errorText(error) };
  }
  sendLayout();
  void replyToWebKitTabs(request.request, reply).catch(() => {});
}

function run(request: WebKitTabsRequest): Reply | undefined {
  switch (request.op) {
    case "close":
      for (const id of request.tabIds) if (store().tabs[id]) store().closeTab(id);
      return;
    case "activate":
      return void store().activate(tabOf(request.tabId));
    case "opener":
      return void store().updateTab(tabOf(request.tabId), { openerId: request.openerId && store().tabs[request.openerId] ? request.openerId : null });
    case "arrange":
      return arrange(request);
    case "duplicate":
      return duplicate(request);
    case "create":
      return create(request);
    case "createWindow":
      return createWindow(request);
    case "closeWindow":
      return void (store().windows[request.windowId] ? store().closeWindow(request.windowId) : fail(`No window with id: ${request.windowId}.`));
    case "focusWindow":
      return void (store().windows[request.windowId] ? focus(request.windowId) : fail(`No window with id: ${request.windowId}.`));
  }
}

const tabOf = (id: string) => (store().tabs[id] ? id : fail(`No tab with id: ${id}.`));

const browsers = new Map<string, number>();
const browserOf = (key: string) => {
  let id = browsers.get(key);
  if (id === undefined) browsers.set(key, (id = browsers.size + 1));
  return id;
};

function strip(s: BrowserState, windowId: string, order: Request<"arrange">["before"]): StripState {
  const w = s.windows[windowId]!;
  const active = new Set(Object.values(w.activeTabIds));
  const first = order.find((t) => s.tabs[t.key]);
  return {
    strip: -1,
    window: -1,
    appWindow: windowId,
    profile: first ? engineProfile(s, s.tabs[first.key]!.profileId) : "",
    tabs: order.map((t, index) => ({ key: t.key, browser: browserOf(t.key), index, active: active.has(t.key), pinned: t.pinned })),
  };
}

function arrange({ windowId, before, after }: Request<"arrange">): Reply | undefined {
  const s = store();
  if (!s.windows[windowId]) fail(`No window with id: ${windowId}.`);
  const seen = new Set(Object.keys(s.tabs));
  const next = chromeChanged(s, strip(s, windowId, before), strip(s, windowId, after), { seen, pending: { arranged: new Set(), active: true } });
  if (next !== s) useBrowser.setState(next);
  return undefined;
}

function duplicate({ tabId, active }: Request<"duplicate">): Reply {
  const s = store();
  const copy = s.duplicateTab(tabOf(tabId)) ?? fail("The tab can't be duplicated.");
  if (!active) {
    const source = s.tabs[tabId]!;
    if (activeTabId(store(), source.windowId) === copy) store().activate(tabId);
  }
  return { tabId: copy, windowId: store().tabs[copy]?.windowId };
}

function windowFor(s: BrowserState, request: { windowId?: string; nearTabId?: string; profile: string; private: boolean }): string | undefined {
  if (request.windowId && s.windows[request.windowId]) return request.windowId;
  const near = request.nearTabId ? s.tabs[request.nearTabId] : undefined;
  if (near && s.windows[near.windowId]) return near.windowId;
  return s.ui.focusOrder.find((id) => {
    const w = s.windows[id];
    return !!w && w.kind !== "small" && (w.kind === "private") === request.private && extensionProfile(s, id) === request.profile;
  });
}

function create(request: Request<"create">): Reply {
  const s = store();
  const windowId = windowFor(s, request) ?? fail("No window to open the tab in.");
  const w = s.windows[windowId]!;
  const near = request.nearTabId ? s.tabs[request.nearTabId] : undefined;
  const profileId = near?.profileId ?? w.profileId;
  const before = request.beforeId ? w.tabIds.indexOf(request.beforeId) : -1;
  const after = request.afterId ? w.tabIds.indexOf(request.afterId) : -1;
  const anchor = before >= 0 ? before : after >= 0 ? after + 1 : -1;
  const tabId = s.newTab(windowId, {
    url: request.url,
    adoptId: asAdoptId(request.adoptId),
    background: !request.active,
    openerId: request.openerId && s.tabs[request.openerId] ? request.openerId : undefined,
    profileId,
    pinned: request.pinned || undefined,
    index: anchor >= 0 ? anchor : undefined,
  });
  return { tabId: tabId || undefined, windowId };
}

function createWindow(request: Request<"createWindow">): Reply {
  const s = store();
  const moving = request.tabIds.filter((id) => s.tabs[id]);
  const near = request.nearTabId ? s.tabs[request.nearTabId] : moving[0] ? s.tabs[moving[0]] : undefined;
  const background = !request.focused;
  let windowId: string | undefined;
  let tabId: string | undefined = moving[0];
  if (moving.length) windowId = s.moveTabsToWindow(moving, null, { background });
  else {
    const home = windowFor(s, request);
    const sourceProfile = near?.profileId ?? (home ? s.windows[home]!.profileId : undefined);
    const opening = { url: request.urls[0], adoptId: asAdoptId(request.adoptIds[0]), background };
    windowId = request.private
      ? openWindow({ ...opening, kind: "private", profileId: privateOriginal(s, sourceProfile, request.profile) })
      : openWindow({ ...opening, profileId: sourceProfile });
    tabId = windowId ? activeTabId(store(), windowId) : undefined;
  }
  if (!windowId) fail("The window couldn't be opened.");
  const profileId = store().windows[windowId!]!.profileId;
  request.urls.forEach((url, i) => {
    if (!moving.length && i === 0) return;
    store().newTab(windowId!, { url, adoptId: asAdoptId(request.adoptIds[i]), background: true, profileId });
  });
  return { tabId, windowId };
}

function privateOriginal(s: BrowserState, sourceProfile: string | undefined, engine: string): string | undefined {
  if (sourceProfile && isIncognitoProfile(sourceProfile)) return incognitoOriginal(sourceProfile);
  return s.profileOrder.find((id) => engineProfile(s, id) === engine);
}

export function webKitTabLayout(s: BrowserState): WebKitTabLayout {
  const windows: WebKitTabLayout["windows"] = [];
  const openers: Record<string, string> = {};
  const chromiumTabs: Record<string, string[]> = {};
  for (const id of s.windowOrder) {
    const w = s.windows[id];
    if (!w) continue;
    const keys = w.tabIds.filter((t) => s.tabs[t] && !isPeekTab(s, t));
    const pinned = keys.filter((t) => s.tabs[t]!.pin);
    windows.push({ id, tabs: [...pinned, ...keys.filter((t) => !s.tabs[t]!.pin)], pinned });
    const active = new Set(Object.values(w.activeTabIds));
    for (const t of [...keys.filter((k) => active.has(k)), ...keys.filter((k) => !active.has(k))]) {
      const tab = s.tabs[t]!;
      if (tab.openerId) openers[t] = tab.openerId;
      const profile = engineProfile(s, tab.profileId);
      const sources = (chromiumTabs[profile] ??= []);
      if (sources.length < CHROMIUM_SOURCES && tabEngine(s, t) === "chromium" && readyTabOf(t)) sources.push(t);
    }
  }
  return { windows, openers, focus: s.ui.focusOrder.filter((id) => s.windows[id]), chromiumTabs };
}

const reshaped = (s: BrowserState, prev: BrowserState) =>
  s.windows !== prev.windows ||
  s.windowOrder !== prev.windowOrder ||
  s.ui.focusOrder !== prev.ui.focusOrder ||
  changedIds(s.tabs, prev.tabs).some((id) => {
    const a = s.tabs[id];
    const b = prev.tabs[id];
    return !a || !b || a.windowId !== b.windowId || !!a.pin !== !!b.pin || a.openerId !== b.openerId || a.engine !== b.engine || a.profileId !== b.profileId;
  });

const anyExtension = () => Object.values(useExtensions.getState().lists).some((list) => list.some((x) => x.enabled));

let started = false;
let sent = "";
let queued = false;

function sendLayout() {
  if (!anyExtension()) return;
  const layout = webKitTabLayout(store());
  const text = JSON.stringify(layout);
  if (text === sent) return;
  sent = text;
  void setWebKitTabLayout(layout).catch(() => {
    sent = "";
  });
}

function push() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    sendLayout();
  });
}

export function startWebKitTabs() {
  if (started) return;
  started = true;
  useBrowser.subscribeTo(["windows", "windowOrder", "ui", "tabs"], (s, prev) => {
    if (reshaped(s, prev)) push();
  });
  useExtensions.subscribe((e, prev) => {
    if (e.lists !== prev.lists) push();
  });
  push();
}
