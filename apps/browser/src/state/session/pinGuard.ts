import type { BrowserState } from "../browser/store";
import { isIncognitoProfile, pinKeyOf } from "../browser/model";
import { parkWindowPins } from "../pins/parkedPins";
import { isRegularWindow } from "../windows/small";
import { isFields } from "../../lib/decode";
import type { ParkedPins } from "../browser/types";

export const PINS_BACKUP_DOCUMENT = "pins-backup.json";
export const PINS_BACKUP_VERSION = 1;
export const MAX_PIN_BACKUPS = 20;

export type PinState = Pick<BrowserState, "windows" | "tabs" | "groups" | "splits" | "parkedPins" | "profiles" | "history">;
export type PinCensus = Map<string, Set<string>>;
export type PinBackup = { at: number; profileId: string; dropped: number; pins: ParkedPins };
export type PinBackups = { version: number; backups: PinBackup[] };

export const pinSources = (s: PinState): unknown[] => [s.windows, s.tabs, s.groups, s.parkedPins];

export function pinCensus(s: PinState): PinCensus {
  const census: PinCensus = new Map();
  const add = (profileId: string, key: string) => {
    if (isIncognitoProfile(profileId)) return;
    const keys = census.get(profileId);
    if (keys) keys.add(key);
    else census.set(profileId, new Set([key]));
  };
  for (const w of Object.values(s.windows)) {
    if (!isRegularWindow(w)) continue;
    for (const id of w.tabIds) {
      const t = s.tabs[id];
      if (t?.pin) add(t.profileId, pinKeyOf(t));
    }
  }
  for (const g of Object.values(s.groups)) {
    if (!g.pinned || !isRegularWindow(s.windows[g.windowId])) continue;
    add(g.profileId, `g:${pinKeyOf(g)}`);
    for (const id of g.tabIds) {
      const t = s.tabs[id];
      if (t) add(t.profileId, pinKeyOf(t));
    }
  }
  for (const [profileId, park] of Object.entries(s.parkedPins)) {
    for (const t of park.tabs) add(profileId, t.id);
    for (const g of park.groups) add(profileId, `g:${g.id}`);
  }
  return census;
}

export function droppedPins(before: PinCensus, after: PinCensus, profiles: PinState["profiles"]): Map<string, number> {
  const dropped = new Map<string, number>();
  for (const [profileId, keys] of before) {
    if (!profiles[profileId]) continue;
    const now = after.get(profileId);
    let gone = 0;
    for (const key of keys) if (!now?.has(key)) gone++;
    if (gone) dropped.set(profileId, gone);
  }
  return dropped;
}

export function pinsOf(s: PinState, profileIds: string[]): Record<string, ParkedPins> {
  const wanted = new Set(profileIds);
  let parked: Record<string, ParkedPins> = Object.fromEntries(Object.entries(s.parkedPins).filter(([p]) => wanted.has(p)));
  for (const w of Object.values(s.windows)) if (isRegularWindow(w)) parked = parkWindowPins(parked, w, { ...s, windows: { [w.id]: w } });
  return Object.fromEntries(
    Object.entries(parked)
      .filter(([p]) => wanted.has(p))
      .map(([p, park]) => [p, { ...park, tabs: park.tabs.map(({ restoreFrom: _, ...t }) => t) }]),
  );
}

export function parsePinBackups(json: string | null | undefined): PinBackup[] {
  try {
    const raw: unknown = json ? JSON.parse(json) : null;
    if (!isFields(raw) || !Array.isArray(raw.backups)) return [];
    return raw.backups.filter((b): b is PinBackup => isFields(b) && typeof b.profileId === "string" && isFields(b.pins) && Array.isArray(b.pins.tabs));
  } catch {
    return [];
  }
}

export function withPinBackups(existing: PinBackup[], previous: PinState, dropped: Map<string, number>, at: number): PinBackups {
  const pins = pinsOf(previous, [...dropped.keys()]);
  const added = [...dropped].filter(([p]) => pins[p]).map(([profileId, n]): PinBackup => ({ at, profileId, dropped: n, pins: pins[profileId]! }));
  return { version: PINS_BACKUP_VERSION, backups: [...existing, ...added].slice(-MAX_PIN_BACKUPS) };
}
