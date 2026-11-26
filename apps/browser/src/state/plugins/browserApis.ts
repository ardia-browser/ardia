import { hasLevel, type PluginManifest } from "../../lib/pluginManifest";
import { pluginWebUrl } from "../../lib/pluginWebUrl";
import { useBrowser } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import type { BookmarkNode } from "../browser/types";
import { switchProfile } from "../browser/actions";
import { failure } from "../automation/automationMethods";
import { isEligibleTab, lastFocusedEligibleWindow } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { addBookmark, removeBookmark, updateBookmark, moveBookmark } from "../bookmarks/actions";
import { bookmarkRoots, folderChildren, ownerOfBookmark } from "../bookmarks/bookmarks";
import { historyOf } from "../history/history";
import { mediaCommand, useMedia } from "../media/media";
import { openSplitPane } from "../splits/actions";
import { notePlugin } from "../telemetry/pluginCounts";
import { callerProfile, pluginWindow } from "./channelData";
import { manifestInProfile } from "./profileScope";
import { currentPlugins } from "./store";

type Caller = { name: string; run: number };
type Shown = { id: string; parentId: string | null; title: string; url?: string; children?: Shown[] };

const MAX_RESULTS = 500;
const MAX_DEPTH = 8;
const MEDIA_ACTIONS = { play: "play", pause: "pause", toggle: "toggle", next: "next", previous: "previous", mute: "mute", unmute: "unmute", seek: "seekTo" } as const;

const limitOf = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, MAX_RESULTS) : fallback);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

function profileFor(c: Caller, m: PluginManifest, params: Record<string, unknown>): { ok: true; id: string } | { ok: false; body: Body } {
  const found = callerProfile(c.name, m, params);
  return found.ok ? { ok: true, id: found.profileId } : { ok: false, body: failure("refused", found.message) };
}

const tabInScope = (c: Caller, m: PluginManifest, tabId: string) => {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || !isEligibleTab(s, tabId) || isIncognitoProfile(tab.profileId)) return false;
  return m.scope !== "profile" || !!manifestInProfile(currentPlugins(), c.name, tab.profileId);
};

function shown(node: BookmarkNode, depth: number): Shown {
  if (node.kind === "url") return { id: node.id, parentId: node.parentId, title: node.title, url: node.url };
  const b = useBrowser.getState().bookmarks;
  const children = depth < MAX_DEPTH ? folderChildren(b, node.id).slice(0, MAX_RESULTS).map((child) => shown(child, depth + 1)) : [];
  return { id: node.id, parentId: node.parentId, title: node.title, children };
}

