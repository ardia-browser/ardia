import { create } from "zustand";
import { openExternalURL } from "../../platform/app";
import { deleteAddress, onAddressFilled, saveAddress, type AddressInput } from "../../platform/autofill";
import { readDocument, saveDocument } from "../../platform/documents";
import {
  contactsAuthorization,
  onContactsChanged,
  openMeCardInContacts,
  readMeCard,
  requestContactsAccess,
  type ContactsAccessRequest,
  type ContactsAuthorization,
  type MeCard,
} from "../../platform/contacts";
import { isFields } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { onWebKitCount } from "../../platform/webkit";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { nativeConsent } from "../telemetry/nativeConsent";
import { noteMeCardFill, noteMeCardSwitch } from "../telemetry/passwordManagerCounts";
import { noteWebKitAutofillCount } from "../telemetry/webKitAutofillCounts";
import { parseSaved, unchanged, versionedJson } from "../../lib/savedDocument";

type MeCardState = { entries: Record<string, string[]>; hints: Record<string, string | null>; asking: Record<string, boolean> };

const RECORD_DOCUMENT = "me-card.json";
const RECORD_VERSION = 1;

function readRecord(): Record<string, string[]> {
  const doc = parseSaved(readDocument(RECORD_DOCUMENT), RECORD_VERSION, { 0: unchanged });
  const profiles = isFields(doc?.profiles) ? doc.profiles : {};
  return Object.fromEntries(
    Object.entries(profiles).flatMap(([profile, ids]) => (Array.isArray(ids) ? [[profile, ids.filter((id): id is string => typeof id === "string")]] : [])),
  );
}

export const useMeCard = create<MeCardState>()(() => ({ entries: readRecord(), hints: {}, asking: {} }));

const saveRecord = (entries: Record<string, string[]>) => saveDocument(RECORD_DOCUMENT, versionedJson({ profiles: entries }, RECORD_VERSION));

const CONTACTS_PRIVACY = "System Settings › Privacy & Security › Contacts";

export const openContactsPrivacy = () => void openExternalURL("x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts");
export const openMeCard = () => void openMeCardInContacts();

function accessHint(status: ContactsAuthorization, error: string | null): string {
  if (status === "restricted") return `Contacts access is restricted on this Mac, by Screen Time or your organization. If you can change it, allow Ardia in ${CONTACTS_PRIVACY}.`;
  if (error) return `macOS couldn't give Ardia access to Contacts (${error}). Check ${CONTACTS_PRIVACY}.`;
  return `Ardia isn't allowed to read your contacts. Turn on Ardia in ${CONTACTS_PRIVACY}.`;
}

const UNDECIDED_HINT = "Ardia hasn't been allowed to read Contacts yet, so your Me card isn't updating. Turn this switch off and on to allow it.";

const canRead = (status: ContactsAuthorization) => status === "authorized" || status === "limited";

async function askForContacts(): Promise<Pick<ContactsAccessRequest, "status" | "error">> {
  const status = contactsAuthorization();
  if (status !== "notDetermined") return { status, error: null };
  return requestContactsAccess().catch((e: unknown) => ({ status: contactsAuthorization(), error: e instanceof Error ? e.message : String(e) }));
}

