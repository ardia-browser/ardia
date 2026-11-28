import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const counts = { read: 0, reuse: 0, menuSync: 0 };

type ShortcutListStep = keyof typeof counts;

export const noteShortcutList = (step: ShortcutListStep, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (counts[step] += 1));

export function takeShortcutListCounts() {
  const taken = { shortcut_list_reads: counts.read, shortcut_list_reuses: counts.reuse, shortcut_list_menu_syncs: counts.menuSync };
  counts.read = 0;
  counts.reuse = 0;
  counts.menuSync = 0;
  return taken;
}
