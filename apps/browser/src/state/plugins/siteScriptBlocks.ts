import { create } from "zustand";
import { switchOrigin } from "../../lib/pluginPageBar";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { readDocument, writeDocument } from "../../platform/documents";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import type { ConsentToken } from "../telemetry/choice";
import { activeManifest, usePlugins } from "./store";
import { notePlugin } from "../telemetry/pluginCounts";

export const SITE_SCRIPT_BLOCKS_DOC = "Plugins/site-script-blocks.json";
const VERSION = 1;
const MAX_SITES = 5000;

type Blocks = { loaded: boolean; sites: Record<string, true> };

export const useSiteScriptBlocks = create<Blocks>()(() => ({ loaded: false, sites: {} }));

export function parseSiteScriptBlocks(json: string | null): Record<string, true> {
  const saved = parseSaved(json, VERSION);
  if (!saved || !Array.isArray(saved.sites)) return {};
  const sites: Record<string, true> = {};
  for (const site of saved.sites.slice(0, MAX_SITES)) if (typeof site === "string" && switchOrigin(site) === site) sites[site] = true;
  return sites;
}

export const siteScriptBlocksJson = (sites: Record<string, true>) => versionedJson({ sites: Object.keys(sites).sort() }, VERSION, "version", 2);

function loaded(): Record<string, true> {
  const s = useSiteScriptBlocks.getState();
  if (s.loaded) return s.sites;
  let sites: Record<string, true> = {};
  try {
    sites = parseSiteScriptBlocks(readDocument(SITE_SCRIPT_BLOCKS_DOC));
  } catch {
    sites = {};
  }
  useSiteScriptBlocks.setState({ loaded: true, sites });
  return sites;
}

export const loadSiteScriptBlocks = () => void loaded();

export function pluginScriptsBlockedOn(url: string): boolean {
  const origin = switchOrigin(url);
  return !!origin && loaded()[origin] === true;
}

export function setPluginScriptsBlocked(url: string, blocked: boolean, consent?: ConsentToken | null): boolean {
  const origin = switchOrigin(url);
  if (!origin) return false;
  const sites = { ...loaded() };
  if ((sites[origin] === true) === blocked) return true;
  if (blocked) sites[origin] = true;
  else delete sites[origin];
  try {
    writeDocument(SITE_SCRIPT_BLOCKS_DOC, siteScriptBlocksJson(sites));
  } catch {
    return false;
  }
  useSiteScriptBlocks.setState({ loaded: true, sites });
  if (blocked) notePlugin("plugin_site_script_blocks", consent);
  return true;
}

export function useSitePluginScripts(tabId: string): { origin: string | null; blocked: boolean } {
  const origin = useBrowser((s) => {
    const t = s.tabs[tabId];
    return t && !isIncognitoProfile(t.profileId) ? switchOrigin(t.url) : null;
  });
  const blocked = useSiteScriptBlocks((s) => (origin ? s.sites[origin] === true : false));
  return { origin, blocked };
}

export const usePluginsTouchPages = () =>
  usePlugins((s) => s.order.some((name) => {
    const m = activeManifest(s, name);
    return !!m && m.permissions.pages !== false && ((m.v3.contributes?.contentScripts?.length ?? 0) > 0 || (m.v3.contributes?.pageStyles?.length ?? 0) > 0);
  }));