const ME_CARD_FIELD_MAX = 1000;
const ME_CARD_ADDRESSES_MAX = 20;
const UNPAIRED_OR_NUL = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function cardText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNPAIRED_OR_NUL, "").trim();
  if (text.length <= ME_CARD_FIELD_MAX) return text;
  const cut = text.slice(0, ME_CARD_FIELD_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const firstText = (list: unknown) => (Array.isArray(list) ? cardText(list[0]) : "");

const cardAddresses = (list: unknown): Record<string, unknown>[] =>
  Array.isArray(list) ? list.filter((a): a is Record<string, unknown> => isFields(a)).slice(0, ME_CARD_ADDRESSES_MAX) : [];

export function meCardEntries(card: MeCard): AddressInput[] {
  const contact = { name: cardText(card.name), organization: cardText(card.organization), email: firstText(card.emails), phone: firstText(card.phones) };
  const addresses = cardAddresses(card.addresses);
  const entries = addresses.length
    ? addresses.map((a) => ({ ...contact, street: cardText(a.street), city: cardText(a.city), state: cardText(a.state), postalCode: cardText(a.postalCode), country: cardText(a.country) }))
    : [contact];
  return entries.filter((entry) => Object.values(entry).some((value) => value));
}

const patch = (key: "hints" | "asking", profile: string, value: unknown) => useMeCard.setState((s) => ({ [key]: { ...s[key], [profile]: value } }));

async function recordEntries(profile: string, ids: string[] | null) {
  const { [profile]: _, ...others } = useMeCard.getState().entries;
  const entries = ids ? { ...others, [profile]: ids } : others;
  useMeCard.setState({ entries });
  await saveRecord(entries);
}

const saveEntry = (profile: string, entry: AddressInput, id: string | undefined) =>
  id ? saveAddress(profile, { ...entry, id }).catch(() => saveAddress(profile, entry)) : saveAddress(profile, entry);

const sameIds = (a: readonly string[] | undefined, b: readonly string[]) => !!a && a.length === b.length && a.every((id, i) => id === b[i]);

async function writeEntries(profile: string, wanted: AddressInput[], had: string[]): Promise<string[]> {
  const ids: string[] = [];
  let removed = 0;
  try {
    for (const [i, entry] of wanted.entries()) ids.push(await saveEntry(profile, entry, had[i]));
    for (const id of had.slice(wanted.length)) {
      await deleteAddress(profile, id);
      removed++;
    }
    return ids;
  } finally {
    const recorded = useMeCard.getState().entries[profile];
    const kept = [...ids, ...had.slice(ids.length + removed)];
    if (recorded && !sameIds(recorded, kept)) await recordEntries(profile, kept);
  }
}

const lastWritten = new Map<string, { card: string; ids: string[] }>();

let lastWrite: Promise<unknown> = Promise.resolve();
const serially = <T>(work: () => Promise<T>): Promise<T> => {
  const run = lastWrite.then(work, work);
  lastWrite = run.catch(() => undefined);
  return run;
};

const unstartedRefreshes = new Map<string, Promise<void>>();

function contactsReadable(profile: string): boolean {
  const status = contactsAuthorization();
  const hint = canRead(status) ? null : status === "notDetermined" ? UNDECIDED_HINT : accessHint(status, null);
  if ((useMeCard.getState().hints[profile] ?? null) !== hint) patch("hints", profile, hint);
  return hint === null;
}

const refresh = (profile: string): Promise<void> => {
  const unstarted = unstartedRefreshes.get(profile);
  if (unstarted) return unstarted;
  const run = serially(async () => {
    unstartedRefreshes.delete(profile);
    const had = useMeCard.getState().entries[profile];
    if (!had || !contactsReadable(profile)) return;
    const card = await readMeCard();
    const wanted = card ? meCardEntries(card) : [];
    const key = JSON.stringify(wanted);
    const last = lastWritten.get(profile);
    if (last && last.card === key && sameIds(last.ids, had)) return;
    lastWritten.delete(profile);
    const ids = await writeEntries(profile, wanted, had);
    lastWritten.set(profile, { card: key, ids });
  });
  unstartedRefreshes.set(profile, run);
  return run;
};

const removeEntries = (profile: string) =>
  serially(async () => {
    lastWritten.delete(profile);
    for (const id of useMeCard.getState().entries[profile] ?? []) await deleteAddress(profile, id).catch(() => undefined);
    await recordEntries(profile, null);
  });

export async function setMeCardFor(profile: string, on: boolean) {
  const consent = consentToken();
  if (!on) {
    patch("hints", profile, null);
    return removeEntries(profile);
  }
  patch("asking", profile, true);
  const { status, error } = await askForContacts();
  patch("asking", profile, false);
  if (!canRead(status)) {
    noteMeCardSwitch("refused", consent);
    return patch("hints", profile, accessHint(status, error));
  }
  noteMeCardSwitch("on", consent);
  patch("hints", profile, null);
  if (!useMeCard.getState().entries[profile]) await recordEntries(profile, []);
  await refresh(profile);
}

export function switchMeCard(profile: string, on: boolean) {
  const consent = consentToken();
  return setMeCardFor(profile, on).catch((e: unknown) => warnFor(consent, `[me card] turning it ${on ? "on" : "off"} failed`, e));
}

export const useMeCardFor = (profile: string) => ({
  on: useMeCard((s) => !!s.entries[profile]),
  hint: useMeCard((s) => s.hints[profile] ?? null),
  asking: useMeCard((s) => s.asking[profile] ?? false),
});

const NO_ENTRIES: string[] = [];
export const useMeCardEntryIds = (profile: string) => useMeCard((s) => s.entries[profile] ?? NO_ENTRIES);

const fromMeCard = (entry: string) => Object.values(useMeCard.getState().entries).some((ids) => ids.includes(entry));

function refreshAll(consent: ConsentToken | null) {
  return Promise.all(Object.keys(useMeCard.getState().entries).map((profile) => refresh(profile).catch((e: unknown) => warnFor(consent, "[me card] refresh failed", e))));
}

let started = false;
let contactsListener: { remove(): void } | null = null;

function holdContactsListener(entries: Record<string, string[]>) {
  const wanted = Object.keys(entries).length > 0;
  if (wanted === !!contactsListener) return;
  if (contactsListener) {
    contactsListener.remove();
    contactsListener = null;
  } else contactsListener = onContactsChanged((change) => void refreshAll(nativeConsent(change)));
}

export function startMeCard() {
  if (started || !PLATFORM_FEATURES.meCard) return;
  started = true;
  holdContactsListener(useMeCard.getState().entries);
  useMeCard.subscribe((s) => holdContactsListener(s.entries));
  onWebKitCount((count) => {
    if (count.name !== "autofillAddressFill" || !count.entry) return;
    if (fromMeCard(count.entry)) noteWebKitAutofillCount("autofillMeCardFill", nativeConsent(count));
  });
  onAddressFilled((fill) => {
    if (typeof fill.entry === "string" && fromMeCard(fill.entry)) noteMeCardFill(nativeConsent(fill));
  });
  void refreshAll(consentToken());
}
