import { getPasswordAutofill, setPasswordAutofill } from "../../platform/passwords";
import { readDocument, saveDocument } from "../../platform/documents";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import { isFields } from "../../lib/decode";
import { resource, store as storeResource } from "../settings/resources";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { notePasswordManagerRecordFailed } from "../telemetry/passwordManagerCounts";
import type { PasswordManagerChoice } from "./passwordManagerChoice";

export const passwordAutofill = resource("passwordAutofill", (profile: string) => getPasswordAutofill(profile).catch(() => true));

const HELD_OFF_DOCUMENT = "password-manager.json";
const HELD_OFF_VERSION = 1;
const HELD_OFF_MIGRATIONS: Migrations = { 0: unchanged };

type HeldOff = { profiles: Set<string>; writable: boolean };

let unsaved: string | null = null;
let lastSaved: string | null = null;

function savedRecord(): string | null {
  const raw = readDocument(HELD_OFF_DOCUMENT);
  if (unsaved !== null && raw === unsaved) return lastSaved;
  unsaved = null;
  return (lastSaved = raw);
}

function readHeldOff(): HeldOff {
  const raw = savedRecord();
  if (!raw) return { profiles: new Set(), writable: true };
  try {
    const doc: unknown = JSON.parse(raw);
    if (isFields(doc) && typeof doc.version === "number" && doc.version > HELD_OFF_VERSION) return { profiles: new Set(), writable: false };
  } catch {
    return { profiles: new Set(), writable: true };
  }
  const list = parseSaved(raw, HELD_OFF_VERSION, HELD_OFF_MIGRATIONS)?.offerToSaveHeldOff;
  return { profiles: new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []), writable: true };
}

const heldOffProfiles = () => readHeldOff().profiles;

let newerNoted = false;

function noteNewerRecord(consent: ConsentToken | null) {
  if (newerNoted) return;
  newerNoted = true;
  warnFor(consent, `[passwords] ${HELD_OFF_DOCUMENT} is from a newer Ardia, so offer to save is left as it is`);
  notePasswordManagerRecordFailed(consent);
}

let recording: Promise<unknown> = Promise.resolve();

type Intent = { on: boolean; consent: ConsentToken | null };
const intents = new Map<string, Intent>();
const owed = new Map<string, ConsentToken | null>();
const pendingWatchers = new Set<(pending: boolean) => void>();
let wasPending = false;

function notePending() {
  const pending = intents.size + owed.size > 0;
  if (pending === wasPending) return;
  wasPending = pending;
  for (const watcher of pendingWatchers) watcher(pending);
}

export function watchPendingOfferToSave(watcher: (pending: boolean) => void): () => void {
  pendingWatchers.add(watcher);
  return () => pendingWatchers.delete(watcher);
}

const setIntent = (profile: string, intent: Intent) => (intents.set(profile, intent), notePending());
const dropIntent = (profile: string) => (intents.delete(profile), notePending());
const setOwed = (profile: string, consent: ConsentToken | null) => (owed.set(profile, consent), notePending());
const dropOwed = (profile: string) => (owed.delete(profile), notePending());

function recordHeldOff(profile: string, held: boolean): Promise<boolean> {
  const saved = recording.then(async () => {
    const { profiles, writable } = readHeldOff();
    if (!writable) return false;
    const before = JSON.stringify([...profiles].sort());
    if (held) profiles.add(profile);
    else profiles.delete(profile);
    const carried = [...owed.keys()].filter((p) => p !== profile || held);
    for (const p of carried) profiles.add(p);
    const list = [...profiles].sort();
    if (JSON.stringify(list) !== before) {
      const contents = versionedJson({ offerToSaveHeldOff: list }, HELD_OFF_VERSION);
      try {
        await saveDocument(HELD_OFF_DOCUMENT, contents);
      } catch {
        unsaved = contents;
        return false;
      }
      if (readDocument(HELD_OFF_DOCUMENT) !== contents) return false;
      unsaved = null;
      lastSaved = contents;
    }
    for (const p of carried) dropOwed(p);
    if (!owed.size && !intents.size) settleRetry();
    return true;
  });
  const landed = saved.catch(() => false);
  recording = landed;
  return landed;
}