export function bookmarksMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body {
  const writes = method !== "bookmarks.list" && method !== "bookmarks.search";
  if (!hasLevel(m.permissions, "bookmarks", writes ? "write" : "read")) return failure("refused", `${method} needs bookmarks: ${writes ? "write" : "read"}.`);
  const profile = profileFor(c, m, params);
  if (!profile.ok) return profile.body;
  const profileId = profile.id;
  const s = useBrowser.getState();
  const roots = bookmarkRoots(s, profileId);
  const owned = (id: unknown): id is string => typeof id === "string" && ownerOfBookmark(s, id) === profileId;
  notePlugin("plugin_bookmark_calls");
  if (method === "bookmarks.list") {
    const parent = params.parentId;
    if (parent !== undefined && !owned(parent)) return failure("bad_request", "parentId isn't a folder in this profile.");
    const ids = parent ? [parent as string] : roots ? [roots.bar, roots.other] : [];
    return { result: { bookmarks: ids.flatMap((id) => (s.bookmarks.nodes[id] ? [shown(s.bookmarks.nodes[id]!, parent ? 0 : 1)] : [])) } };
  }
  if (method === "bookmarks.search") {
    const query = (text(params.query, 200) ?? "").toLowerCase();
    const limit = limitOf(params.limit, 50);
    const found = Object.values(s.bookmarks.nodes).filter((n) => n.kind === "url" && ownerOfBookmark(s, n.id) === profileId && (!query || n.title.toLowerCase().includes(query) || n.url.toLowerCase().includes(query)));
    return { result: { bookmarks: found.slice(0, limit).map((n) => shown(n, MAX_DEPTH)) } };
  }
  if (method === "bookmarks.remove") {
    if (!owned(params.id) || params.id === roots?.bar || params.id === roots?.other) return failure("bad_request", "id isn't a bookmark this plugin may remove.");
    removeBookmark(params.id);
    return { result: { ok: true } };
  }
  const url = params.url === undefined ? undefined : pluginWebUrl(params.url);
  if (url && "problem" in url) return failure("bad_request", `url ${url.problem}.`);
  const title = text(params.title, 500);
  if (method === "bookmarks.create") {
    if (!title) return failure("bad_request", "bookmarks.create needs a title.");
    if (!url) return failure("bad_request", "bookmarks.create needs a url; Ardia's folders come from Ardia.");
    const parentId = params.parentId === undefined ? roots?.other : owned(params.parentId) ? params.parentId : null;
    if (!parentId) return failure("bad_request", "parentId isn't a folder in this profile.");
    const index = typeof params.index === "number" && Number.isInteger(params.index) && params.index >= 0 ? params.index : undefined;
    const id = addBookmark({ profileId, url: url.url, title, parentId, ...(index !== undefined ? { index } : {}) });
    const made = useBrowser.getState().bookmarks.nodes[id];
    return made ? { result: shown(made, MAX_DEPTH) } : failure("failed", "The bookmark wasn't added.");
  }
  if (!owned(params.id)) return failure("bad_request", "id isn't a bookmark in this profile.");
  const id = params.id;
  updateBookmark(id, { ...(title !== undefined ? { title } : {}), ...(url ? { url: url.url } : {}) });
  if (params.parentId !== undefined) {
    if (!owned(params.parentId)) return failure("bad_request", "parentId isn't a folder in this profile.");
    moveBookmark(id, params.parentId, typeof params.index === "number" ? params.index : undefined);
  }
  const node = useBrowser.getState().bookmarks.nodes[id];
  return node ? { result: shown(node, MAX_DEPTH) } : failure("failed", "The bookmark is gone.");
}

export function historyMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body {
  if (!hasLevel(m.permissions, "history", "read")) return failure("refused", `${method} needs history: read.`);
  const profile = profileFor(c, m, params);
  if (!profile.ok) return profile.body;
  const profileId = profile.id;
  notePlugin("plugin_history_calls");
  const list = historyOf(useBrowser.getState(), profileId);
  const query = method === "history.search" ? (text(params.text, 200) ?? "").toLowerCase() : "";
  const since = typeof params.since === "number" ? params.since : 0;
  const until = typeof params.until === "number" ? params.until : Infinity;
  const limit = limitOf(params.limit, method === "history.recent" ? 20 : 100);
  const items = [];
  for (const entry of list) {
    if (entry.lastVisit < since || entry.lastVisit > until) continue;
    if (query && !entry.title.toLowerCase().includes(query) && !entry.url.toLowerCase().includes(query)) continue;
    items.push({ url: entry.url, title: entry.title, lastVisitedAt: entry.lastVisit, visitCount: entry.visits });
    if (items.length >= limit) break;
  }
  return { result: { items: items.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt) } };
}

export function profilesMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body {
  const writes = method === "profiles.switch";
  if (!hasLevel(m.permissions, "profiles", writes ? "write" : "read")) return failure("refused", `${method} needs profiles: ${writes ? "write" : "read"}.`);
  const s = useBrowser.getState();
  const found = profileFor(c, m, params);
  if (!found.ok) return found.body;
  const current = found.id;
  notePlugin("plugin_profile_calls");
  const visible = s.profileOrder.filter((id) => s.profiles[id] && !isIncognitoProfile(id) && (m.scope !== "profile" || !!manifestInProfile(currentPlugins(), c.name, id)));
  const row = (id: string) => ({ id, name: s.profiles[id]!.name, ...(s.profiles[id]!.icon ? { icon: s.profiles[id]!.icon! } : {}), color: String(s.profiles[id]!.color), current: id === current });
  if (method === "profiles.list") return { result: { profiles: visible.map(row) } };
  if (method === "profiles.current") return { result: row(current) };
  const target = params.profile;
  if (typeof target !== "string" || !visible.includes(target)) return failure("bad_request", "profile isn't one of your profiles.");
  const windowId = lastFocusedEligibleWindow(s);
  if (!windowId) return failure("no_window", "No window to switch.");
  switchProfile(windowId, target);
  return { result: { ok: true } };
}

