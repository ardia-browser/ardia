import { canonical, type Adapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { noteTopAppsSharingFromSync, startedBySync } from "../telemetry/topAppsSharing";
import { PROFILE_TOP_APPS, PROFILE_OPEN_TABS, openTabsRecord, topAppsRecord, type TopAppsRecord, type OpenTabsRecord } from "./records";

const store = () => useBrowser.getState();
type Removed = () => ReadonlySet<string>;
const NOTHING_REMOVED: Removed = () => new Set();

export function spaceTopAppsAdapter(links: () => Record<string, { syncId: string }>, removed: Removed = NOTHING_REMOVED): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().spaces[id]);
  return {
    prefix: PROFILE_TOP_APPS,
    adoptRemoteOnJoin: true,
    extract: (base, _queued, _now, known, remote) => {
      const values = new Map<string, unknown>();
      for (const [id, { syncId }] of linked()) {
        const key = `${PROFILE_TOP_APPS}${syncId}`;
        const on = !!store().spaces[id]!.shareTopApps;
        const unapplied = known(key) && remote(key) !== null && canonical(remote(key)) !== canonical(base(key) ?? null);
        if ((on || known(key)) && !unapplied) values.set(key, { on } satisfies TopAppsRecord);
      }
      const mine = new Set(values.keys());
      const gone = removed();
      return { values, ignore: (key) => !mine.has(key) && !gone.has(key) };
    },
    apply: (visible, changed) => {
      for (const [id, { syncId }] of linked()) {
        const key = `${PROFILE_TOP_APPS}${syncId}`;
        const record = changed.has(key) ? topAppsRecord(visible.get(key)) : null;
        if (!record) continue;
        const changes = record.on !== !!store().spaces[id]!.shareTopApps;
        startedBySync(() => store().updateSpace(id, { shareTopApps: record.on || undefined }));
        if (changes) noteTopAppsSharingFromSync(store(), "synced_record", record.on);
      }
    },
  };
}

export function spaceOpenTabsAdapter(links: () => Record<string, { syncId: string }>, removed: Removed = NOTHING_REMOVED): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().spaces[id]);
  return {
    prefix: PROFILE_OPEN_TABS,
    adoptRemoteOnJoin: true,
    extract: (base, _queued, _now, known, remote) => {
      const values = new Map<string, unknown>();
      for (const [id, { syncId }] of linked()) {
        const key = `${PROFILE_OPEN_TABS}${syncId}`;
        const on = !!store().spaces[id]!.syncTabs;
        const unapplied = known(key) && remote(key) !== null && canonical(remote(key)) !== canonical(base(key) ?? null);
        if ((on || known(key)) && !unapplied) values.set(key, { on } satisfies OpenTabsRecord);
      }
      const mine = new Set(values.keys());
      const gone = removed();
      return { values, ignore: (key) => !mine.has(key) && !gone.has(key) };
    },
    apply: (visible, changed) => {
      for (const [id, { syncId }] of linked()) {
        const key = `${PROFILE_OPEN_TABS}${syncId}`;
        const record = changed.has(key) ? openTabsRecord(visible.get(key)) : null;
        if (record) store().updateSpace(id, { syncTabs: record.on || undefined });
      }
    },
  };
}
