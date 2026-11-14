export type CliInstallReason = "auto" | "settings" | "upgrade";

const NONE = {
  cli_pill_shows: 0,
  cli_auto_installs: 0,
  cli_auto_install_failures: 0,
  cli_auto_enables: 0,
  cli_upgrades: 0,
  cli_upgrade_failures: 0,
  cli_settings_installs: 0,
  cli_settings_install_failures: 0,
};

const FIELDS = {
  auto: ["cli_auto_installs", "cli_auto_install_failures"],
  upgrade: ["cli_upgrades", "cli_upgrade_failures"],
  settings: ["cli_settings_installs", "cli_settings_install_failures"],
} as const;

let counts = { ...NONE };

export const noteCliInstall = (reason: CliInstallReason, ok: boolean) => void counts[FIELDS[reason][ok ? 0 : 1]]++;
export const noteCliPillShown = () => void counts.cli_pill_shows++;
export const noteCliAutoEnabled = () => void counts.cli_auto_enables++;

export function takeCliCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}
