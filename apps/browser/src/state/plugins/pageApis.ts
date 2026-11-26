import { withDeadline } from "../../lib/deadline";
import { isFields } from "../../lib/decode";
import type { PluginManifest } from "../../lib/pluginManifest";
import { pageReadScript } from "../../lib/pluginPageRead";
import { withoutFragment } from "../../lib/url";
import { byteLength } from "./stateEventPacking";
import { minimizedUrl } from "../../lib/urlParts";
import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import type { Tab } from "../browser/types";
import { failure } from "../automation/automationMethods";
import { isEligibleTab } from "../automation/automationWindows";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { readableTab } from "./channelData";
import { recentPluginGesture } from "./gestures";
import { pluginPageOf } from "./pages";
import { postToContent } from "./pageWorlds";
import { acceptsRun } from "./process";
import { manifestInProfile } from "./profileScope";
import { activeManifest, currentPlugins } from "./store";

type Caller = { name: string; run: number };
type Lease = { url: string; document: string; profileId: string };
type Grant = { kind: "gesture"; id: number } | { kind: "lease"; lease: Lease };

const READ_DEADLINE_MS = 4000;
const MAX_LEASES = 8;
const leases = new Map<string, Map<string, Lease>>();

function tabReadable(plugin: string, tab: Tab | undefined): tab is Tab {
  const s = useBrowser.getState();
  const m = activeManifest(currentPlugins(), plugin);
  if (!m || !tab || !isEligibleTab(s, tab.id) || pluginPageOf(tab.url)) return false;
  return m.scope !== "profile" || !!manifestInProfile(currentPlugins(), plugin, tab.profileId);
}

export async function grantTabLease(plugin: string, tabId: string, consent: ConsentToken | null): Promise<boolean> {
  const tab = useBrowser.getState().tabs[tabId];
  if (!activeManifest(currentPlugins(), plugin)?.permissions.multiTab || !tabReadable(plugin, tab)) return false;
  const document = await webviews.get(tabId)?.pluginDocument().catch(() => null);
  const now = useBrowser.getState().tabs[tabId];
  if (!document || !tabReadable(plugin, now) || now.url !== tab.url) return false;
  const held = leases.get(plugin) ?? new Map<string, Lease>();
  if (!held.has(tabId) && held.size >= MAX_LEASES) held.delete(held.keys().next().value!);
  held.set(tabId, { url: withoutFragment(now.url), document, profileId: now.profileId });
  leases.set(plugin, held);
  notePlugin("plugin_tab_leases", consent);
  return true;
}

export const leasedTabsOf = (plugin: string) => [...(leases.get(plugin)?.keys() ?? [])];

export function revokeTabLease(plugin: string, tabId?: string) {
  if (tabId === undefined) return void leases.delete(plugin);
  leases.get(plugin)?.delete(tabId);
}

function leaseHolds(plugin: string, tabId: string, lease: Lease): boolean {
  const tab = useBrowser.getState().tabs[tabId];
  const ok = leases.get(plugin)?.get(tabId) === lease && tabReadable(plugin, tab) && withoutFragment(tab.url) === lease.url && tab.profileId === lease.profileId;
  if (!ok) revokeTabLease(plugin, tabId);
  return ok;
}

type Read = { text?: unknown; markdown?: unknown; selection?: unknown; lang?: unknown; metadata?: unknown; headings?: unknown; links?: unknown; forms?: unknown };

const flag = (params: Record<string, unknown>, key: string) => params[key] === true;

export const READ_REPLY_BYTES = 900 * 1024;

function cutToBytes(text: string, max: number): string {
  if (max <= 0) return "";
  let out = text;
  let size = byteLength(out);
  while (size > max && out.length) {
    let cut = Math.max(0, Math.floor(out.length * (max / size) * 0.98));
    const unit = out.charCodeAt(cut - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) cut--;
    out = out.slice(0, cut);
    size = byteLength(out);
  }
  return out;
}

const READ_FIELD_BYTES = { url: 8 * 1024, title: 4 * 1024, selection: 64 * 1024, lang: 64 } as const;

