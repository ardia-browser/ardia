import { consentListing, type PluginRecord, type PluginsStore } from "./store";

export type ConsentVerb = "install" | "update" | "turnOn";

export const CONSENT_WORDS: Readonly<Record<ConsentVerb, { title: string; button: string; done: string }>> = {
  install: { title: "Install", button: "Install", done: "Installed" },
  update: { title: "Update", button: "Update", done: "Updated" },
  turnOn: { title: "Turn on", button: "Turn On", done: "Turned On" },
};

export const consentSource = (official: boolean, version: string | null) => [official ? "Official" : "From Your Plugins Folder", ...(version ? [`Version ${version}`] : [])].join(" · ");

export function consentVerb(official: boolean, record: Pick<PluginRecord, "approved"> | undefined, hash: string): ConsentVerb {
  if (!official) return "turnOn";
  return record?.approved && record.approved !== hash ? "update" : "install";
}

export const consentVerbOf = (s: Pick<PluginsStore, "listings" | "candidates" | "records">, name: string, hash: string): ConsentVerb =>
  consentVerb(!!consentListing(s, name, hash)?.manifest?.official, Object.hasOwn(s.records, name) ? s.records[name] : undefined, hash);
