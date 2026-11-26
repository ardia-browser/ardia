import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { isPluginKey, keyOfId } from "../../lib/pluginIds";
import { isPagePath } from "../../lib/pluginNames";
import { loadPluginRecords } from "./records";
import { usePlugins } from "./store";

const PAGE_URL = /^ardia:\/\/(@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,39}|[a-z0-9][a-z0-9-]{0,39}(?:__[a-z0-9][a-z0-9-]{0,39})?)(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/i;
const VIEW_URL = /^ardia-plugin:\/\/([a-z0-9][a-z0-9-]{0,39}(?:__[a-z0-9][a-z0-9-]{0,39})?)\/[^?#]*(\?[^#]*)?/i;
export { isPagePath };

export function parsePluginPageUrl(url: string | null | undefined): { name: string; path: string } | null {
  const m = url ? PAGE_URL.exec(url) : null;
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const name = host.startsWith("@") ? keyOfId(host) : host;
  if (!name || !isPluginKey(name)) return null;
  const path = `${m[2] && m[2] !== "/" ? m[2] : ""}${m[3] ?? ""}`;
  return { name, path: isPagePath(path) ? path : "" };
}

export const pluginPageUrl = (name: string, path = "") => `ardia://${name}${path}`;

export const pluginPagePath = (url: string): string => parsePluginPageUrl(url)?.path ?? "";

export function pageRouteOfView(name: string, viewUrl: string): string | null {
  const m = VIEW_URL.exec(viewUrl);
  if (!m || m[1]!.toLowerCase() !== name) return null;
  const route = new URLSearchParams(m[2] ?? "").get("ardiaPath");
  if (route === null) return "";
  return isPagePath(route) ? route : null;
}

export function pluginPageOf(url: string | null | undefined): string | null {
  if (!url || !PLATFORM_FEATURES.plugins) return null;
  const name = parsePluginPageUrl(url)?.name;
  if (!name) return null;
  loadPluginRecords();
  const s = usePlugins.getState();
  return s.listings[name]?.manifest?.contributes.panels.some((p) => p.mode === "tab" || p.mode === "split") || s.records[name] ? name : null;
}