export function fittedRead(result: Record<string, unknown>, max = READ_REPLY_BYTES): Record<string, unknown> {
  const out = { ...result };
  for (const [key, cap] of Object.entries(READ_FIELD_BYTES)) {
    const value = out[key];
    if (typeof value === "string" && byteLength(value) > cap) out[key] = cutToBytes(value, cap);
  }
  const over = () => byteLength(JSON.stringify(out)) - max;
  for (const key of ["markdown", "text"] as const) {
    const value = out[key];
    if (over() <= 0) return out;
    if (typeof value === "string") out[key] = cutToBytes(value, byteLength(JSON.stringify(value)) - over() - 1024);
  }
  if (over() > 0 && out.screenshot) {
    delete out.screenshot;
    out.screenshotOmitted = true;
  }
  for (const key of ["forms", "links", "headings"] as const) if (over() > 0 && Array.isArray(out[key])) out[key] = [];
  if (over() > 0 && out.metadata) delete out.metadata;
  for (const key of ["markdown", "selection", "text"] as const) if (over() > 0 && typeof out[key] === "string") out[key] = "";
  return over() > 0 ? { tabId: out.tabId, url: cutToBytes(String(out.url ?? ""), 1024), title: cutToBytes(String(out.title ?? ""), 512), text: "", lang: "" } : out;
}

