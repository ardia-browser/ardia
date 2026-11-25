import { onConsentPeriodChange, stillValid, type ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";
import { SOCKET_FAMILIES, type SocketFamily } from "../automation/socketCatalog";
import { INPUT_ACTIONS, type InputAction } from "../automation/tabInputActions";

const TOKEN_COMMAND_DOMAINS = ["accessibility", "ardia", "browser", "dom", "emulation", "fetch", "input", "network", "page", "runtime", "storage", "target", "other"] as const;
type TokenCommandDomain = (typeof TOKEN_COMMAND_DOMAINS)[number];
type TokenCommandTotals = Partial<Record<TokenCommandDomain, number>>;

export type CliInstallReason = "auto" | "settings" | "upgrade";

const DOORBELL_OUTCOMES = ["once", "half_hour", "always", "deny", "unshown", "timeout", "left", "stopped", "unsaved"] as const;
export type DoorbellOutcome = (typeof DOORBELL_OUTCOMES)[number];

const DEVTOOLS_ENDPOINT_OUTCOMES = ["given", "control_off", "unsupported", "server_off", "unreadable", "stale", "left"] as const;
export type DevtoolsEndpointOutcome = (typeof DEVTOOLS_ENDPOINT_OUTCOMES)[number];

const ENGINE_CLI_TOTALS = {
  sessionsOpened: "sessions_opened",
  sessionsRefused: "sessions_refused",
  sessionCommands: "session_commands",
  sessionEvents: "session_events",
  sessionEventsCut: "session_events_cut",
  snapshots: "snapshots",
  snapshotsFailed: "snapshots_failed",
  snapshotRefs: "snapshot_refs",
  snapshotsModal: "snapshots_modal",
  occludedRefs: "occluded_refs",
  settles: "settles",
  settlesTimedOut: "settles_timed_out",
  settleMs: "settle_ms",
  hitTests: "hit_tests",
  clicks: "clicks",
  clicksBlocked: "clicks_blocked",
  dismissFound: "dismiss_found",
  refsRebound: "refs_rebound",
  refsStale: "refs_stale",
  screenshots: "screenshots",
  screenshotsHidden: "screenshots_hidden",
  screenshotsFailed: "screenshots_failed",
  cancelled: "cancelled",
  clicksUnverified: "clicks_unverified",
  refused: "refused",
} as const;
type EngineCliTotalKey = keyof typeof ENGINE_CLI_TOTALS;
type EngineCliField = (typeof ENGINE_CLI_TOTALS)[EngineCliTotalKey];
const ENGINE_CLI_FIELDS = Object.values(ENGINE_CLI_TOTALS);
type EngineCliTotals = Partial<Record<EngineCliTotalKey, number>>;

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
  cli_socket_doorbells_shown: 0,
  cli_page_signal_console_reads: 0,
  cli_page_signal_focused_origins: 0,
  cli_page_signal_origin_mismatches: 0,
  cli_page_signal_hit_tests: 0,
  cli_page_signal_hit_tests_failed: 0,
  cli_page_signal_hit_tests_cancelled: 0,
  cli_page_signal_remote_frames: 0,
  cli_page_signal_occluded: 0,
  ...(Object.fromEntries(ENGINE_CLI_FIELDS.map((field) => [`cli_engine_${field}`, 0])) as Record<`cli_engine_${EngineCliField}`, number>),
  ...(Object.fromEntries(DOORBELL_OUTCOMES.map((outcome) => [`cli_socket_doorbell_${outcome}`, 0])) as Record<`cli_socket_doorbell_${DoorbellOutcome}`, number>),
  ...(Object.fromEntries(DEVTOOLS_ENDPOINT_OUTCOMES.map((outcome) => [`cli_socket_devtools_endpoint_${outcome}`, 0])) as Record<`cli_socket_devtools_endpoint_${DevtoolsEndpointOutcome}`, number>),
  cli_devtools_traces: 0,
  cli_devtools_trace_failures: 0,
  cli_devtools_trace_analysis_ms: 0,
  cli_devtools_field_data_requests: 0,
  cli_devtools_issues_reported: 0,
  cli_devtools_source_maps_resolved: 0,
  cli_devtools_source_maps_failed: 0,
  cli_devtools_style_lookups: 0,
  cli_devtools_logpoints_set: 0,
  cli_devtools_logpoints_refused: 0,
  cli_files_upload_arms: 0,
  cli_files_download_arms: 0,
  cli_files_uploads_answered: 0,
  cli_files_downloads_placed: 0,
  cli_files_arm_failures: 0,
  cli_tab_diagnostics_reads: 0,
  cli_tab_diagnostics_gaps: 0,
  cli_tab_diagnostics_refusals: 0,
  cli_tab_input_refusals: 0,
  cli_tab_input_unacked: 0,
  cli_tab_tools_engine_missing: 0,
  ...(Object.fromEntries(INPUT_ACTIONS.map((action) => [`cli_tab_input_${action}`, 0])) as Record<`cli_tab_input_${InputAction}`, number>),
  ...(Object.fromEntries(SOCKET_FAMILIES.map((family) => [`cli_socket_calls_${family}`, 0])) as Record<`cli_socket_calls_${SocketFamily}`, number>),
  ...(Object.fromEntries(TOKEN_COMMAND_DOMAINS.map((domain) => [`cli_cdp_commands_${domain}`, 0])) as Record<`cli_cdp_commands_${TokenCommandDomain}`, number>),
};

