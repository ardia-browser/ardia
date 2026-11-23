import type { VaultFieldRect } from "../../platform/vaults";

type ShownMenu = { seq: number; hidden: boolean; rect: VaultFieldRect | null };

const MENU_JUMP_PT = 4;
const shownAt = new Map<string, number>();

const jumped = (before: VaultFieldRect | null, after: VaultFieldRect | null) =>
  !before || !after || Math.abs(before.x - after.x) > MENU_JUMP_PT || Math.abs(before.y - after.y) > MENU_JUMP_PT || Math.abs(before.height - after.height) > MENU_JUMP_PT;

export function noteMenuShown(tabId: string, before: ShownMenu | null, after: ShownMenu | null) {
  if (!after) return void shownAt.delete(tabId);
  if (after.hidden) return;
  if (!before || before.seq !== after.seq || before.hidden || jumped(before.rect, after.rect)) shownAt.set(tabId, Date.now());
}

export const vaultMenuShownFor = (tabId: string, now = Date.now()) => now - (shownAt.get(tabId) ?? -Infinity);
