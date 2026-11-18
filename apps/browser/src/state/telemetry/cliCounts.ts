import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

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
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

export function noteWindowlessPages(totals: { given: number; missed: number } | undefined, consent?: ConsentToken | null) {
  if (!totals) return;
  const given = Number(totals.given) || 0, missed = Number(totals.missed) || 0;
  const added = { windowless_pages_given_geometry: Math.max(0, given - windowlessSeen.given), windowless_pages_missing_geometry: Math.max(0, missed - windowlessSeen.missed) };
  windowlessSeen = { given: Math.max(given, windowlessSeen.given), missed: Math.max(missed, windowlessSeen.missed) };
  if (added.windowless_pages_given_geometry || added.windowless_pages_missing_geometry)
    countFor(consent, () => void ((counts.windowless_pages_given_geometry += added.windowless_pages_given_geometry), (counts.windowless_pages_missing_geometry += added.windowless_pages_missing_geometry)), added);
}

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
