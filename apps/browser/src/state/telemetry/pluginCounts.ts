import { contributionsOf, CONTRIBUTIONS, type PluginManifest } from "../../lib/pluginManifest";
import { activeManifest, usePlugins } from "../plugins/store";
import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NONE = {
  plugin_enables: 0,
  plugin_disables: 0,
  plugin_process_starts: 0,
  plugin_process_crashes: 0,
  plugin_commands_run: 0,
  plugin_tool_calls: 0,
  plugin_tool_failures: 0,
  plugin_page_opens: 0,
  plugin_split_opens: 0,
  program_links: 0,
  program_link_failures: 0,
  program_unlinks: 0,
  program_adoptions: 0,
  plugin_adoptions: 0,
  plugin_adoptions_waiting: 0,
  plugin_removals: 0,
  plugin_removals_cancelled: 0,
};

export type PluginCount = keyof typeof NONE;

let counts = { ...NONE };

export const notePlugin = (what: PluginCount, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[what]++);

export function takePluginCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}

export function pluginsSetting(installed: number, active: readonly PluginManifest[]): Record<string, string> {
  const used = Object.fromEntries(CONTRIBUTIONS.map((c) => [`plugins_with_${c}`, 0]));
  for (const m of active) for (const c of contributionsOf(m)) used[`plugins_with_${c}`]! += 1;
  return {
    plugins_installed: String(installed),
    plugins_enabled: String(active.length),
    ...Object.fromEntries(Object.entries(used).map(([k, v]) => [k, String(v)])),
  };
}

export function pluginsSnapshot(): Record<string, string> {
  const plugins = usePlugins.getState();
  if (!plugins.loaded) return {};
  return pluginsSetting(plugins.order.length, plugins.order.flatMap((name) => activeManifest(plugins, name) ?? []));
}
