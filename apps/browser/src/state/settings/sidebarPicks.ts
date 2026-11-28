import type { HLC } from "../../platform/sync";
import { editStamp } from "../sync/editClock";
import { isFields, isString } from "../../lib/decode";

export type SettingPicks = Record<string, HLC>;

const PICKED_WHOLE = ["autoHideTabs", "collapsedSidebar"] as const;

export function withSidebarPicks(picks: SettingPicks | undefined, patch: object): SettingPicks | undefined {
  const written = PICKED_WHOLE.filter((name) => name in patch);
  return written.length ? { ...picks, ...Object.fromEntries(written.map((name) => [name, editStamp()])) } : picks;
}

export const parseSettingPicks = (raw: unknown): SettingPicks | undefined => {
  const kept = isFields(raw) ? Object.entries(raw).filter((entry): entry is [string, HLC] => (PICKED_WHOLE as readonly string[]).includes(entry[0]) && isString(entry[1])) : [];
  return kept.length ? Object.fromEntries(kept) : undefined;
};

export const pickStillOut = (picks: SettingPicks | undefined, name: string, synced: HLC | undefined): HLC | undefined => {
  const at = picks?.[name];
  return at !== undefined && (synced === undefined || synced < at) ? at : undefined;
};

export function picksLeft(picks: SettingPicks | undefined, stampOf: (name: string) => HLC | undefined): SettingPicks | undefined {
  if (!picks) return picks;
  const left = Object.entries(picks).filter(([name, at]) => pickStillOut(picks, name, stampOf(name)) === at);
  return left.length === Object.keys(picks).length ? picks : left.length ? Object.fromEntries(left) : undefined;
}
