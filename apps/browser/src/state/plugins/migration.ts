import { adoptLegacyPlugin, type PluginLegacyAdoption } from "../../platform/plugins";
import type { ConsentToken } from "../telemetry/consentPeriod";
import { notePlugin } from "../telemetry/pluginCounts";
import { warnFor } from "../telemetry/consoleConsent";
import { currentLock, updateLock } from "./lockfile";
import { defaultRegistryUrl } from "./registryKeys";
import { pluginRecordsSaved, pluginsExtras, writePluginsExtras } from "./savedState";
import { commitPlugins, currentPlugins, type PluginRecord } from "./store";

export const LEGACY_ADOPTIONS: readonly { from: string; id: string; key: string }[] = [{ from: "cli", id: "@ardia/cli", key: "ardia__cli" }];

type Legacy = (typeof LEGACY_ADOPTIONS)[number];

export function adoptedRecord(old: PluginRecord): PluginRecord {
  const { approved: _approved, previous: _previous, updated: _updated, installed: _installed, pendingUpdate: _pending, revoked: _revoked, preapproved: _preapproved, ...rest } = old;
  return { ...rest, enabled: false, approved: null, applied: {}, ...(old.enabled ? { preapproved: true as const } : {}) };
}

async function carryRecord(legacy: Legacy, consent: ConsentToken | null): Promise<boolean> {
  const records = currentPlugins().records;
  const old = records[legacy.from];
  if (!old) return true;
  const next: Record<string, PluginRecord> = { ...records };
  delete next[legacy.from];
  if (!next[legacy.key] && old.approved) next[legacy.key] = adoptedRecord(old);
  if (!writePluginsExtras(pluginsExtras(), next, consent)) return false;
  commitPlugins({ records: next });
  return pluginRecordsSaved(consent);
}

async function pendLock(legacy: Legacy, consent: ConsentToken | null): Promise<boolean> {
  if (currentLock()[legacy.id]) return true;
  return updateLock(
    (now) => ({
      ...now,
      [legacy.id]: { id: legacy.id, key: legacy.key, version: null, channel: "latest", source: { kind: "registry", url: defaultRegistryUrl() }, sha256: null, payloadDigest: null, dependencies: [], root: true, official: true, installedAt: Date.now(), pending: "migration" },
    }),
    consent,
  );
}

export async function migrateLegacyPlugins(consent: ConsentToken | null): Promise<string[]> {
  const done: string[] = [];
  for (const legacy of LEGACY_ADOPTIONS) {
    if (pluginsExtras().migrated.includes(legacy.from)) continue;
    const old = currentPlugins().records[legacy.from];
    const moved: PluginLegacyAdoption = await adoptLegacyPlugin(legacy.from, legacy.key).catch((error: unknown) => ({ ok: false, found: false, moved: [], reason: String(error) }));
    if (!moved.ok) {
      warnFor(consent, `[plugins] ${legacy.from} couldn't be moved to ${legacy.id}: ${moved.reason ?? "unknown"}`);
      notePlugin("migrations_failed", consent);
      continue;
    }
    const wanted = !!old?.approved && (old.enabled || moved.found);
    if (wanted && !(await pendLock(legacy, consent))) continue;
    if (!(await carryRecord(legacy, consent))) continue;
    if (wanted) {
      notePlugin("migrations_found", consent);
      done.push(legacy.id);
    }
    if (moved.leftover) continue;
    const extras = { ...pluginsExtras(), migrated: [...pluginsExtras().migrated, legacy.from] };
    if (writePluginsExtras(extras, currentPlugins().records, consent)) await pluginRecordsSaved(consent);
  }
  return done;
}

export const migratingKeys = (lock: Record<string, { key: string; pending?: "migration" }>): string[] =>
  Object.values(lock)
    .filter((entry) => entry.pending === "migration")
    .map((entry) => entry.key);
