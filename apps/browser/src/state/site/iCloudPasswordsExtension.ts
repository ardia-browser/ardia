import { create } from "zustand";
import { listExtensions, setExtensionEnabled } from "../../platform/extensions";
import { readDocument, saveDocument } from "../../platform/documents";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { refreshExtensionsAfterChange } from "../extensions/lists";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";
import { noteICloudExtension } from "../telemetry/passwordManagerCounts";
import type { PasswordManagerChoice } from "./passwordManagerChoice";

export const ICLOUD_PASSWORDS_EXTENSION_ID = "pejdijmoenmkgeppbflobdenhhabjlaj";
export const ICLOUD_EXTENSION_NOTE = {
  text: "Ardia now fills from Apple Passwords itself. You can remove the iCloud Passwords extension.",
  action: "Turn it back on",
} as const;

const DOCUMENT = "icloud-passwords-extension.json";
const VERSION = 1;
const MIGRATIONS: Migrations = { 0: unchanged };

function savedTurnedOff(): string[] {
  const list = parseSaved(readDocument(DOCUMENT), VERSION, MIGRATIONS)?.turnedOffByArdia;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
}

type ICloudExtensionStore = { turnedOff: readonly string[] | null };
export const useICloudPasswordsExtension = create<ICloudExtensionStore>()(() => ({ turnedOff: null }));

function turnedOff(): readonly string[] {
  const known = useICloudPasswordsExtension.getState().turnedOff;
  if (known) return known;
  const saved = savedTurnedOff();
  useICloudPasswordsExtension.setState({ turnedOff: saved });
  return saved;
}

async function record(profile: string, off: boolean) {
  const before = turnedOff();
  const next = off ? [...new Set([...before, profile])].sort() : before.filter((p) => p !== profile);
  useICloudPasswordsExtension.setState({ turnedOff: next });
  await saveDocument(DOCUMENT, versionedJson({ turnedOffByArdia: next }, VERSION));
}

const profileOf = (profileId: string) => engineProfile(useBrowser.getState(), profileId);

async function extensionOf(profile: string) {
  return (await listExtensions(profile)).find((x) => x.id === ICLOUD_PASSWORDS_EXTENSION_ID) ?? null;
}

async function turnOff(profile: string, consent: ConsentToken | null) {
  if (!(await extensionOf(profile))?.enabled) return;
  await setExtensionEnabled(ICLOUD_PASSWORDS_EXTENSION_ID, profile, false);
  await record(profile, true);
  noteICloudExtension("turnedOff", consent);
}

async function turnOn(profile: string, consent: ConsentToken | null, by: "user" | "switch") {
  if (!turnedOff().includes(profile)) return;
  if (await extensionOf(profile)) await setExtensionEnabled(ICLOUD_PASSWORDS_EXTENSION_ID, profile, true);
  await record(profile, false);
  noteICloudExtension(by === "user" ? "turnedBackOn" : "restored", consent);
}

let lastChange: Promise<unknown> = Promise.resolve();

export const iCloudExtensionSettled = () => lastChange.then(() => undefined);

function inTurn(profile: string, what: string, consent: ConsentToken | null, change: () => Promise<void>): Promise<boolean> {
  const done = lastChange.then(change).then(
    () => true,
    (error: unknown) => {
      warnFor(consent, `[passwords] iCloud Passwords extension ${what} failed`, error);
      noteICloudExtension("failed", consent);
      return false;
    },
  );
  lastChange = done.then(() => refreshExtensionsAfterChange(profile, consent));
  return done;
}

export function followPasswordManagerChoice(profileId: string, before: PasswordManagerChoice | undefined, after: PasswordManagerChoice, consent: ConsentToken | null) {
  if ((before === "apple") === (after === "apple")) return;
  const profile = profileOf(profileId);
  if (after === "apple") void inTurn(profile, "turn off", consent, () => turnOff(profile, consent));
  else void inTurn(profile, "turn on", consent, () => turnOn(profile, consent, "switch"));
}

export function turnICloudExtensionBackOn(profileId: string, consent: ConsentToken | null = null): Promise<boolean> {
  const profile = profileOf(profileId);
  return inTurn(profile, "turn on", consent, () => turnOn(profile, consent, "user"));
}

export const iCloudExtensionNoted = (turnedOffBy: readonly string[] | null, profile: string) => !!turnedOffBy?.includes(profile);

export function iCloudExtensionNote(profileId: string): typeof ICLOUD_EXTENSION_NOTE | null {
  return iCloudExtensionNoted(turnedOff(), profileOf(profileId)) ? ICLOUD_EXTENSION_NOTE : null;
}

export function useICloudExtensionNote(profileId: string): typeof ICLOUD_EXTENSION_NOTE | null {
  const profile = useBrowser((s) => engineProfile(s, profileId));
  const noted = useICloudPasswordsExtension((s) => iCloudExtensionNoted(s.turnedOff ?? savedTurnedOff(), profile));
  return noted ? ICLOUD_EXTENSION_NOTE : null;
}
