import { consentListing, type PluginRecord, type PluginsStore } from "./store";

export type ConsentVerb = "install" | "update" | "turnOn";

export const CONSENT_WORDS: Readonly<Record<ConsentVerb, { title: string; button: string }>> = {
  install: { title: "Install", button: "Install" },
  update: { title: "Update", button: "Update" },
  turnOn: { title: "Turn on", button: "Turn On" },
};

export function consentVerb(official: boolean, record: Pick<PluginRecord, "approved"> | undefined, hash: string): ConsentVerb {
  if (!official) return "turnOn";
  return record?.approved && record.approved !== hash ? "update" : "install";
}

export const consentVerbOf = (s: Pick<PluginsStore, "listings" | "candidates" | "records">, name: string, hash: string): ConsentVerb =>
  consentVerb(!!consentListing(s, name, hash)?.manifest?.official, Object.hasOwn(s.records, name) ? s.records[name] : undefined, hash);
