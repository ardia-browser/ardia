import { consentListing, type PluginRecord, type PluginsStore } from "./store";
import { t } from "../../lib/uiLanguage";


export type ConsentVerb = "install" | "update" | "turnOn";

export const CONSENT_WORDS: Readonly<Record<ConsentVerb, { title: string; button: string }>> = {
  install: { title: t(`Install`), button: t(`Install`) },
  update: { title: t(`Update`), button: t(`Update`) },
  turnOn: { title: t(`Turn on`), button: t(`Turn On`) },
};

export function consentVerb(official: boolean, record: Pick<PluginRecord, "approved"> | undefined, hash: string): ConsentVerb {
  if (!official) return "turnOn";
  return record?.approved && record.approved !== hash ? "update" : "install";
}

export const consentVerbOf = (s: Pick<PluginsStore, "listings" | "candidates" | "records">, name: string, hash: string): ConsentVerb =>
  consentVerb(!!consentListing(s, name, hash)?.manifest?.official, Object.hasOwn(s.records, name) ? s.records[name] : undefined, hash);
