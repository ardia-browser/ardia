import { listExtensions, type InstalledExtension } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { engineProfiles } from "../profiles/engineProfiles";
import type { ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { useExtensions } from "./store";
import { t } from "../../lib/uiLanguage";


const EMPTY: InstalledExtension[] = [];

const loading = new Map<string, Promise<InstalledExtension[]>>();

function fetchList(profile: string): Promise<InstalledExtension[]> {
  if (!engineProfiles(useBrowser.getState()).includes(profile)) return Promise.reject(new Error(`No open profile ${profile} to list extensions for`));
  const running = loading.get(profile);
  if (running) return running;
  const job = listExtensions(profile)
    .then((list) => {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      useExtensions.setState((e) => ({ lists: { ...e.lists, [profile]: list } }));
      return list;
    })
    .finally(() => loading.delete(profile));
  loading.set(profile, job);
  return job;
}

const cachedOnFailure = (profile: string, consent: ConsentToken | null) => (error: unknown) => {
  if (consent) warnFor(consent, t(`[extensions] list failed`), error);
  return useExtensions.getState().lists[profile] ?? EMPTY;
};

export function refreshExtensions(profile: string, consent: ConsentToken | null = null): Promise<InstalledExtension[]> {
  if (!engineProfiles(useBrowser.getState()).includes(profile)) return Promise.resolve(useExtensions.getState().lists[profile] ?? EMPTY);
  return fetchList(profile).catch(cachedOnFailure(profile, consent));
}

export function freshExtensions(profile: string): Promise<InstalledExtension[]> {
  const running = loading.get(profile);
  return running ? running.catch(() => EMPTY).then(() => fetchList(profile)) : fetchList(profile);
}

export function refreshExtensionsAfterChange(profile: string, consent: ConsentToken | null = null): Promise<InstalledExtension[]> {
  if (!engineProfiles(useBrowser.getState()).includes(profile)) return Promise.resolve(useExtensions.getState().lists[profile] ?? EMPTY);
  return freshExtensions(profile).catch(cachedOnFailure(profile, consent));
}

export const findExtension = (profile: string, id: string) => useExtensions.getState().lists[profile]?.find((x) => x.id === id);
