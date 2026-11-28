import type { ContactsNative } from "./generated/native";

export type ContactsAuthorization = "authorized" | "limited" | "denied" | "restricted" | "notDetermined";

export type ContactsAccessRequest = { granted: boolean; status: ContactsAuthorization; error: string | null };

export type MeCardAddress = { street: string; city: string; state: string; postalCode: string; country: string };

export type MeCard = { name: string; organization: string; emails: string[]; phones: string[]; addresses: MeCardAddress[] };

export type { ContactsNative };
