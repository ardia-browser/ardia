import { getPasswordAutofill, setPasswordAutofill } from "../../platform/passwords";
import { readDocument, saveDocument } from "../../platform/documents";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import { isFields } from "../../lib/decode";
import { resource, store as storeResource } from "../settings/resources";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { noteOfferToSaveRestore, notePasswordManagerRecordFailed } from "../telemetry/passwordManagerCounts";
import type { PasswordManagerChoice } from "./passwordManagerChoice";

export const passwordAutofill = resource("passwordAutofill", (profile: string) => getPasswordAutofill(profile).catch(() => true));

const HELD_OFF_DOCUMENT = "password-manager.json";
const HELD_OFF_VERSION = 1;
const HELD_OFF_MIGRATIONS: Migrations = { 0: unchanged };

type HeldOff = { profiles: Set<string>; restored: Set<string>; writable: boolean };

let unsaved: string | null = null;
let lastSaved: string | null = null;

function savedRecord(): string | null {
  const raw = readDocument(HELD_OFF_DOCUMENT);
  if (unsaved !== null && raw === unsaved) return lastSaved;
  unsaved = null;
  return (lastSaved = raw);
}

const stringsOf = (list: unknown) => new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);

const emptyRecord = (writable: boolean): HeldOff => ({ profiles: new Set(), restored: new Set(), writable });

function parseRecord(raw: string | null): HeldOff {
  if (!raw) return emptyRecord(true);
  try {
    const doc: unknown = JSON.parse(raw);
    if (isFields(doc) && typeof doc.version === "number" && doc.version > HELD_OFF_VERSION) return emptyRecord(false);
  } catch {
    return emptyRecord(true);
  }
  const doc = parseSaved(raw, HELD_OFF_VERSION, HELD_OFF_MIGRATIONS);
  const profiles = stringsOf(doc?.offerToSaveHeldOff);
  return { profiles, restored: new Set([...stringsOf(doc?.offerToSaveRestored)].filter((p) => profiles.has(p))), writable: true };
}

const readHeldOff = () => parseRecord(savedRecord());

const recordContents = (profiles: Set<string>, restored: Set<string>) =>
  versionedJson({ offerToSaveHeldOff: [...profiles].sort(), ...(restored.size ? { offerToSaveRestored: [...restored].sort() } : {}) }, HELD_OFF_VERSION);

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
const pendingWatchers = new Set<(pending: boolean) => void>();
const writtenThisLaunch = new Set<string>();
let wasPending = false;

function notePending() {
  const pending = intents.size > 0;
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

function rewriteRecord(change: (profiles: Set<string>, restored: Set<string>) => void): Promise<boolean> {
  const saved = recording.then(async () => {
    const { profiles, restored, writable } = readHeldOff();
    if (!writable) return false;
    const before = recordContents(profiles, restored);
    change(profiles, restored);
    for (const p of restored) if (!profiles.has(p)) restored.delete(p);
    const contents = recordContents(profiles, restored);
    if (contents === before && unsaved === null) return true;
    try {
      await saveDocument(HELD_OFF_DOCUMENT, contents);
    } catch {
      unsaved = contents;
      return false;
    }
    if (readDocument(HELD_OFF_DOCUMENT) !== contents) return false;
    unsaved = null;
    lastSaved = contents;
    return true;
  });
  const landed = saved.catch(() => false);
  recording = landed;
  return landed;
}

const recordHeldOff = (profile: string, held: boolean) =>
  rewriteRecord((profiles, restored) => {
    restored.delete(profile);
    if (held) profiles.add(profile);
    else profiles.delete(profile);
  });

const markGivenBack = (profile: string) => rewriteRecord((profiles, restored) => void (profiles.has(profile) && restored.add(profile)));

export const OFFER_TO_SAVE_RETRY = { firstMs: 30_000, maxMs: 300_000 };
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 0;

function settleRetry() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelay = 0;
}