export const OWED_RETRY = { firstMs: 30_000, maxMs: 300_000 };
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 0;

function settleRetry() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelay = 0;
}

function retryLater() {
  if (!owed.size && !intents.size) return settleRetry();
  if (retryTimer !== undefined) return;
  retryDelay = retryDelay ? Math.min(retryDelay * 2, OWED_RETRY.maxMs) : OWED_RETRY.firstMs;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    for (const profile of new Set([...owed.keys(), ...intents.keys()])) writeOfferToSave(profile);
  }, retryDelay);
}
const draining = new Set<string>();

const stillWanted = (profile: string, intent: Intent) => intents.get(profile) === intent;

async function payOwed(profile: string, consent: ConsentToken | null): Promise<boolean> {
  if (!owed.has(profile)) return true;
  if (!(await recordHeldOff(profile, true))) {
    notePasswordManagerRecordFailed(consent);
    retryLater();
    return false;
  }
  dropOwed(profile);
  retryLater();
  return true;
}

async function holdOff(profile: string, intent: Intent): Promise<boolean> {
  if (!(await getPasswordAutofill(profile))) return (await payOwed(profile, intent.consent), true);
  if (!stillWanted(profile, intent)) return true;
  if (!(await recordHeldOff(profile, true))) return (notePasswordManagerRecordFailed(intent.consent), false);
  dropOwed(profile);
  if (!stillWanted(profile, intent)) return true;
  await setPasswordAutofill(false, profile);
  storeResource(passwordAutofill, [profile], false);
  return true;
}

async function oweUnlessForgotten(profile: string, intent: Intent) {
  if (!intents.has(profile)) return;
  setOwed(profile, intent.consent);
  await payOwed(profile, intent.consent);
}

async function giveBack(profile: string, intent: Intent): Promise<boolean> {
  const recorded = heldOffProfiles().has(profile);
  if (!recorded && !owed.has(profile)) return true;
  await getPasswordAutofill(profile);
  if (!stillWanted(profile, intent)) return true;
  if (recorded && !(await recordHeldOff(profile, false))) return (notePasswordManagerRecordFailed(intent.consent), false);
  dropOwed(profile);
  if (!stillWanted(profile, intent)) return (await oweUnlessForgotten(profile, intent), true);
  try {
    await setPasswordAutofill(true, profile);
  } catch {
    await oweUnlessForgotten(profile, intent);
    return false;
  }
  storeResource(passwordAutofill, [profile], true);
  return true;
}

async function drain(profile: string) {
  for (;;) {
    const intent = intents.get(profile);
    if (!readHeldOff().writable) {
      noteNewerRecord(intent ? intent.consent : (owed.get(profile) ?? null));
      dropIntent(profile);
      dropOwed(profile);
      return;
    }
    if (!intent) return void (await payOwed(profile, owed.get(profile) ?? null));
    const done = await (intent.on ? giveBack(profile, intent) : holdOff(profile, intent)).catch(() => false);
    if (!stillWanted(profile, intent)) continue;
    if (!done) return retryLater();
    dropIntent(profile);
    if (!owed.size && !intents.size) settleRetry();
    return;
  }
}

export const pendingOfferToSave = () => intents.size + owed.size;

export function writeOfferToSave(profile: string) {
  if ((!intents.has(profile) && !owed.has(profile)) || draining.has(profile)) return;
  draining.add(profile);
  void drain(profile).finally(() => draining.delete(profile));
}

function offerToSave(profile: string, on: boolean) {
  setIntent(profile, { on, consent: consentToken() });
  writeOfferToSave(profile);
}

export const followMode = (profile: string, mode: PasswordManagerChoice) => offerToSave(profile, mode === "ardia");

export function forgetPendingOfferToSave(profile: string, consent: ConsentToken | null): Promise<boolean> {
  dropIntent(profile);
  dropOwed(profile);
  return recordHeldOff(profile, false).then((landed) => {
    if (landed || !readHeldOff().writable) return true;
    notePasswordManagerRecordFailed(consent);
    return false;
  });
}
