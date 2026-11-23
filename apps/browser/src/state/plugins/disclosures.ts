import { useMemo } from "react";
import { activeManifest, usePlugins, type PluginsStore } from "./store";
import { OFFICIAL_CATALOGUE, OFFICIAL_TELEMETRY } from "./officialPin";
import { useLegacyInstalls } from "./programRegistry";

type PluginDisclosure = { plugin: string; pluginTitle: string; title: string; items: string[]; official: boolean };

const pinnedTitle = (name: string) => OFFICIAL_CATALOGUE.find((p) => p.name === name)?.title ?? name;

export function pluginTelemetryDisclosures(s: Pick<PluginsStore, "order" | "listings" | "records">, legacyOwners: readonly string[] = []): PluginDisclosure[] {
  const out: PluginDisclosure[] = [];
  for (const name of s.order) {
    const m = activeManifest(s, name);
    if (!m) continue;
    const official = !!s.listings[name]?.official && m.official;
    const telemetry = m.telemetry ?? (official && Object.hasOwn(OFFICIAL_TELEMETRY, name) ? OFFICIAL_TELEMETRY[name] : null);
    if (telemetry) out.push({ plugin: name, pluginTitle: m.title, title: telemetry.title, items: [...telemetry.items], official });
  }
  for (const name of legacyOwners) {
    if (out.some((d) => d.plugin === name) || !Object.hasOwn(OFFICIAL_TELEMETRY, name)) continue;
    const telemetry = OFFICIAL_TELEMETRY[name]!;
    out.push({ plugin: name, pluginTitle: pinnedTitle(name), title: telemetry.title, items: [...telemetry.items], official: true });
  }
  return out;
}

export function usePluginTelemetryDisclosures(): PluginDisclosure[] {
  const legacy = useLegacyInstalls((s) => s.owners);
  const key = usePlugins((s) => JSON.stringify(pluginTelemetryDisclosures(s, legacy)));
  return useMemo(() => JSON.parse(key) as PluginDisclosure[], [key]);
}
