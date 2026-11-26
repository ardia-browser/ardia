import { create } from "zustand";
import { openExternalURL } from "../../platform/app";
import { contactsAuthorization, requestContactsAccess, type ContactsAccessRequest, type ContactsAuthorization } from "../../platform/contacts";

type MeCardState = { on: Record<string, boolean>; hints: Record<string, string | null>; asking: Record<string, boolean> };

export const useMeCard = create<MeCardState>()(() => ({ on: {}, hints: {}, asking: {} }));

const CONTACTS_PRIVACY = "System Settings › Privacy & Security › Contacts";

export const openContactsPrivacy = () => void openExternalURL("x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts");

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

const patch = (key: keyof MeCardState, profile: string, value: unknown) =>
  useMeCard.setState((s) => ({ [key]: { ...s[key], [profile]: value } }) as Partial<MeCardState>);

export async function setMeCardFor(profile: string, on: boolean) {
  if (!on) {
    patch("on", profile, false);
    patch("hints", profile, null);
    return;
  }
  patch("asking", profile, true);
  const { status, error } = await askForContacts();
  patch("asking", profile, false);
  if (!canRead(status)) {
    patch("on", profile, false);
    patch("hints", profile, accessHint(status, error));
    return;
  }
  patch("hints", profile, null);
  patch("on", profile, true);
}

export const useMeCardFor = (profile: string) => ({
  on: useMeCard((s) => s.on[profile] ?? false),
  hint: useMeCard((s) => s.hints[profile] ?? null),
  asking: useMeCard((s) => s.asking[profile] ?? false),
});
