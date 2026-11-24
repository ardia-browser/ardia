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
  program_links_kept: 0,
  official_fetches: 0,
  official_fetch_failures: 0,
  official_fetch_offline: 0,
  official_verify_failures: 0,
  official_migrations_kept: 0,
  official_updates_waiting: 0,
  official_updates_auto: 0,
  official_update_prompts_baseline: 0,
  official_update_prompts_permissions: 0,
  official_update_prompts_network: 0,
  official_update_prompts_runtime: 0,
  official_update_prompts_activation: 0,
  official_update_prompts_programs: 0,
  official_update_prompts_hooks: 0,
  official_update_prompts_settings: 0,
  official_update_prompts_contributions: 0,
  official_update_prompts_unknown: 0,
  program_adoptions: 0,
  program_after_update_quit_exits: 0,
  program_after_update_quit_kills: 0,
  plugin_adoptions: 0,
  plugin_adoptions_waiting: 0,
  plugin_removals: 0,
  plugin_removals_cancelled: 0,
  plugin_activations: 0,
  plugin_activation_failures: 0,
  plugin_surface_renders: 0,
  plugin_panel_opens: 0,
  plugin_toolbar_runs: 0,
  plugin_menu_runs: 0,
  plugin_action_shortcuts: 0,
  plugin_omnibox_queries: 0,
  plugin_ui_prompts: 0,
  plugin_net_fetches: 0,
  plugin_net_refusals: 0,
  plugin_url_refusals_open: 0,
  plugin_url_refusals_group_create: 0,
  plugin_storage_writes: 0,
  plugin_storage_cancels: 0,
  plugin_secret_writes: 0,
  plugin_page_reads: 0,
  plugin_decide_calls: 0,
  plugin_decide_timeouts: 0,
};

export type PluginCount = keyof typeof NONE;

let counts = { ...NONE };

export const notePlugin = (what: PluginCount, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[what]++);

export const notePluginTimes = (what: PluginCount, times: number, consent?: ConsentToken | null) => {
  if (Number.isSafeInteger(times) && times > 0) countFor(consentOrNow(consent), () => void (counts[what] += times));
};

export function takePluginCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}

function pluginsSetting(installed: number, active: readonly PluginManifest[]): Record<string, string> {
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
