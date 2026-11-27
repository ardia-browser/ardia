import { canonical, type Adapter } from "../../platform/sync";
import { editStamp } from "./editClock";
import { settingOf, SYNCED_SETTINGS } from "./settingsAdapter";
import type { SyncDoc } from "./syncDoc";
import { onSettingsChosen } from "../settings/settingsPatch";

const synced: ReadonlySet<string> = new Set(SYNCED_SETTINGS);

export function recordSettingEdits(doc: SyncDoc, names: string[]): boolean {
  const edited = names.filter((name) => synced.has(name));
  if (!doc.enabled || !edited.length) return false;
  const stamp = editStamp();
  doc.settingEdits = { ...doc.settingEdits, ...Object.fromEntries(edited.map((name) => [name, stamp])) };
  return true;
}

export const watchSettingEdits = (current: () => SyncDoc, recorded: () => void) => onSettingsChosen((names) => void (recordSettingEdits(current(), names) && recorded()));

export function withSettingEdits(adapter: Adapter, doc: SyncDoc): Adapter {
  return {
    ...adapter,
    extract: async (base, queued, now, known, remote, stamp, baseJson) => {
      const extraction = await adapter.extract(base, queued, now, known, remote, stamp, baseJson);
      if (!extraction) return extraction;
      const covered = { ...doc.settingEdits };
      const newerHere = (key: string) => {
        const edited = doc.settingEdits?.[settingOf(key)];
        const synced = stamp(key);
        return !!edited && (synced === undefined || edited > synced);
      };
      return {
        ...extraction,
        keepLocal: newerHere,
        republish: (key) => !!extraction.republish?.(key) || (newerHere(key) && !queued(key) && remote(key) !== undefined && canonical(remote(key)) !== baseJson(key)),
        published: (keys) => {
          extraction.published?.(keys);
          const sent = new Set([...keys].map(settingOf));
          const left = Object.entries(doc.settingEdits ?? {}).filter(([name, edited]) => !sent.has(name) || covered[name] !== edited);
          if (left.length) doc.settingEdits = Object.fromEntries(left);
          else delete doc.settingEdits;
        },
      };
    },
  };
}
