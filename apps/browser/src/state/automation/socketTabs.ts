import { refuseSyncedLinkChange } from "./workspaceSharedGuard";
import type { BrowserState } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import type { ClosedGroup, ClosedTab, ClosedWindow } from "../browser/types";
import { groupOf } from "../pins/tabGrouping";
import { splitOf } from "../splits/splits";
import { withLivePage } from "../tabs/livePage";
import { goBackAsking, goForwardAsking } from "../tabs/navigation";
import { liveOf } from "../tabs/tabLive";
import { recentlyClosedIn } from "../windows/recentlyClosedList";
import { eligibleKind, isEligibleTab, shownPage, windowTabIds } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { askWhereSeen } from "./socketAsk";
import { bool, id, obj, PROFILE, TAB, text, WINDOW } from "./socketSchema";
import { expect, now, profileArg, tabOf, windowOf, windowOrFocused } from "./socketTargets";
import { openableUrl } from "./workspaceOps";
import { OpError } from "./workspaceTargets";
import { t } from "../../lib/uiLanguage";


export function tabRow(s: BrowserState, tabId: string) {
  const t = s.tabs[tabId]!;
  const live = liveOf(tabId);
  return {
    id: tabId,
    window: t.windowId,
    profile: t.profileId,
    ...shownPage(t),
    customTitle: t.customTitle,
    customIcon: t.customIcon,
    pinned: t.pin?.as ?? null,
    tileFolder: t.pin?.as === "tile" ? (t.pin.folder?.id ?? null) : null,
    pinnedUrl: t.pinnedUrl,
    group: groupOf(s, tabId)?.id ?? null,
    split: splitOf(s, tabId)?.id ?? null,
    active: activeTabId(s, t.windowId) === tabId,
    muted: t.muted,
    zoom: t.zoom,
    page: t.page.kind,
    loading: live.isLoading,
    playingAudio: live.playingAudio,
    canGoBack: live.canGoBack,
    canGoForward: live.canGoForward,
    opener: t.openerId,
    createdAt: t.createdAt,
    lastActiveAt: t.lastActiveAt,
  };
}

function listTabs(params: Record<string, unknown>) {
  const s = now();
  const windows = params.window !== undefined ? [windowOf(params.window).id] : s.windowOrder.filter((w) => eligibleKind(s, w));
  const profile = params.profile !== undefined ? profileArg(params.profile) : null;
  return windows.flatMap((w) => windowTabIds(s, w)).filter((t) => !profile || s.tabs[t]!.profileId === profile).map((t) => tabRow(s, t));
}

function navigate(params: Record<string, unknown>) {
  const t = tabOf(params.tab);
  const url = openableUrl(params.url as string);
  if (typeof url !== "string") throw new OpError("refused", url.error);
  refuseSyncedLinkChange(t.id, t(`loading another page`));
  now().navigate(t.id, url || "ardia://newtab", { userInitiated: true });
  return tabRow(now(), t.id);
}

async function reload(params: Record<string, unknown>, call: SocketCall) {
  const t = tabOf(params.tab);
  if (await withLivePage(t.id, (page) => (params.bypassCache ? page.forceReload() : page.reload()), call.serving)) return { ok: true };
  call.stillServing();
  throw new OpError("failed", `Tab ${t.id} didn't reload: it has no page to reload, or its shared page couldn't be brought to it.`);
}

async function forward(params: Record<string, unknown>, call: SocketCall) {
  const t = tabOf(params.tab);
  refuseSyncedLinkChange(t.id, t(`going forward`));
  if (await goForwardAsking(t.id, call.serving)) return { ok: true };
  call.stillServing();
  throw new OpError("failed", `Tab ${t.id} didn't go forward: it has no page, or its shared page couldn't be brought to it.`);
}

async function back(params: Record<string, unknown>, call: SocketCall) {
  const t = tabOf(params.tab);
  refuseSyncedLinkChange(t.id, t(`going back`));
  if (await goBackAsking(t.id, call.serving, askWhereSeen(`Tab ${t.id} stayed on its page`, call))) return { ok: true };
  call.stillServing();
  throw new OpError("refused", `Tab ${t.id} stayed on its page: the page has changes that going back may lose and the user chose to stay, the page moved on meanwhile, or its shared page couldn't be brought to it.`);
}

function setPinnedUrl(params: Record<string, unknown>) {
  const t = tabOf(params.tab);
  if (!t.pin) throw new OpError("bad_request", `Tab ${t.id} isn't pinned.`);
  let url: string | undefined;
  if (params.url !== undefined) {
    const given = openableUrl(params.url as string);
    if (typeof given !== "string" || !given) throw new OpError("refused", typeof given === "string" ? t(`A pinned tab's home can't be a New Tab.`) : given.error);
    url = given;
  }
  now().setPinnedUrl(t.id, url);
  return tabRow(now(), t.id);
}

type Closed = ClosedTab | ClosedWindow | ClosedGroup;

function closedRow(c: Closed) {
  if (c.kind === "tab") return { id: c.id, kind: c.kind, closedAt: c.closedAt, url: c.tab.url, title: c.tab.customTitle || c.tab.title, profile: c.tab.profileId, group: c.group?.name ?? null };
  if (c.kind === "window") return { id: c.id, kind: c.kind, closedAt: c.closedAt, profile: c.window.profileId, tabs: c.tabs.length, groups: c.groups.length };
  return { id: c.id, kind: c.kind, closedAt: c.closedAt, name: c.group.name, tabs: c.tabs.length, profile: c.tabs[0]?.profileId ?? null };
}

