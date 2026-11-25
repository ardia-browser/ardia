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
  program_link_cause_name: 0,
  program_link_cause_bin_folder: 0,
  program_link_cause_bin_shared: 0,
  program_link_cause_shadowed: 0,
  program_link_cause_taken: 0,
  program_link_cause_other_plugin: 0,
  program_link_cause_busy: 0,
  program_link_cause_io: 0,
  program_link_cause_other: 0,
  program_unlinks: 0,
  program_links_kept: 0,
  official_fetches: 0,
  official_fetch_failures: 0,
  official_fetch_offline: 0,
  official_verify_failures: 0,
  official_fetch_cause_permission: 0,
  official_fetch_cause_disk: 0,
  official_fetch_cause_folder: 0,
  official_fetch_cause_mismatch: 0,
  official_fetch_cause_unpack: 0,
  official_fetch_cause_server: 0,
  official_fetch_cause_network: 0,
  official_fetch_cause_timeout: 0,
  official_fetch_cause_io: 0,
  official_fetch_cause_other: 0,
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
  plugin_state_events: 0,
  plugin_state_events_dropped: 0,
  plugin_state_flushes_slow: 0,
  plugin_state_subscribe_refusals: 0,
  plugin_state_resyncs: 0,
  plugin_state_intents: 0,
  plugin_state_intent_refusals: 0,
};

export type PluginCount = keyof typeof NONE;

const FETCH_CAUSES = new Set(["permission", "disk", "folder", "mismatch", "unpack", "server", "network", "timeout", "io", "other"]);
const LINK_CAUSES = new Set(["name", "bin_folder", "bin_shared", "shadowed", "taken", "other_plugin", "busy", "io", "other"]);

export const officialFetchCause = (cause: unknown): PluginCount =>
  `official_fetch_cause_${typeof cause === "string" && FETCH_CAUSES.has(cause) ? cause : "other"}` as PluginCount;

export const programLinkCause = (cause: unknown): PluginCount =>
  `program_link_cause_${typeof cause === "string" && LINK_CAUSES.has(cause) ? cause : "other"}` as PluginCount;

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