export function mediaMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body {
  const controls = method === "media.control";
  if (!hasLevel(m.permissions, "media", controls ? "control" : "read")) return failure("refused", `${method} needs media: ${controls ? "control" : "read"}.`);
  const s = useBrowser.getState();
  const sessions = useMedia.getState().sessions;
  const asked = params.profile !== undefined ? profileFor(c, m, params) : null;
  if (asked && !asked.ok) return asked.body;
  const reachable = (tabId: string) => tabInScope(c, m, tabId) && (!asked || s.tabs[tabId]?.profileId === asked.id);
  if (!controls) {
    const rows = Object.entries(sessions).flatMap(([tabId, session]) => {
      if (!reachable(tabId)) return [];
      return [{ tabId, title: session.title ?? "", ...(session.artist ? { artist: session.artist } : {}), ...(session.album ? { album: session.album } : {}), playing: session.playbackState === "playing", muted: s.tabs[tabId]?.muted === true, ...(typeof session.duration === "number" ? { duration: session.duration } : {}) }];
    });
    return { result: { sessions: rows } };
  }
  const tabId = params.tabId;
  const action = typeof params.action === "string" && Object.hasOwn(MEDIA_ACTIONS, params.action) ? (params.action as keyof typeof MEDIA_ACTIONS) : null;
  if (typeof tabId !== "string" || !reachable(tabId) || !sessions[tabId]) return failure("bad_request", "tabId isn't a tab playing media.");
  if (!action) return failure("bad_request", `action is one of ${Object.keys(MEDIA_ACTIONS).join(", ")}.`);
  notePlugin("plugin_media_controls");
  if (action === "mute" || action === "unmute") useBrowser.getState().setMuted([tabId], action === "mute");
  else if (action === "seek") {
    if (typeof params.value !== "number" || !Number.isFinite(params.value) || params.value < 0) return failure("bad_request", "seek needs a value in seconds.");
    mediaCommand(tabId, "seekTo", params.value);
  } else mediaCommand(tabId, MEDIA_ACTIONS[action] as Parameters<typeof mediaCommand>[1]);
  return { result: { ok: true } };
}

const v3Intents = (m: PluginManifest): readonly string[] => (m.v3.permissions?.state && typeof m.v3.permissions.state === "object" ? (m.v3.permissions.state.intents ?? []) : []);

export function intentMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body {
  if (!v3Intents(m).includes(method)) return failure("refused", `${method} needs ${method} in permissions.state.intents.`);
  const s = useBrowser.getState();
  const target = pluginWindow(c.name, m, params);
  if (!target.ok) return target.body;
  const windowId = target.windowId;
  const url = typeof params.url === "string" ? pluginWebUrl(params.url) : undefined;
  if (url && "problem" in url) return failure("bad_request", `url ${url.problem}.`);
  if (method === "peek.open") {
    if (!url) return failure("bad_request", "peek.open needs a url.");
    const source = activeTabId(s, windowId);
    if (!source || !tabInScope(c, m, source)) return failure("refused", "There's no page to peek from.");
    notePlugin("plugin_peek_intents");
    return { result: { ok: !!s.openPeek(source, url.url) } };
  }
  const urls = Array.isArray(params.urls) ? params.urls.slice(0, 3).map(pluginWebUrl) : url ? [url] : [];
  if (urls.some((u) => "problem" in u)) return failure("bad_request", "urls must be http or https addresses.");
  const tabs = Array.isArray(params.tabs) ? params.tabs.filter((t): t is string => typeof t === "string" && tabInScope(c, m, t) && s.tabs[t]?.windowId === windowId).slice(0, 3) : [];
  const side = ["left", "right", "top", "bottom"].includes(params.side as string) ? (params.side as "left" | "right" | "top" | "bottom") : undefined;
  notePlugin("plugin_split_intents");
  const opened = [
    ...tabs.map((tabId) => openSplitPane(windowId, { tabId, ...(side ? { side } : {}) })),
    ...urls.map((u) => openSplitPane(windowId, { url: (u as { url: string }).url, ...(side ? { side } : {}) })),
  ].filter((id): id is string => !!id);
  return { result: { ok: opened.length > 0, tabs: opened } };
}
