import { useMemo } from "react";
import { activeManifest, usePlugins, type PluginsStore } from "./store";

type PluginDisclosure = { plugin: string; pluginTitle: string; title: string; items: string[]; official: boolean };

export function pluginTelemetryDisclosures(s: Pick<PluginsStore, "order" | "listings" | "records">): PluginDisclosure[] {
  const out: PluginDisclosure[] = [];
  for (const name of s.order) {
    const m = activeManifest(s, name);
    if (!m?.telemetry) continue;
    const official = !!s.listings[name]?.official && m.official;
    out.push({ plugin: name, pluginTitle: m.title, title: m.telemetry.title, items: [...m.telemetry.items], official });
  }
  return out;
}

export function usePluginTelemetryDisclosures(): PluginDisclosure[] {
  const key = usePlugins((s) => JSON.stringify(pluginTelemetryDisclosures(s)));
  return useMemo(() => JSON.parse(key) as PluginDisclosure[], [key]);
}