const FIELDS = {
  auto: ["cli_auto_installs", "cli_auto_install_failures"],
  upgrade: ["cli_upgrades", "cli_upgrade_failures"],
  settings: ["cli_settings_installs", "cli_settings_install_failures"],
} as const;

let counts = { ...NONE };
let windowlessSeen = { given: 0, missed: 0 };
let tokenCommandsSeen: Record<TokenCommandDomain, number> = Object.fromEntries(TOKEN_COMMAND_DOMAINS.map((domain) => [domain, 0])) as Record<TokenCommandDomain, number>;

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
export const noteDoorbellShown = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts.cli_socket_doorbells_shown++);
export const noteDoorbellOutcome = (outcome: DoorbellOutcome, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void counts[`cli_socket_doorbell_${outcome}`]++);
export const noteDevtoolsEndpoint = (outcome: DevtoolsEndpointOutcome, consent?: ConsentToken | null) =>
  countFor(consentOrNow(consent), () => void counts[`cli_socket_devtools_endpoint_${outcome}`]++);
export type DevToolsCount = "traces" | "trace_failures" | "trace_analysis_ms" | "field_data_requests" | "issues_reported" | "source_maps_resolved" | "source_maps_failed" | "style_lookups" | "logpoints_set" | "logpoints_refused";
export function noteDevTools(kind: DevToolsCount, amount = 1, consent?: ConsentToken | null) {
  const add = Math.max(0, Math.round(amount));
  if (add) countFor(consentOrNow(consent), () => void (counts[`cli_devtools_${kind}`] += add));
}
export type FileArmCount = "upload_arms" | "download_arms" | "uploads_answered" | "downloads_placed" | "arm_failures";
export function noteFileArm(kind: FileArmCount, amount = 1, consent?: ConsentToken | null) {
  const add = Math.max(0, Math.round(amount));
  if (add) countFor(consentOrNow(consent), () => void (counts[`cli_files_${kind}`] += add));
}
export type TabToolOutcome = "done" | "refused" | "missing";
export function noteTabDiagnostics(outcome: TabToolOutcome, gap: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    if (outcome === "done") counts.cli_tab_diagnostics_reads++;
    else if (outcome === "refused") counts.cli_tab_diagnostics_refusals++;
    else counts.cli_tab_tools_engine_missing++;
    if (gap) counts.cli_tab_diagnostics_gaps++;
  });
}
export function noteTabInput(action: InputAction, outcome: TabToolOutcome, acked: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    if (outcome === "refused") counts.cli_tab_input_refusals++;
    else if (outcome === "missing") counts.cli_tab_tools_engine_missing++;
    else {
      counts[`cli_tab_input_${action}`]++;
      if (!acked) counts.cli_tab_input_unacked++;
    }
  });
}
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

let windowlessBaselineStale = false;
let tokenCommandsBaselineStale = false;
onConsentPeriodChange(() => {
  windowlessBaselineStale = true;
  tokenCommandsBaselineStale = true;
});

export function noteWindowlessPages(totals: { given: number; missed: number } | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const token = consentOrNow(consent);
  const fresh = stillValid(token) && !windowlessBaselineStale;
  if (stillValid(token)) windowlessBaselineStale = false;
  const given = Number(totals.given) || 0, missed = Number(totals.missed) || 0;
  const newlyGiven = fresh ? Math.max(0, given - windowlessSeen.given) : 0;
  const newlyMissed = fresh ? Math.max(0, missed - windowlessSeen.missed) : 0;
  windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
  if (newlyGiven || newlyMissed) {
    countFor(token, () => {
      counts.windowless_pages_given_geometry += newlyGiven;
      counts.windowless_pages_missing_geometry += newlyMissed;
    });
  }
}

