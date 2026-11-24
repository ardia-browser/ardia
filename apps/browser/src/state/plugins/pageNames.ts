import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { isPagePath } from "../../lib/pluginNames";
import { loadPluginRecords } from "./records";
import { usePlugins } from "./store";

const PAGE_URL = /^ardia:\/\/([a-z0-9][a-z0-9-]{0,39})(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/i;
export { isPagePath };

export const pluginPageUrl = (name: string, path = "") => `ardia://${name}${path}`;

export function pluginPagePath(url: string): string {
  const m = PAGE_URL.exec(url);
  const path = `${m?.[2] && m[2] !== "/" ? m[2] : ""}${m?.[3] ?? ""}`;
  return isPagePath(path) ? path : "";
}

export function pluginPageOf(url: string | null | undefined): string | null {
  if (!url || !PLATFORM_FEATURES.plugins) return null;
  const name = PAGE_URL.exec(url)?.[1]?.toLowerCase();
  if (!name) return null;
  loadPluginRecords();
  const s = usePlugins.getState();
  return s.listings[name]?.manifest?.contributes.panels.some((p) => p.mode === "tab" || p.mode === "split") || s.records[name] ? name : null;
}
