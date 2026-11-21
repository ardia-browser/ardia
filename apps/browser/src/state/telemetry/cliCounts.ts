import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";
import { SOCKET_FAMILIES, type SocketFamily } from "../automation/socketCatalog";

export type CliInstallReason = "auto" | "settings" | "upgrade";

const NONE = {
  cli_pill_shows: 0,
  cli_pill_compact_shows: 0,
  cli_auto_installs: 0,
  cli_auto_install_failures: 0,
  cli_auto_enables: 0,
  cli_upgrades: 0,
  cli_upgrade_failures: 0,
  cli_settings_installs: 0,
  cli_settings_install_failures: 0,
  windowless_pages_given_geometry: 0,
  windowless_pages_missing_geometry: 0,
  cli_socket_call_failures: 0,
  cli_socket_lines_shrunk: 0,
  cli_socket_password_manager_refusals: 0,
  ...(Object.fromEntries(SOCKET_FAMILIES.map((family) => [`cli_socket_calls_${family}`, 0])) as Record<`cli_socket_calls_${SocketFamily}`, number>),
  cli_cdp_commands_target: 0,
  cli_cdp_commands_page: 0,
  cli_cdp_commands_runtime: 0,
  cli_cdp_commands_dom: 0,
  cli_cdp_commands_input: 0,
  cli_cdp_commands_network: 0,
  cli_cdp_commands_emulation: 0,
  cli_cdp_commands_browser: 0,
  cli_cdp_commands_storage: 0,
  cli_cdp_commands_fetch: 0,
  cli_cdp_commands_accessibility: 0,
  cli_cdp_commands_other: 0,
  cli_plugin_credentials_minted: 0,
  cli_plugin_credentials_revoked: 0,
  cli_plugin_commands_refused: 0,
  cli_plugin_tab_holds: 0,
  cli_plugin_wheels_busy: 0,
  cli_act_leases_granted: 0,
  cli_act_commands_refused: 0,
  cli_act_deliveries_refused: 0,
  cli_file_picker_answers_armed: 0,
  cli_file_picker_answers_used: 0,
};

export const CDP_COMMAND_DOMAINS = ["target", "page", "runtime", "dom", "input", "network", "emulation", "browser", "storage", "fetch", "accessibility", "other"] as const;
export type CdpCommandDomain = (typeof CDP_COMMAND_DOMAINS)[number];
export type CdpCommandsByDomain = Partial<Record<CdpCommandDomain, number>>;

const FIELDS = {
  auto: ["cli_auto_installs", "cli_auto_install_failures"],
  upgrade: ["cli_upgrades", "cli_upgrade_failures"],
  settings: ["cli_settings_installs", "cli_settings_install_failures"],
} as const;

let counts = { ...NONE };
let windowlessSeen = { given: 0, missed: 0 };
const PLUGIN_TOTALS = { minted: "cli_plugin_credentials_minted", revoked: "cli_plugin_credentials_revoked", refused: "cli_plugin_commands_refused", holds: "cli_plugin_tab_holds", busy: "cli_plugin_wheels_busy" } as const;
let pluginSeen = { minted: 0, revoked: 0, refused: 0, holds: 0, busy: 0 };
const ACT_TOTALS = { granted: "cli_act_leases_granted", commandsRefused: "cli_act_commands_refused", deliveriesRefused: "cli_act_deliveries_refused" } as const;
type ActLeaseTotals = Partial<Record<keyof typeof ACT_TOTALS, number>>;
let actSeen = { granted: 0, commandsRefused: 0, deliveriesRefused: 0 };
let pickerSeen = { armed: 0, used: 0 };
let cdpCommandsSeen: Record<CdpCommandDomain, number> = Object.fromEntries(CDP_COMMAND_DOMAINS.map((domain) => [domain, 0])) as Record<CdpCommandDomain, number>;

export const noteCliInstall = (reason: CliInstallReason, ok: boolean, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[FIELDS[reason][ok ? 0 : 1]]++);
export function noteCliPillShown(compact: boolean) {
  counts.cli_pill_shows++;
  if (compact) counts.cli_pill_compact_shows++;
}
export function noteSocketCall(family: SocketFamily, failed: boolean, consent?: ConsentToken | null) {
  const field = `cli_socket_calls_${family}` as const;
  countFor(consentOrNow(consent), () => void counts[field]++);
  if (failed) countFor(consentOrNow(consent), () => void counts.cli_socket_call_failures++);
}
export const noteSocketLineShrunk = (consent: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.cli_socket_lines_shrunk++);
export const noteSocketPasswordManagerRefused = (consent: ConsentToken | null) =>
  countFor(consentOrNow(consent), () => void counts.cli_socket_password_manager_refusals++);
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

