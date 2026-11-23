import { useMemo } from "react";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { OFFICIAL_CREDENTIAL_PROVIDERS, type OfficialEntry } from "./officialPin";
import { activeManifest, recordApproves, usePlugins, type PluginListing, type PluginsStore } from "./store";

export type OfficialCredentialProviderState = "available" | "installed" | "unsupported";

export type OfficialCredentialProvider = { name: string; title: string; blurb: string; icon: string; symbol: string; accent: string | null; state: OfficialCredentialProviderState; enabled: boolean };

type PinnedCredential = { name: string; credentialPrograms?: readonly string[]; credentialProvider?: boolean; title?: string; blurb?: string; icon?: string; symbol?: string; accent?: string };

type CredentialView = Pick<PluginsStore, "listings" | "records" | "order"> & Partial<Pick<PluginsStore, "pinned" | "candidates">>;

const has = <T>(record: Readonly<Record<string, T>> | undefined, name: string): T | undefined => (record && Object.hasOwn(record, name) ? record[name] : undefined);

const officialWith = (listing: PluginListing | undefined) => (listing?.official && listing.manifest?.contributes.credentialProvider ? listing : undefined);

const pinnedAsProvider = (p: PinnedCredential) => p.credentialProvider === true || (p.credentialPrograms ?? []).length > 0;

export function officialCredentialProviders(s: CredentialView, supported: boolean = PLATFORM_FEATURES.plugins): OfficialCredentialProvider[] {
  const pinned = (s.pinned ?? []) as readonly PinnedCredential[];
  const entries = new Map<string, OfficialEntry>(OFFICIAL_CREDENTIAL_PROVIDERS.map((e) => [e.name, e]));
  for (const p of pinned) if (pinnedAsProvider(p) && !entries.has(p.name)) entries.set(p.name, { name: p.name, title: p.title ?? "", blurb: p.blurb ?? "", icon: p.icon ?? "" });
  for (const name of s.order) if (officialWith(has(s.listings, name)) && !entries.has(name)) entries.set(name, { name, title: "", blurb: "", icon: "" });
  for (const name of Object.keys(s.candidates ?? {})) if (officialWith(has(s.candidates, name)) && !entries.has(name)) entries.set(name, { name, title: "", blurb: "", icon: "" });
  return [...entries.values()].map((entry) => {
    const listing = officialWith(has(s.listings, entry.name));
    const m = listing?.manifest ?? officialWith(has(s.candidates, entry.name))?.manifest;
    const provider = m?.contributes.credentialProvider ?? null;
    const offered = !!listing || pinned.some((p) => p.name === entry.name);
    const record = has(s.records, entry.name);
    const pin = pinned.find((p) => p.name === entry.name);
    const enabled = !!listing && !!activeManifest(s, entry.name);
    const state: OfficialCredentialProviderState = !supported || !offered ? "unsupported" : enabled || (listing && recordApproves(listing, record)) ? "installed" : "available";
    return {
      name: entry.name,
      title: provider?.title ?? m?.title ?? (entry.title || entry.name),
      blurb: m?.description || entry.blurb,
      icon: m?.icon ?? (entry.icon || provider?.symbol || "key.fill"),
      symbol: provider?.symbol ?? (pin?.symbol || entry.icon || "key.fill"),
      accent: provider?.accent ?? (pin?.accent || null),
      state,
      enabled: state === "installed" && enabled,
    };
  });
}

export function useOfficialCredentialProviders(): OfficialCredentialProvider[] {
  const key = usePlugins((s) => JSON.stringify(officialCredentialProviders(s)));
  return useMemo(() => JSON.parse(key) as OfficialCredentialProvider[], [key]);
}
