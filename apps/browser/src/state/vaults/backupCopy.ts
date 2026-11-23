import type { VaultBackupStatus } from "../../platform/vaults";
import { ago } from "../live/meetings";

export function backupLine(status: VaultBackupStatus | null, now: number): string | undefined {
  if (!status) return undefined;
  switch (status.state) {
    case "off":
      return undefined;
    case "never":
      return "Not backed up yet";
    case "backedUp":
      return status.backedUpAt ? `Backed up ${ago(status.backedUpAt, now)}` : "Not backed up yet";
    case "waitingForKeychain":
      return "Waiting for iCloud Keychain";
    case "waitingForICloud":
      return "Waiting for iCloud Drive";
    case "deleted":
      return "Not syncing";
    case "needsUpdate":
      return "Update Ardia to keep syncing";
    case "failed":
      return status.problem === "unreadable" ? "Couldn't read your passwords. Try again later." : "Couldn't back up. Check that iCloud Drive is on.";
  }
}

export const restoreLine = (count: number) => (count === 1 ? "1 login isn't on this Mac" : `${count} logins aren't on this Mac`);

export function restoredLine(restored: number, failed: number): string {
  if (failed && !restored) return "Couldn't restore. Try again.";
  if (failed) return `Restored ${restored}. ${failed} didn't restore; try again.`;
  return restored === 1 ? "Restored 1 login" : `Restored ${restored} logins`;
}

export const updateLine = (count: number) => (count === 1 ? "1 password changed on another Mac" : `${count} passwords changed on another Mac`);

export const updateTitle = (count: number) => (count === 1 ? "Update 1 Password from iCloud" : `Update ${count} Passwords from iCloud`);

export function updatedLine(updated: number, failed: number): string {
  if (failed && !updated) return "Couldn't update. Try again.";
  if (failed) return `Updated ${updated}. ${failed} didn't update; try again.`;
  return updated === 1 ? "Updated 1 password" : `Updated ${updated} passwords`;
}