type TotalsFamily = "windowless" | "cdp" | "plugin" | "act" | "picker";
const baselined = new Set<TotalsFamily>();
let baselinePeriod: ConsentToken | null | undefined;

function counting(family: TotalsFamily, consent: ConsentToken | null | undefined): boolean {
  const period = consentOrNow(consent);
  if (period === null) return true;
  if (period !== baselinePeriod) {
    baselinePeriod = period;
    baselined.clear();
  }
  if (baselined.has(family)) return true;
  baselined.add(family);
  return false;
}

export function noteWindowlessPages(totals: { given: number; missed: number } | undefined, consent?: ConsentToken | null) {
  if (consent === null) return;
  if (!totals) return;
  const given = Number(totals.given) || 0, missed = Number(totals.missed) || 0;
  if (counting("windowless", consent)) {
    counts.windowless_pages_given_geometry += Math.max(0, given - windowlessSeen.given);
    counts.windowless_pages_missing_geometry += Math.max(0, missed - windowlessSeen.missed);
  }
  windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
}

export function noteCdpCommands(totals: CdpCommandsByDomain | undefined, consent?: ConsentToken | null) {
  if (consent === null) return;
  if (!totals) return;
  const count = counting("cdp", consent);
  for (const domain of CDP_COMMAND_DOMAINS) {
    const total = Number(totals[domain]) || 0;
    if (count) counts[`cli_cdp_commands_${domain}`] += Math.max(0, total - cdpCommandsSeen[domain]);
    cdpCommandsSeen[domain] = Math.max(total, cdpCommandsSeen[domain]);
  }
}

export function notePluginTotals(totals: Partial<Record<keyof typeof PLUGIN_TOTALS, number>> | undefined, consent?: ConsentToken | null) {
  if (consent === null) return;
  if (!totals) return;
  const count = counting("plugin", consent);
  for (const key of Object.keys(PLUGIN_TOTALS) as (keyof typeof PLUGIN_TOTALS)[]) {
    const total = Number(totals[key]) || 0;
    if (count) counts[PLUGIN_TOTALS[key]] += Math.max(0, total - pluginSeen[key]);
    pluginSeen[key] = Math.max(total, pluginSeen[key]);
  }
}

export function noteActLeaseTotals(totals: ActLeaseTotals | undefined, consent?: ConsentToken | null) {
  if (consent === null) return;
  if (!totals) return;
  const count = counting("act", consent);
  for (const key of Object.keys(ACT_TOTALS) as (keyof typeof ACT_TOTALS)[]) {
    const total = Number(totals[key]) || 0;
    if (count) counts[ACT_TOTALS[key]] += Math.max(0, total - actSeen[key]);
    actSeen[key] = Math.max(total, actSeen[key]);
  }
}

export function notePickerAnswers(totals: { armed?: number; used?: number } | undefined, consent?: ConsentToken | null) {
  if (consent === null) return;
  if (!totals) return;
  const armed = Number(totals.armed) || 0, used = Number(totals.used) || 0;
  if (counting("picker", consent)) {
    counts.cli_file_picker_answers_armed += Math.max(0, armed - pickerSeen.armed);
    counts.cli_file_picker_answers_used += Math.max(0, used - pickerSeen.used);
  }
  pickerSeen = { armed: Math.max(armed, pickerSeen.armed), used: Math.max(used, pickerSeen.used) };
}

type EngineTotals = { windowlessPages?: { given: number; missed: number }; commandsByDomain?: CdpCommandsByDomain; pluginCredentials?: Partial<Record<keyof typeof PLUGIN_TOTALS, number>>; filePickerAnswers?: { armed?: number; used?: number }; actLeases?: ActLeaseTotals };
export function noteCliEngineTotals(status: EngineTotals, consent: ConsentToken | null) {
  noteWindowlessPages(status.windowlessPages, consent);
  noteCdpCommands(status.commandsByDomain, consent);
  notePluginTotals(status.pluginCredentials, consent);
  notePickerAnswers(status.filePickerAnswers, consent);
  noteActLeaseTotals(status.actLeases, consent);
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