function retryLater() {
  if (!intents.size) return settleRetry();
  if (retryTimer !== undefined) return;
  retryDelay = retryDelay ? Math.min(retryDelay * 2, OFFER_TO_SAVE_RETRY.maxMs) : OFFER_TO_SAVE_RETRY.firstMs;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    for (const profile of [...intents.keys()]) writeOfferToSave(profile);
  }, retryDelay);
}
const draining = new Set<string>();

const stillWanted = (profile: string, intent: Intent) => intents.get(profile) === intent;

async function holdOff(profile: string, intent: Intent): Promise<boolean> {
  if (!(await getPasswordAutofill(profile))) return true;
  if (!stillWanted(profile, intent)) return true;
  if (!(await recordHeldOff(profile, true))) return (notePasswordManagerRecordFailed(intent.consent), false);
  writtenThisLaunch.delete(profile);
  if (!stillWanted(profile, intent)) return true;
  await setPasswordAutofill(false, profile);
  storeResource(passwordAutofill, [profile], false);
  return true;
}

async function confirmGivenBack(profile: string, consent: ConsentToken | null): Promise<boolean> {
  await setPasswordAutofill(true, profile);
  if (!(await recordHeldOff(profile, false))) return (notePasswordManagerRecordFailed(consent), false);
  storeResource(passwordAutofill, [profile], true);
  noteOfferToSaveRestore(true, consent);
  return true;
}

async function giveBack(profile: string, intent: Intent): Promise<boolean> {
  const { profiles, restored } = readHeldOff();
  if (!profiles.has(profile)) return true;
  if (restored.has(profile) && writtenThisLaunch.has(profile)) return true;
  const now = await getPasswordAutofill(profile);
  if (!stillWanted(profile, intent)) return true;
  if (now && restored.has(profile)) return confirmGivenBack(profile, intent.consent);
  try {
    await setPasswordAutofill(true, profile);
  } catch {
    noteOfferToSaveRestore(false, intent.consent);
    return false;
  }
  writtenThisLaunch.add(profile);
  storeResource(passwordAutofill, [profile], true);
  if (!stillWanted(profile, intent)) return true;
  if (!(await markGivenBack(profile))) return (notePasswordManagerRecordFailed(intent.consent), false);
  return true;
}

async function drain(profile: string) {
  for (;;) {
    const intent = intents.get(profile);
    if (!intent) return;
    if (!readHeldOff().writable) {
      noteNewerRecord(intent.consent);
      dropIntent(profile);
      return;
    }
    const done = await (intent.on ? giveBack(profile, intent) : holdOff(profile, intent)).catch(() => false);
    if (!stillWanted(profile, intent)) continue;
    if (!done) return retryLater();
    dropIntent(profile);
    if (!intents.size) settleRetry();
    return;
  }
}

export const startOfferToSave = () => writtenThisLaunch.clear();

export const pendingOfferToSave = () => intents.size;

export const offerToSaveHeldOffSomewhere = () => pendingOfferToSave() > 0 || readHeldOff().profiles.size > 0;

export function writeOfferToSave(profile: string) {
  if (!intents.has(profile) || draining.has(profile)) return;
  draining.add(profile);
  void drain(profile).finally(() => draining.delete(profile));
}

function offerToSave(profile: string, on: boolean) {
  setIntent(profile, { on, consent: consentToken() });
  writeOfferToSave(profile);
}

export const followMode = (profile: string, mode: PasswordManagerChoice) => offerToSave(profile, mode === "ardia");

export function forgetHeldOffOutside(live: ReadonlySet<string>): Promise<boolean> {
  const gone = (profile: string) => !live.has(profile);
  if (!live.size || ![...readHeldOff().profiles].some(gone)) return Promise.resolve(true);
  return rewriteRecord((profiles) => {
    for (const profile of [...profiles]) if (gone(profile)) profiles.delete(profile);
  });
}

export function forgetPendingOfferToSave(profile: string, consent: ConsentToken | null): Promise<boolean> {
  dropIntent(profile);
  writtenThisLaunch.delete(profile);
  return recordHeldOff(profile, false).then((landed) => {
    if (landed || !readHeldOff().writable) return true;
    notePasswordManagerRecordFailed(consent);
    return false;
  });
}
