import { onConsentPeriodChange, stillValid, type ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";
import { SOCKET_FAMILIES, type SocketFamily } from "../automation/socketCatalog";

const TOKEN_COMMAND_DOMAINS = ["accessibility", "browser", "dom", "emulation", "fetch", "input", "network", "page", "runtime", "storage", "target", "other"] as const;
type TokenCommandDomain = (typeof TOKEN_COMMAND_DOMAINS)[number];
type TokenCommandTotals = Partial<Record<TokenCommandDomain, number>>;

export type CliInstallReason = "auto" | "settings" | "upgrade";

const DOORBELL_OUTCOMES = ["once", "half_hour", "always", "deny", "unshown", "timeout", "left", "stopped", "unsaved"] as const;
export type DoorbellOutcome = (typeof DOORBELL_OUTCOMES)[number];

const DEVTOOLS_ENDPOINT_OUTCOMES = ["given", "control_off", "unsupported", "server_off", "unreadable", "stale", "left"] as const;
export type DevtoolsEndpointOutcome = (typeof DEVTOOLS_ENDPOINT_OUTCOMES)[number];

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
  ...(Object.fromEntries(DOORBELL_OUTCOMES.map((outcome) => [`cli_socket_doorbell_${outcome}`, 0])) as Record<`cli_socket_doorbell_${DoorbellOutcome}`, number>),
  ...(Object.fromEntries(DEVTOOLS_ENDPOINT_OUTCOMES.map((outcome) => [`cli_socket_devtools_endpoint_${outcome}`, 0])) as Record<`cli_socket_devtools_endpoint_${DevtoolsEndpointOutcome}`, number>),
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

export function noteEngineCliTotals(status: { windowlessPages?: { given: number; missed: number }; tokenCommands?: TokenCommandTotals }, consent: ConsentToken) {
  noteWindowlessPages(status.windowlessPages, consent);
  noteTokenCommands(status.tokenCommands, consent);
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