export function noteTokenCommands(totals: TokenCommandTotals | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const token = consentOrNow(consent);
  const fresh = stillValid(token) && !tokenCommandsBaselineStale;
  if (stillValid(token)) tokenCommandsBaselineStale = false;
  const sent = TOKEN_COMMAND_DOMAINS.map((domain) => {
    const total = Number(totals[domain]) || 0;
    const delta = fresh ? Math.max(0, total - tokenCommandsSeen[domain]) : 0;
    tokenCommandsSeen[domain] = Math.max(total, tokenCommandsSeen[domain]);
    return [domain, delta] as const;
  });
  if (sent.some(([, delta]) => delta)) countFor(token, () => sent.forEach(([domain, delta]) => (counts[`cli_cdp_commands_${domain}`] += delta)));
}

const PAGE_SIGNAL_FIELDS = {
  consoleReads: "cli_page_signal_console_reads",
  focusedOrigins: "cli_page_signal_focused_origins",
  originMismatches: "cli_page_signal_origin_mismatches",
  hitTests: "cli_page_signal_hit_tests",
  hitTestsFailed: "cli_page_signal_hit_tests_failed",
  hitTestsCancelled: "cli_page_signal_hit_tests_cancelled",
  remoteFrames: "cli_page_signal_remote_frames",
  occluded: "cli_page_signal_occluded",
} as const;
type PageSignalTotals = Partial<Record<keyof typeof PAGE_SIGNAL_FIELDS, number>>;

let pageSignalsSeen: Record<keyof typeof PAGE_SIGNAL_FIELDS, number> = { consoleReads: 0, focusedOrigins: 0, originMismatches: 0, hitTests: 0, hitTestsFailed: 0, hitTestsCancelled: 0, remoteFrames: 0, occluded: 0 };
let pageSignalsBaselineStale = false;
onConsentPeriodChange(() => void (pageSignalsBaselineStale = true));

export function notePageSignals(totals: PageSignalTotals | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const token = consentOrNow(consent);
  const fresh = stillValid(token) && !pageSignalsBaselineStale;
  if (stillValid(token)) pageSignalsBaselineStale = false;
  const keys = Object.keys(PAGE_SIGNAL_FIELDS) as (keyof typeof PAGE_SIGNAL_FIELDS)[];
  const sent = keys.map((key) => {
    const total = Number(totals[key]) || 0;
    const delta = fresh ? Math.max(0, total - pageSignalsSeen[key]) : 0;
    pageSignalsSeen[key] = Math.max(total, pageSignalsSeen[key]);
    return [key, delta] as const;
  });
  if (sent.some(([, delta]) => delta)) countFor(token, () => sent.forEach(([key, delta]) => (counts[PAGE_SIGNAL_FIELDS[key]] += delta)));
}

let engineCliSeen: Record<EngineCliTotalKey, number> = Object.fromEntries(Object.keys(ENGINE_CLI_TOTALS).map((key) => [key, 0])) as Record<EngineCliTotalKey, number>;
let engineCliBaselineStale = false;
onConsentPeriodChange(() => void (engineCliBaselineStale = true));

export function noteEngineCli(totals: EngineCliTotals | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const token = consentOrNow(consent);
  const fresh = stillValid(token) && !engineCliBaselineStale;
  if (stillValid(token)) engineCliBaselineStale = false;
  const keys = Object.keys(ENGINE_CLI_TOTALS) as EngineCliTotalKey[];
  const sent = keys.map((key) => {
    const total = Number(totals[key]) || 0;
    const delta = fresh ? Math.max(0, total - engineCliSeen[key]) : 0;
    engineCliSeen[key] = Math.max(total, engineCliSeen[key]);
    return [key, delta] as const;
  });
  if (sent.some(([, delta]) => delta)) countFor(token, () => sent.forEach(([key, delta]) => (counts[`cli_engine_${ENGINE_CLI_TOTALS[key]}`] += delta)));
}

export function noteEngineCliTotals(
  status: { windowlessPages?: { given: number; missed: number }; tokenCommands?: TokenCommandTotals; pageSignals?: PageSignalTotals; engineCli?: EngineCliTotals },
  consent: ConsentToken,
) {
  noteWindowlessPages(status.windowlessPages, consent);
  noteTokenCommands(status.tokenCommands, consent);
  notePageSignals(status.pageSignals, consent);
  noteEngineCli(status.engineCli, consent);
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