export function minimizedMarkdown(markdown: string): string {
  let out = "";
  let at = 0;
  for (let open = markdown.indexOf("](", at); open >= 0; open = markdown.indexOf("](", at)) {
    let depth = 1;
    let end = open + 2;
    while (end < markdown.length && depth > 0 && !/\s/.test(markdown[end]!)) {
      if (markdown[end] === "(") depth++;
      else if (markdown[end] === ")") depth--;
      if (depth > 0) end++;
    }
    const url = markdown.slice(open + 2, end);
    out += markdown.slice(at, open + 2) + (/^https?:\/\//i.test(url) ? minimizedUrl(url) : url);
    at = end;
  }
  return out + markdown.slice(at);
}

function grantHolds(c: Caller, tab: Tab, grant: Grant): boolean {
  if (!acceptsRun(c.name, c.run) || !activeManifest(currentPlugins(), c.name)?.permissions.activePage) return false;
  if (grant.kind === "lease") return leaseHolds(c.name, tab.id, grant.lease);
  const gesture = recentPluginGesture(c.name);
  if (!gesture || gesture.id !== grant.id) return false;
  const readable = readableTab(gesture);
  return readable.ok && readable.tab.id === tab.id && tabReadable(c.name, readable.tab);
}

async function readTab(c: Caller, m: PluginManifest, tab: Tab, grant: Grant, params: Record<string, unknown>, consent: ConsentToken | null): Promise<Body> {
  const web = webviews.get(tab.id);
  if (!web) return failure("failed", "That tab's page isn't loaded.");
  const wantsShot = flag(params, "screenshot");
  if (wantsShot && !m.permissions.screenshot) return failure("refused", "A screenshot needs activePage.screenshot.");
  const before = await web.pluginDocument().catch(() => null);
  if (!before || (grant.kind === "lease" && grant.lease.document !== before)) return failure("refused", "That tab moved on to another page since it was attached.");
  const full = m.permissions.fullUrls === true;
  const flags = { markdown: flag(params, "markdown"), metadata: flag(params, "metadata"), selection: params.selection !== false, fullUrls: full };
  const [read, shot] = await Promise.all([
    withDeadline(web.evaluate<Read>(pageReadScript(flags)), READ_DEADLINE_MS, null).catch(() => null) as Promise<Read | null>,
    wantsShot ? withDeadline(web.capturePicture(0.5), READ_DEADLINE_MS, null).catch(() => null) : Promise.resolve(null),
  ]);
  const after = await web.pluginDocument().catch(() => null);
  const now = useBrowser.getState().tabs[tab.id];
  if (after !== before || !now || now.url !== tab.url || !grantHolds(c, now, grant)) return failure("refused", "The page changed while it was being read, or the plugin lost its access.");
  if (!read || typeof read.text !== "string") return failure("failed", "The page didn't answer.");
  if (full && activeManifest(currentPlugins(), c.name)?.permissions.fullUrls !== true) return failure("refused", "The plugin lost fullUrls while the page was being read.");
  const shown = (url: unknown) => (typeof url === "string" ? (full ? url : minimizedUrl(url)) : "");
  const metadata = isFields(read.metadata) ? { ...read.metadata, canonicalUrl: shown(read.metadata.canonicalUrl), image: shown(read.metadata.image) } : undefined;
  const links = Array.isArray(read.links) ? read.links.flatMap((l) => (isFields(l) ? [{ text: String(l.text ?? ""), url: shown(l.url) }] : [])) : undefined;
  notePlugin("plugin_page_reads", consent);
  if (shot) notePlugin("plugin_page_screenshots", consent);
  return {
    result: fittedRead({
      tabId: now.id,
      url: full ? now.url : minimizedUrl(now.url),
      title: now.customTitle || now.title,
      text: read.text,
      ...(typeof read.markdown === "string" ? { markdown: full ? read.markdown : minimizedMarkdown(read.markdown) } : {}),
      ...(typeof read.selection === "string" ? { selection: read.selection } : {}),
      lang: typeof read.lang === "string" ? read.lang.slice(0, 35) : "",
      ...(metadata ? { metadata, headings: Array.isArray(read.headings) ? read.headings : [], links: links ?? [], forms: Array.isArray(read.forms) ? read.forms : [] } : {}),
      ...(shot ? { screenshot: { mimeType: "image/jpeg", data: shot.data, width: Math.round(shot.frame[2]), height: Math.round(shot.frame[3]) } } : {}),
    }),
  };
}

export async function pageMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Promise<Body> {
  const consent = consentToken();
  if (method === "page.sendToContent") {
    if (typeof params.tabId !== "string") return failure("bad_request", "page.sendToContent needs a tabId.");
    const problem = postToContent(c.name, params.tabId, params.message, typeof params.scriptId === "string" ? params.scriptId : undefined);
    return problem ? failure("refused", problem) : { result: { ok: true } };
  }
  if (!m.permissions.activePage) return failure("refused", `${method} needs the activePage permission.`);
  const gesture = recentPluginGesture(c.name);
  if (method === "page.readTab" && typeof params.tabId === "string") {
    const active = gesture?.tabId === params.tabId ? readableTab(gesture) : null;
    if (gesture && active?.ok && tabReadable(c.name, active.tab)) return readTab(c, m, active.tab, { kind: "gesture", id: gesture.id }, params, consent);
    if (!m.permissions.multiTab) return failure("refused", "Reading another tab needs activePage.multiTab and a tab you attached.");
    const lease = leases.get(c.name)?.get(params.tabId);
    const tab = useBrowser.getState().tabs[params.tabId];
    return lease && tab && leaseHolds(c.name, params.tabId, lease) ? readTab(c, m, tab, { kind: "lease", lease }, params, consent) : failure("refused", "That tab isn't one you attached to the plugin, or it changed since.");
  }
  if (!gesture) return failure("refused", `${method} works only just after you use the plugin (a command, menu, toolbar button or its view).`);
  const readable = readableTab(gesture);
  if (!readable.ok) return readable.body;
  if (!tabReadable(c.name, readable.tab)) return failure("refused", "That tab is in a profile this plugin isn't on in.");
  return readTab(c, m, readable.tab, { kind: "gesture", id: gesture.id }, params, consent);
}

let watching = false;

export function watchTabLeases() {
  if (watching) return;
  watching = true;
  useBrowser.subscribeTo(["tabs"], (now, prev) => {
    for (const [plugin, held] of leases) {
      for (const [tabId, lease] of held) {
        const tab = now.tabs[tabId];
        if (!tab || (prev.tabs[tabId]?.url !== tab.url && withoutFragment(tab.url) !== lease.url) || tab.profileId !== lease.profileId) held.delete(tabId);
      }
      if (!held.size) leases.delete(plugin);
    }
  });
}