function closedOf(params: Record<string, unknown>) {
  const s = now();
  const list = recentlyClosedIn(s, windowOrFocused(params.window, ["normal"]));
  return [...list.tabs, ...list.windows, ...list.groups].filter((c) => c.kind !== "tab" || !isIncognitoProfile(c.tab.profileId));
}

const closedList = (params: Record<string, unknown>) => closedOf(params).sort((a, b) => b.closedAt - a.closedAt).map(closedRow);

function closedRestore(params: Record<string, unknown>) {
  const s = now();
  const entry = [...s.closedTabs, ...s.closedWindows, ...s.closedGroups].find((c) => c.id === params.id);
  if (!entry || (entry.kind === "tab" && isIncognitoProfile(entry.tab.profileId))) throw new OpError("no_window", `There's no closed tab, window or group ${String(params.id)}.`);
  const windowId = params.window !== undefined ? windowOf(params.window, ["normal"]).id : null;
  const before = new Set(Object.keys(s.tabs));
  now().restoreClosed(entry.id, windowId);
  const after = now();
  const opened = Object.keys(after.tabs).filter((t) => !before.has(t) && isEligibleTab(after, t));
  expect(opened.length > 0 || ![...after.closedTabs, ...after.closedWindows, ...after.closedGroups].some((c) => c.id === entry.id), `${entry.id} wasn't restored.`);
  return { tabs: opened };
}

function closedClear(params: Record<string, unknown>) {
  const w = windowOrFocused(params.window, ["normal"]);
  const listed = closedOf(params).length;
  now().clearRecentlyClosed(w.id);
  const left = closedOf({ window: w.id }).length;
  expect(left === 0, `${left} recently closed item${left === 1 ? " is" : "s are"} still there.`);
  return { cleared: listed };
}

export const TAB_METHODS: MethodSpec[] = [
  { name: "tabs.list", mutates: false, description: t(`Every tab the command may use, with its pin, group, split, page state and times`), params: obj({ window: WINDOW, profile: PROFILE }), result: "[tab]", run: listTabs },
  { name: "tabs.get", mutates: false, description: t(`One tab`), params: obj({ tab: TAB }, ["tab"]), result: "tab", run: (p) => tabRow(now(), tabOf(p.tab).id) },
  { name: "tabs.navigate", mutates: true, description: t(`Load a URL in a tab, as typing it in the address bar does`), params: obj({ tab: TAB, url: text("http, https or file URL, about:blank or ardia://history, bookmarks, downloads, newtab") }, ["tab", "url"]), result: "tab", run: navigate },
  { name: "tabs.reload", mutates: true, description: t(`Reload a tab's page`), params: obj({ tab: TAB, bypassCache: bool(t(`Reload without the cache`)) }, ["tab"]), result: "{ok}", run: reload },
  { name: "tabs.back", mutates: true, description: t(`Go back in a tab's history; when that leaves a page with unsaved changes, the reply waits for the user's answer`), params: obj({ tab: TAB }, ["tab"]), result: "{ok}", run: back },
  { name: "tabs.forward", mutates: true, description: t(`Go forward in a tab's history`), params: obj({ tab: TAB }, ["tab"]), result: "{ok}", run: forward },
  {
    name: "tabs.duplicate",
    mutates: true,
    description: t(`Duplicate a tab beside it`),
    params: obj({ tab: TAB }, ["tab"]),
    result: "tab",
    run: (p) => {
      const copy = now().duplicateTab(tabOf(p.tab).id);
      expect(!!copy, t(`the tab wasn't duplicated.`));
      return tabRow(now(), copy!);
    },
  },
  { name: "tabs.setPinnedUrl", mutates: true, description: t(`Make a pinned tab's home its current page, or the URL given`), params: obj({ tab: TAB, url: text(t(`The new home; the tab's current page when left out`)) }, ["tab"]), result: "tab", run: setPinnedUrl },
  {
    name: "tabs.returnToPinnedUrl",
    mutates: true,
    description: t(`Take a pinned tab back to its home`),
    params: obj({ tab: TAB }, ["tab"]),
    result: "tab",
    run: (p) => {
      const t = tabOf(p.tab);
      if (!t.pin) throw new OpError("bad_request", `Tab ${t.id} isn't pinned.`);
      now().returnToPinnedUrl(t.id);
      return tabRow(now(), t.id);
    },
  },
  {
    name: "closed.list",
    mutates: false,
    description: t(`Recently closed tabs, windows and groups of a window's profile, newest first, as its History menu lists them`),
    params: obj({ window: id(t(`A window; the last focused main window when left out`)) }),
    result: t(`[{id, kind, closedAt, …}]`),
    run: closedList,
  },
  { name: "closed.restore", mutates: true, description: t(`Reopen a closed tab, window or group`), params: obj({ id: id(t(`An id from closed.list`)), window: WINDOW }, ["id"]), result: "{tabs}", run: closedRestore },
  {
    name: "closed.clear",
    mutates: true,
    description: t(`Forget what closed.list lists for the same window: a window's profile's recently closed tabs, windows and groups`),
    params: obj({ window: id(t(`A window; the last focused main window when left out`)) }),
    result: "{cleared}",
    run: closedClear,
  },
];
