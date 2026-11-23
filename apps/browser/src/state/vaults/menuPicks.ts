import type { VaultFillField, VaultFillTarget, VaultItem } from "../../platform/vaults";

export const CONTEXT_TARGET: VaultFillTarget = "contextMenu";

const contextPicks = new Map<string, { menuSeq: number; fields: VaultFillField[] }>();
const codePicks = new Map<string, { menuSeq: number; onPick: (item: VaultItem) => void }>();

export const markContextPick = (tabId: string, menuSeq: number, fields: VaultFillField[]) => void contextPicks.set(tabId, { menuSeq, fields });

export function contextPickOf(tabId: string, menuSeq: number): { fields: VaultFillField[]; target: VaultFillTarget; submit: false } | null {
  const pick = contextPicks.get(tabId);
  if (!pick || pick.menuSeq !== menuSeq) return null;
  return { fields: pick.fields, target: CONTEXT_TARGET, submit: false };
}

export const contextTargetOf = (tabId: string, menuSeq: number): { target?: VaultFillTarget } =>
  contextPicks.get(tabId)?.menuSeq === menuSeq ? { target: CONTEXT_TARGET } : {};

export const forgetContextPick = (tabId: string) => void contextPicks.delete(tabId);

export const markCodePick = (tabId: string, menuSeq: number, onPick: (item: VaultItem) => void) => void codePicks.set(tabId, { menuSeq, onPick });

export function takeCodePick(tabId: string, menuSeq: number): ((item: VaultItem) => void) | null {
  const pick = codePicks.get(tabId);
  if (!pick || pick.menuSeq !== menuSeq) return null;
  codePicks.delete(tabId);
  return pick.onPick;
}

export const forgetCodePick = (tabId: string) => void codePicks.delete(tabId);

export function forgetPicksOutside(tabs: Readonly<Record<string, unknown>>) {
  for (const picks of [contextPicks, codePicks]) for (const tabId of picks.keys()) if (!(tabId in tabs)) picks.delete(tabId);
}
