import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";
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
};

const FIELDS = {
  auto: ["cli_auto_installs", "cli_auto_install_failures"],
  upgrade: ["cli_upgrades", "cli_upgrade_failures"],
  settings: ["cli_settings_installs", "cli_settings_install_failures"],
} as const;

let counts = { ...NONE };
let windowlessSeen = { given: 0, missed: 0 };

export const noteCliInstall = (reason: CliInstallReason, ok: boolean, consent?: ConsentToken | null) => countFor(consent, () => void counts[FIELDS[reason][ok ? 0 : 1]]++, { [FIELDS[reason][ok ? 0 : 1]]: 1 });
export function noteCliPillShown(compact: boolean) {
  counts.cli_pill_shows++;
  if (compact) counts.cli_pill_compact_shows++;
}
export function noteSocketCall(family: SocketFamily, failed: boolean, consent?: ConsentToken | null) {
  const field = `cli_socket_calls_${family}` as const;
  countFor(consent, () => void counts[field]++, { [field]: 1 });
  if (failed) countFor(consent, () => void counts.cli_socket_call_failures++, { cli_socket_call_failures: 1 });
}
export const noteSocketLineShrunk = (consent: ConsentToken | null) => countFor(consent, () => void counts.cli_socket_lines_shrunk++, { cli_socket_lines_shrunk: 1 });
export const noteSocketPasswordManagerRefused = (consent: ConsentToken | null) =>
  countFor(consent, () => void counts.cli_socket_password_manager_refusals++, { cli_socket_password_manager_refusals: 1 });
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

export function noteWindowlessPages(totals: { given: number; missed: number } | undefined) {
  if (!totals) return;
  const given = Number(totals.given) || 0, missed = Number(totals.missed) || 0;
  counts.windowless_pages_given_geometry += Math.max(0, given - windowlessSeen.given);
  counts.windowless_pages_missing_geometry += Math.max(0, missed - windowlessSeen.missed);
  windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
