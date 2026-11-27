import type { Adapter, Extraction } from "../../platform/sync";
import type { Tab } from "../browser/types";
import { PIN_TAB, PIN_LETTERS } from "./pinRecords";
import { commitPinnedEdit, homeWindow, store, unpinnedRemotely, windowsHomeFirst } from "./pinnedSyncState";
import { pinKeyOf } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { cleanTileLetters } from "../../lib/tileLetter";

const NO_LETTERS = "";

function localPinKeys(profileId: string): Set<string> {
  const s = store();
  const keys = new Set<string>();
  const members = pinnedGroupMembers(s.groups);
  for (const t of Object.values(s.tabs)) if (t.profileId === profileId && (t.pin || members.has(t.id))) keys.add(pinKeyOf(t));
  for (const p of s.parkedPins[profileId]?.tabs ?? []) keys.add(p.id);
  return keys;
}

export function pinnedLettersAdapter(profileId: string): Adapter {
  const keyOf = (k: string) => k.slice(PIN_LETTERS.length);
  let unpinned: (key: string) => boolean = () => false;
  return {
    prefix: PIN_LETTERS,
    extract: (base, _queued, _now, recorded, remote) => {
      const s = store();
      const values = new Map<string, unknown>();
      const known = new Set<string>();
      const offer = (key: string, letters: string | undefined) => {
        if (known.has(key)) return;
        known.add(key);
        const k = `${PIN_LETTERS}${key}`;
        if (letters) values.set(k, cleanTileLetters(base(k)) === letters ? base(k) : letters);
        else if (base(k) !== undefined) values.set(k, NO_LETTERS);
      };
      const members = pinnedGroupMembers(s.groups);
      for (const w of windowsHomeFirst(s, homeWindow(s, profileId))) {
        for (const id of w.tabIds) {
          const t = s.tabs[id];
          if (t?.profileId === profileId && (t.pin || members.has(id))) offer(pinKeyOf(t), t.tileLetters);
        }
      }
      for (const p of s.parkedPins[profileId]?.tabs ?? []) offer(p.id, p.tileLetters);
      unpinned = unpinnedRemotely(recorded, remote);
      return {
        values,
        ignore: (k) => !known.has(keyOf(k)) && base(`${PIN_TAB}${keyOf(k)}`) === undefined && !unpinned(keyOf(k)),
      } satisfies Extraction;
    },
    apply: (visible, changed, _base, records) => {
      const pins = localPinKeys(profileId);
      const gone = (key: string) => unpinned(key);
      const incoming = new Map<string, string | undefined>();
      for (const k of changed) {
        const letters = cleanTileLetters(visible.get(k)) ?? undefined;
        const key = keyOf(k);
        if (!pins.has(key) && letters && !gone(key)) records.defer(k);
        else incoming.set(key, letters);
      }
      if (!incoming.size) return true;
      const s = store();
      const members = pinnedGroupMembers(s.groups);
      let tabs: Record<string, Tab> | null = null;
      for (const t of Object.values(s.tabs)) {
        if (t.profileId !== profileId || !(t.pin || members.has(t.id)) || !incoming.has(pinKeyOf(t))) continue;
        const letters = incoming.get(pinKeyOf(t));
        if (letters !== t.tileLetters) (tabs ??= { ...s.tabs })[t.id] = { ...t, tileLetters: letters };
      }
      const park = s.parkedPins[profileId];
      const parked = park?.tabs.map((p) => (!incoming.has(p.id) || incoming.get(p.id) === p.tileLetters ? p : { ...p, tileLetters: incoming.get(p.id) }));
      const parkEdited = !!park && parked!.some((p, i) => p !== park.tabs[i]);
      if (!tabs && !parkEdited) return true;
      commitPinnedEdit(s, profileId, tabs ? { tabs } : {}, parkEdited ? { tabs: parked! } : null);
      return true;
    },
  };
}
