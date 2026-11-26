import { create } from "zustand";
import { openExternalURL } from "../../platform/app";
import { deleteAddress, saveAddress, type AddressInput } from "../../platform/autofill";
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

const canRead = (status: ContactsAuthorization) => status === "authorized" || status === "limited";

async function askForContacts(): Promise<Pick<ContactsAccessRequest, "status" | "error">> {
  const status = contactsAuthorization();
  if (status !== "notDetermined") return { status, error: null };
  return requestContactsAccess().catch((e: unknown) => ({ status: contactsAuthorization(), error: e instanceof Error ? e.message : String(e) }));
}

export function meCardEntries(card: MeCard): AddressInput[] {
  const contact = { name: card.name.trim(), organization: card.organization.trim(), email: card.emails[0]?.trim() ?? "", phone: card.phones[0]?.trim() ?? "" };
  const entries = card.addresses.length ? card.addresses.map((a) => ({ ...contact, street: a.street, city: a.city, state: a.state, postalCode: a.postalCode, country: a.country })) : [contact];
  return entries.filter((entry) => Object.values(entry).some((value) => value.trim()));
}

const patch = (key: "hints" | "asking", profile: string, value: unknown) => useMeCard.setState((s) => ({ [key]: { ...s[key], [profile]: value } }));

async function recordEntries(profile: string, ids: string[] | null) {
  const { [profile]: _, ...others } = useMeCard.getState().entries;
  const entries = ids ? { ...others, [profile]: ids } : others;
  useMeCard.setState({ entries });
  await saveRecord(entries);
}

async function writeEntries(profile: string, wanted: AddressInput[], had: string[]) {
  const ids: string[] = [];
  for (const [i, entry] of wanted.entries()) {
    const id = had[i];
    ids.push(id ? await saveAddress(profile, { ...entry, id }).catch(() => saveAddress(profile, entry)) : await saveAddress(profile, entry));
  }
  for (const id of had.slice(wanted.length)) await deleteAddress(profile, id);
  return ids;
}

let queue: Promise<unknown> = Promise.resolve();
const serially = <T>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
};

const refresh = (profile: string) =>
  serially(async () => {
    const had = useMeCard.getState().entries[profile];
    if (!had) return;
    const card = await readMeCard();
    const ids = await writeEntries(profile, card ? meCardEntries(card) : [], had);
    if (useMeCard.getState().entries[profile]) await recordEntries(profile, ids);
  });

const removeEntries = (profile: string) =>
  serially(async () => {
    for (const id of useMeCard.getState().entries[profile] ?? []) await deleteAddress(profile, id).catch(() => undefined);
    await recordEntries(profile, null);
  });

export async function setMeCardFor(profile: string, on: boolean) {
  if (!on) {
    patch("hints", profile, null);
    return removeEntries(profile);
  }
  patch("asking", profile, true);
  const { status, error } = await askForContacts();
  patch("asking", profile, false);
  if (!canRead(status)) return patch("hints", profile, accessHint(status, error));
  patch("hints", profile, null);
  if (!useMeCard.getState().entries[profile]) await recordEntries(profile, []);
  await refresh(profile);
}

export const useMeCardFor = (profile: string) => ({
  on: useMeCard((s) => !!s.entries[profile]),
  hint: useMeCard((s) => s.hints[profile] ?? null),
  asking: useMeCard((s) => s.asking[profile] ?? false),
});

const NO_ENTRIES: string[] = [];
export const useMeCardEntryIds = (profile: string) => useMeCard((s) => s.entries[profile] ?? NO_ENTRIES);

const refreshAll = () => Promise.all(Object.keys(useMeCard.getState().entries).map((profile) => refresh(profile).catch((e: unknown) => console.warn("[me card] refresh failed", e))));

let started = false;

export function startMeCard() {
  if (started || !PLATFORM_FEATURES.meCard) return;
  started = true;
  onContactsChanged(() => void refreshAll());
  void refreshAll();
}
