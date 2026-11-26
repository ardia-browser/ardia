import { urlMatches } from "@ardia/plugin-sdk/manifest";
import type { PluginManifest } from "../../lib/pluginManifest";
import { MAX_WORLD_EVENT, STYLE_WORLD, unitOfWorld, worldBootstrap, worldDeliver, worldMessagesOf, worldOf, worldScript, worldStyles, worldTeardown } from "../../lib/pluginWorlds";
import { on } from "../../platform/engine";
import { sendToPlugin } from "../../platform/plugins";
import { onWebviewsChanged, webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { onLiveChange } from "../tabs/tabLive";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { nativeConsent } from "../telemetry/nativeConsent";
import { pluginReadyRun } from "./activation";
import { readFolderFile } from "./hostIo";
import { pluginPageOf } from "./pages";
import { manifestInProfile } from "./profileScope";
import { pluginScriptsBlockedOn, useSiteScriptBlocks } from "./siteScriptBlocks";
import { activeManifest, currentPlugins, usePlugins } from "./store";

type ScriptSpec = { id: string; js: string[]; css: string[]; start: boolean };
type Wanted = { scripts: ScriptSpec[]; styles: { id: string; css: string }[] };
type Unit = { token: string; booted: boolean; ran: boolean; inFlight: boolean };
type PluginState = { scripts: string; styles: string; stylesPending: string | null; units: Map<string, Unit> };
type TabState = { document: string; href: string; plugins: Map<string, PluginState> };

const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MESSAGES_PER_SECOND = 50;
const BYTES_PER_SECOND = 2 * 1024 * 1024;
const ENGINE = "webkit";
const tabs = new Map<string, TabState>();
const files = new Map<string, Promise<string | null>>();
const paused = new Set<string>();
const budgets = new Map<string, { at: number; count: number; bytes: number }>();
const liveLoading = new Map<string, boolean>();
let tokenSeq = 0;

export const isWebPage = (url: string) => /^https?:\/\//i.test(url) && !pluginPageOf(url);

const v3Contributes = (m: PluginManifest) => m.v3.contributes ?? {};
const pagesOf = (m: PluginManifest): string[] => (Array.isArray(m.v3.permissions?.pages) ? (m.v3.permissions!.pages as string[]) : []);
const newToken = () => `d${Date.now().toString(36)}${(++tokenSeq).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const loading = (tabId: string) => liveLoading.get(tabId) === true;
const engineOf = (tabId: string): "webkit" | "poll" => (useBrowser.getState().tabs[tabId]?.engine === ENGINE ? "webkit" : "poll");

function matching(m: PluginManifest, url: string, matches: readonly string[]): boolean {
  return pagesOf(m).some((p) => urlMatches(p, url)) && matches.some((p) => urlMatches(p, url));
}

export function wantedFor(m: PluginManifest, url: string): Wanted {
  const c = v3Contributes(m);
  const scripts = (c.contentScripts ?? []).filter((s) => matching(m, url, s.matches)).map((s) => ({ id: s.id, js: [...s.js], css: [...(s.css ?? [])], start: s.runAt === "document_start" }));
  const styles = (c.pageStyles ?? []).filter((s) => matching(m, url, s.matches)).map((s) => ({ id: s.id, css: s.css }));
  return { scripts, styles };
}

export function tabMayRunPluginScripts(tabId: string): string | null {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || isIncognitoProfile(tab.profileId)) return null;
  if (!isWebPage(tab.url) || pluginScriptsBlockedOn(tab.url)) return null;
  return tab.url;
}

export function pluginAllowedOnTab(tabId: string, name: string): PluginManifest | null {
  const url = tabMayRunPluginScripts(tabId);
  const tab = useBrowser.getState().tabs[tabId];
  const plugins = currentPlugins();
  const m = activeManifest(plugins, name);
  if (!url || !tab || !m || paused.has(name) || !manifestInProfile(plugins, name, tab.profileId)) return null;
  return m;
}

function wantedOn(tabId: string, name: string): Wanted | null {
  const m = pluginAllowedOnTab(tabId, name);
  const url = useBrowser.getState().tabs[tabId]?.url;
  if (!m || !url) return null;
  const wanted = wantedFor(m, url);
  return wanted.scripts.length || wanted.styles.length ? wanted : null;
}

const wantsScript = (tabId: string, name: string, scriptId: string) => !!wantedOn(tabId, name)?.scripts.some((s) => s.id === scriptId);

function outlivedUnits(tabId: string, name: string, plugin: PluginState): string[] {
  const wanted = wantedOn(tabId, name);
  return [...plugin.units.keys()].filter((id) => !wanted?.scripts.some((s) => s.id === id));
}

const ranAny = (plugin: PluginState | undefined) => !!plugin && [...plugin.units.values()].some((u) => u.ran || u.inFlight);
const ranIds = (plugin: PluginState) => [...plugin.units].flatMap(([id, u]) => (u.ran ? [id] : []));

function pluginsForTab(tabId: string): Map<string, Wanted> {
  const out = new Map<string, Wanted>();
  for (const name of currentPlugins().order) {
    const wanted = wantedOn(tabId, name);
    if (wanted) out.set(name, wanted);
  }
  return out;
}

function fileOf(name: string, path: string): Promise<string | null> {
  const plugins = currentPlugins();
  const listing = plugins.listings[name];
  const approved = plugins.records[name]?.approved;
  if (!listing?.folderId || !approved) return Promise.resolve(null);
  const key = `${name}@${listing.folderId}:${path}`;
  let read = files.get(key);
  if (!read) {
    read = readFolderFile(name, listing.folderId, approved, path).then((r) => (r.ok && r.text.length <= MAX_FILE_CHARS ? r.text : null));
    files.set(key, read);
  }
  return read;
}

function teardownUnit(tabId: string, name: string, plugin: PluginState, scriptId: string) {
  const unit = plugin.units.get(scriptId);
  const world = worldOf(name, scriptId);
  plugin.units.delete(scriptId);
  const web = webviews.get(tabId);
  if (unit?.booted && world && web) void web.removePluginWorld(world, worldTeardown(unit.token)).catch(() => undefined);
}

function teardown(tabId: string, state: TabState, name: string) {
  const plugin = state.plugins.get(name);
  const world = worldOf(name);
  const web = webviews.get(tabId);
  state.plugins.delete(name);
  if (!plugin || !world || !web) return;
  const ran = ranAny(plugin);
  for (const id of [...plugin.units.keys()]) teardownUnit(tabId, name, plugin, id);
  if (plugin.styles !== "[]") void web.runPluginWorld(STYLE_WORLD, worldStyles(world, [], null), state.document).catch(() => false);
  if (ran && !pluginAllowedOnTab(tabId, name)) void web.reload().catch(() => undefined);
}

async function applyPlugin(tabId: string, state: TabState, name: string, wanted: Wanted, consent: ConsentToken | null) {
  const web = webviews.get(tabId);
  const world = worldOf(name);
  if (!web || !world) return;
  const plugin = state.plugins.get(name) ?? { scripts: "", styles: "[]", stylesPending: null, units: new Map<string, Unit>() };
  state.plugins.set(name, plugin);
  const here = () => tabs.get(tabId) === state && state.plugins.get(name) === plugin && useBrowser.getState().tabs[tabId]?.url === state.href;
  const live = () => here() && !!wantedOn(tabId, name);
  const styles = JSON.stringify(wanted.styles.map((s) => s.id).concat(wanted.scripts.flatMap((s) => s.css.map((c) => `${s.id}:${c}`))));
  if (plugin.styles !== styles && plugin.stylesPending !== styles) {
    plugin.stylesPending = styles;
    const sheets = await Promise.all([...wanted.styles.map(async (s) => ({ id: s.id, css: (await fileOf(name, s.css)) ?? "" })), ...wanted.scripts.flatMap((s) => s.css.map(async (path) => ({ id: `${s.id}:${path}`, css: (await fileOf(name, path)) ?? "" })))]);
    const applied = live() && plugin.stylesPending === styles && (await web.runPluginWorld(STYLE_WORLD, worldStyles(world, sheets.filter((s) => s.css), state.href), state.document).catch(() => false));
    if (plugin.stylesPending === styles) plugin.stylesPending = null;
    if (applied) {
      plugin.styles = styles;
      if (wanted.styles.length) notePlugin("plugin_page_styles", consent);
    }
    if (!live()) return;
  }
  const scripts = JSON.stringify(wanted.scripts);
  if (plugin.scripts !== scripts) plugin.scripts = scripts;
  const due = wanted.scripts.filter((s) => !plugin.units.get(s.id)?.ran && !plugin.units.get(s.id)?.inFlight && (s.start || !loading(tabId)));
  for (const script of due) {
    const scriptWorld = worldOf(name, script.id);
    if (!scriptWorld) continue;
    const unit = plugin.units.get(script.id) ?? { token: newToken(), booted: false, ran: false, inFlight: false };
    plugin.units.set(script.id, unit);
    const unitLive = () => live() && plugin.units.get(script.id) === unit && wantsScript(tabId, name, script.id);
    if (unit.ran || unit.inFlight || !unitLive()) continue;
    unit.inFlight = true;
    const href = state.href;
    try {
      if (!unit.booted) {
        const booted = await web.runPluginWorld(scriptWorld, worldBootstrap(scriptWorld, engineOf(tabId), unit.token, href, state.document), state.document).catch(() => false);
        if (!booted || !unitLive()) continue;
        unit.booted = true;
      }
      let ran = false;
      for (const path of script.js) {
        const code = await fileOf(name, path);
        if (code === null) continue;
        if (!unitLive()) break;
        const applied = await web.runPluginWorld(scriptWorld, worldScript({ id: script.id, code }, unit.token, state.href), state.document).catch(() => false);
        if (applied) {
          ran = true;
          notePlugin("plugin_content_injections", consent);
        } else if (!ran) break;
      }
      if (ran) unit.ran = true;
    } finally {
      unit.inFlight = false;
    }
    if (!unit.ran && tabs.get(tabId) === state && useBrowser.getState().tabs[tabId]?.url !== href && wantsScript(tabId, name, script.id)) void reconcileTab(tabId, consent);
  }
}

const tabChains = new Map<string, Promise<void>>();

function dropOutlived(tabId: string, state: TabState) {
  for (const [name, plugin] of [...state.plugins]) {
    if (!wantedOn(tabId, name)) teardown(tabId, state, name);
    else for (const id of outlivedUnits(tabId, name, plugin)) teardownUnit(tabId, name, plugin, id);
  }
}

export function reconcileTab(tabId: string, consent: ConsentToken | null): Promise<void> {
  const known = tabs.get(tabId);
  if (known) dropOutlived(tabId, known);
  const prior = tabChains.get(tabId) ?? Promise.resolve();
  const next = prior.then(async () => {
    const web = webviews.get(tabId);
    const tab = useBrowser.getState().tabs[tabId];
    if (!web || !tab) return void tabs.delete(tabId);
    const wanted = pluginsForTab(tabId);
    const current = tabs.get(tabId);
    if (!wanted.size && !current?.plugins.size) return;
    const document = await web.pluginDocument().catch(() => null);
    if (!document) return;
    const href = useBrowser.getState().tabs[tabId]?.url ?? tab.url;
    let state = tabs.get(tabId);
    if (!state || state.document !== document) {
      state = { document, href, plugins: new Map() };
      tabs.set(tabId, state);
    } else if (state.href !== href) state.href = href;
    dropOutlived(tabId, state);
    for (const [name, want] of pluginsForTab(tabId)) await applyPlugin(tabId, state, name, want, consent).catch(() => undefined);
  });
  tabChains.set(tabId, next);
  void next.then(() => {
    if (tabChains.get(tabId) === next) tabChains.delete(tabId);
  });
  return next;
}

export function reconcileAllTabs(consent: ConsentToken | null): Promise<void> {
  return Promise.all([...webviews.keys()].map((id) => reconcileTab(id, consent))).then(() => undefined);
}

const commits = new Map<string, number>();

export function notePluginWorldCommit(tabId: string, committedAt: number | undefined) {
  if (typeof committedAt !== "number" || !Number.isFinite(committedAt) || commits.get(tabId) === committedAt) return;
  commits.set(tabId, committedAt);
  if (started && webviews.has(tabId)) void reconcileTab(tabId, consentToken());
}

export function pausePluginScripts(name: string, pause: boolean) {
  if (pause) paused.add(name);
  else paused.delete(name);
  void reconcileAllTabs(consentToken());
}

export const injectedTabsOf = (name: string): string[] => [...tabs].flatMap(([tabId, state]) => (ranAny(state.plugins.get(name)) ? [tabId] : []));

export function postToContent(name: string, tabId: string, message: unknown, scriptId?: string): string | null {
  const state = tabs.get(tabId);
  const web = webviews.get(tabId);
  const plugin = state?.plugins.get(name);
  if (!state || !plugin || !ranAny(plugin) || !web || !wantedOn(tabId, name)) return "That tab has none of this plugin's content scripts.";
  if (useBrowser.getState().tabs[tabId]?.url !== state.href) return "That tab's page changed, so its content scripts are being set up again.";
  if (scriptId !== undefined && (!plugin.units.get(scriptId)?.ran || !wantsScript(tabId, name, scriptId))) return "That tab has no content script with that id running.";
  const targets = (scriptId !== undefined ? [scriptId] : ranIds(plugin)).filter((id) => wantsScript(tabId, name, id));
  if (!targets.length) return "That tab has no content script that matches its page now.";
  let json: string;
  try {
    json = JSON.stringify({ ...(scriptId ? { scriptId } : {}), message: message ?? null });
  } catch {
    return "message isn't JSON.";
  }
  if (json.length > 256 * 1024) return "message is over 256 KB.";
  for (const id of targets) {
    const world = worldOf(name, id);
    const unit = plugin.units.get(id);
    if (world && unit) void web.postPluginWorld(world, worldDeliver(unit.token, json, state.href), state.document).catch(() => undefined);
  }
  return null;
}

function withinBudget(name: string, bytes: number, now = Date.now()): boolean {
  const budget = budgets.get(name);
  if (!budget || now - budget.at >= 1000) {
    budgets.set(name, { at: now, count: 1, bytes });
    return bytes <= BYTES_PER_SECOND;
  }
  budget.count++;
  budget.bytes += bytes;
  return budget.count <= MESSAGES_PER_SECOND && budget.bytes <= BYTES_PER_SECOND;
}

export function receiveWorldMessage(tabId: string, world: string, document: string, json: string, consent: ConsentToken | null) {
  const from = unitOfWorld(world);
  const name = from?.plugin ?? null;
  const state = tabs.get(tabId);
  if (!name || typeof json !== "string" || json.length > MAX_WORLD_EVENT || !withinBudget(name, json.length)) return notePlugin("plugin_content_refusals", consent);
  const plugin = state?.plugins.get(name);
  const unit = from?.scriptId ? plugin?.units.get(from.scriptId) : undefined;
  if (!state || !plugin || !unit?.ran || state.document !== document || !wantedOn(tabId, name)) return notePlugin("plugin_content_refusals", consent);
  const run = pluginReadyRun(name);
  if (run === null) return;
  for (const { doc, scriptId, message } of worldMessagesOf(json)) {
    if (doc !== unit.token || !scriptId || scriptId !== from?.scriptId || plugin.units.get(scriptId) !== unit || !wantsScript(tabId, name, scriptId) || useBrowser.getState().tabs[tabId]?.url !== state.href) {
      notePlugin("plugin_content_refusals", consent);
      continue;
    }
    notePlugin("plugin_content_messages", consent);
    sendToPlugin(name, run, JSON.stringify({ event: "page.contentMessage", time: Date.now(), data: { tabId, ...(scriptId ? { scriptId } : {}), message } }));
  }
}

export function dropPluginWorlds(name: string) {
  for (const key of [...files.keys()]) if (key.startsWith(`${name}@`)) files.delete(key);
  budgets.delete(name);
}

let started = false;

export function startPageWorlds() {
  if (started) return;
  started = true;
  on("webView.pluginWorld", (e) => receiveWorldMessage(e.tabId, e.world, e.document, e.json, nativeConsent(e)));
  onWebviewsChanged(() => void reconcileAllTabs(consentToken()));
  onLiveChange((tabId, live, prev) => {
    liveLoading.set(tabId, live.isLoading);
    if (live.isLoading !== prev.isLoading) void reconcileTab(tabId, consentToken());
  });
  useBrowser.subscribeTo(["tabs"], (now, prev) => {
    for (const [id, tab] of Object.entries(now.tabs)) if (prev.tabs[id]?.url !== tab.url && webviews.has(id)) void reconcileTab(id, consentToken());
    for (const id of Object.keys(prev.tabs))
      if (!now.tabs[id]) {
        tabs.delete(id);
        liveLoading.delete(id);
        commits.delete(id);
      }
  });
  usePlugins.subscribe((s, prev) => {
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) void reconcileAllTabs(consentToken());
  });
  useSiteScriptBlocks.subscribe(() => void reconcileAllTabs(consentToken()));
}
