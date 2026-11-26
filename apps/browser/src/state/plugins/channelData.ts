import { withDeadline } from "../../lib/deadline";
import type { PluginManifest } from "../../lib/pluginManifest";
import { fetchRequestOf } from "./netRequest";
import { withoutFragment } from "../../lib/url";
import { minimizedUrl } from "../../lib/urlParts";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { activeTabId, isIncognitoProfile } from "../browser/model";
import type { Tab } from "../browser/types";
import { failure } from "../automation/automationMethods";
import { eligibleKind, isEligibleTab, lastFocusedEligibleWindow } from "../automation/automationWindows";
import { manifestInProfile } from "./profileScope";
import type { Body } from "../automation/controlSocket";
import { consentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { recentPluginGesture } from "./gestures";
import { hostFetch } from "./hostIo";
import { pluginPageOf } from "./pages";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { reveal } from "@ardia/core";
import { deletePluginSecret, getPluginSecret, secretSpace, setPluginSecret, type SecretOutcome } from "./secrets";
import { storageDelete, storageGet, storageKeys, storageSet, storageSpace, type StorageOutcome } from "./storage";
import { focusedWindowId } from "../browser/current";
import { ownValue } from "../../lib/decode";

export { FETCH_LIMITS } from "./netRequest";
const PAGE_TEXT_LIMIT = 200_000;
const READ_PAGE_DEADLINE_MS = 3000;
const MAX_REPLY_BYTES = 960 * 1024;


type Caller = { name: string; run: number };

const settled = <T,>(outcome: StorageOutcome<T> | SecretOutcome<T>): Body => (outcome.ok ? { result: outcome.value } : failure(outcome.code, outcome.message));

export function requestProfile(name: string, m: Pick<PluginManifest, "scope">, params: Record<string, unknown>): { ok: true; profileId: string | null } | { ok: false; message: string } {
  if (m.scope !== "profile") return { ok: true, profileId: null };
  const b = useBrowser.getState();
  const limited = ownValue(currentPlugins().records, name)?.profiles;
  const allowed = (id: string) => !!b.profiles[id] && (!limited || limited === "all" || limited.includes(id));
  if (params.profile !== undefined) {
    if (typeof params.profile !== "string" || !allowed(params.profile)) return { ok: false, message: "profile isn't a profile this plugin is on in." };
    return { ok: true, profileId: params.profile };
  }
  const focused = focusedWindowId();
  const front = focused ? b.windows[focused]?.profileId : undefined;
  const fallback = [front, b.settings.defaultProfileId, ...(Array.isArray(limited) ? limited : [])].find((id): id is string => typeof id === "string" && allowed(id));
  return fallback ? { ok: true, profileId: fallback } : { ok: false, message: "This plugin isn't on in any profile." };
}

export function callerProfile(name: string, m: Pick<PluginManifest, "scope">, params: Record<string, unknown>): { ok: true; profileId: string } | { ok: false; message: string } {
  const scoped = requestProfile(name, m, params);
  if (!scoped.ok) return scoped;
  if (scoped.profileId) return { ok: true, profileId: scoped.profileId };
  const b = useBrowser.getState();
  const usable = (id: unknown): id is string => typeof id === "string" && !!b.profiles[id] && !isIncognitoProfile(id);
  if (params.profile !== undefined) return usable(params.profile) ? { ok: true, profileId: params.profile } : { ok: false, message: "profile isn't one of your profiles." };
  const focused = focusedWindowId();
  const front = focused ? b.windows[focused]?.profileId : undefined;
  const id = [front, b.settings.defaultProfileId].find(usable);
  return id ? { ok: true, profileId: id } : { ok: false, message: "There's no profile to use." };
}

export function pluginWindow(name: string, m: Pick<PluginManifest, "scope">, params: Record<string, unknown>): { ok: true; windowId: string } | { ok: false; body: Body } {
  const s = useBrowser.getState();
  const inScope = (id: string) => eligibleKind(s, id) && !!manifestInProfile(currentPlugins(), name, s.windows[id]?.profileId ?? null);
  if (params.profile !== undefined) {
    const profile = callerProfile(name, m, params);
    if (!profile.ok) return { ok: false, body: failure("refused", profile.message) };
    const windowId = [...s.ui.focusOrder, ...s.windowOrder].find((id) => s.windows[id]?.profileId === profile.profileId && inScope(id));
    return windowId ? { ok: true, windowId } : { ok: false, body: failure("no_window", "There's no window in that profile.") };
  }
  const front = lastFocusedEligibleWindow(s);
  if (!front) return { ok: false, body: failure("no_window", "No window to use.") };
  return inScope(front) ? { ok: true, windowId: front } : { ok: false, body: failure("refused", "This plugin isn't on in the front window's profile.") };
}

export function storageMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> | Body {
  if (!m.permissions.storage) return failure("refused", `${method} needs the storage permission.`);
  const profile = requestProfile(c.name, m, params);
  if (!profile.ok) return failure("refused", profile.message);
  const space = storageSpace(c.name, profile.profileId);
  const consent = consentToken();
  const answered = <T,>(outcome: StorageOutcome<T>): Body => {
    if (!outcome.ok && outcome.closed) notePlugin("plugin_storage_cancels", consent);
    return settled(outcome);
  };
  if (method === "storage.get") return storageGet(space, params.key).then(answered);
  if (method === "storage.set") return storageSet(space, params.key, params.value).then((o) => (o.ok ? (notePlugin("plugin_storage_writes", consent), { result: { ok: true } }) : answered(o)));
  if (method === "storage.delete") return storageDelete(space, params.key).then((o) => (o.ok ? { result: { ok: true } } : answered(o)));
  return storageKeys(space).then(answered);
}

export function secretsMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> | Body {
  if (!m.permissions.secrets) return failure("refused", `${method} needs the secrets permission.`);
  const profile = requestProfile(c.name, m, params);
  if (!profile.ok) return failure("refused", profile.message);
  const space = secretSpace(c.name, profile.profileId);
  if (method === "secrets.get") return getPluginSecret(space, params.key).then((o) => (o.ok ? { result: o.value && reveal(o.value) } : settled(o)));
  if (method === "secrets.set") {
    const consent = consentToken();
    return setPluginSecret(space, params.key, params.value).then((o) => (o.ok ? (notePlugin("plugin_secret_writes", consent), { result: { ok: true } }) : settled(o)));
  }
  return deletePluginSecret(space, params.key).then((o) => (o.ok ? { result: { ok: true } } : settled(o)));
}

export async function netFetch(m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const request = fetchRequestOf(m, params);
  if ("code" in request) return failure(request.code, request.message);
  notePlugin("plugin_net_fetches");
  const answered = await hostFetch(request);
  if (!answered.ok) return failure("failed", answered.reason);
  const { ok: _ok, ...response } = answered;
  const reply = { result: response };
  if (new TextEncoder().encode(JSON.stringify(reply)).length > MAX_REPLY_BYTES) return failure("failed", "The response is too large for the plugin channel; use ardia.net.fetchStream for big answers.");
  return reply;
}

const READ_PAGE = `(() => {
  const text = (document.body ? document.body.innerText : "").slice(0, ${PAGE_TEXT_LIMIT});
  const selection = String(window.getSelection ? window.getSelection() : "").slice(0, 20000);
  post("result", JSON.stringify({ text, selection, lang: document.documentElement.lang || "" }));
})()`;

type PageRead = { text?: unknown; selection?: unknown; lang?: unknown };

type Gesture = NonNullable<ReturnType<typeof recentPluginGesture>>;
type Readable = { ok: true; tab: Tab } | { ok: false; body: Body };

export function readableTab(gesture: Gesture): Readable {
  const s = useBrowser.getState();
  if (!eligibleKind(s, gesture.windowId)) return { ok: false, body: failure("refused", "The page you used the plugin from is private or gone.") };
  const tabId = activeTabId(s, gesture.windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (!tab || !isEligibleTab(s, tab.id) || pluginPageOf(tab.url)) return { ok: false, body: failure("refused", "There's no page in that window the plugin may read.") };
  if (tab.id !== gesture.tabId || withoutFragment(tab.url) !== gesture.doc) return { ok: false, body: failure("refused", "The page changed since you used the plugin.") };
  return { ok: true, tab };
}

export async function readActivePage(c: Caller, m: PluginManifest): Promise<Body> {
  if (!m.permissions.activePage) return failure("refused", "tabs.readActivePage needs the activePage permission.");
  const gesture = recentPluginGesture(c.name);
  if (!gesture) return failure("refused", "tabs.readActivePage works only just after you use the plugin (a command, menu, toolbar button or its view).");
  const before = readableTab(gesture);
  if (!before.ok) return before.body;
  const web = webviews.get(before.tab.id);
  if (!web) return failure("failed", "That tab's page isn't loaded.");
  const consent = consentToken();
  const read = (await withDeadline(web.evaluate<PageRead>(READ_PAGE), READ_PAGE_DEADLINE_MS, null).catch(() => null)) as PageRead | null;
  if (!acceptsRun(c.name, c.run) || !activeManifest(currentPlugins(), c.name)?.permissions.activePage) return failure("refused", "The plugin stopped while the page was being read.");
  if (recentPluginGesture(c.name)?.id !== gesture.id) return failure("refused", "The page changed since you used the plugin.");
  const after = readableTab(gesture);
  if (!after.ok) return after.body;
  if (after.tab.id !== before.tab.id) return failure("refused", "The page changed since you used the plugin.");
  const tab = after.tab;
  if (!read || typeof read.text !== "string") return failure("failed", "The page didn't answer.");
  notePlugin("plugin_page_reads", consent);
  return {
    result: {
      tabId: tab.id,
      url: m.permissions.fullUrls ? tab.url : minimizedUrl(tab.url),
      title: tab.customTitle || tab.title,
      text: read.text,
      selection: typeof read.selection === "string" ? read.selection : "",
      lang: typeof read.lang === "string" ? read.lang.slice(0, 35) : "",
    },
  };
}
