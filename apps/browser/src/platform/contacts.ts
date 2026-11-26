import { nativeModule, type ContactsAccessRequest, type ContactsAuthorization, type MeCard, type MeCardAddress } from "@ardia/shell";

export type { ContactsAccessRequest, ContactsAuthorization, MeCard, MeCardAddress };

const Contacts = nativeModule("ArdiaContacts");

export const contactsAuthorization = (): ContactsAuthorization => Contacts.authorizationStatus();
export const requestContactsAccess = (): Promise<ContactsAccessRequest> => Contacts.requestAccess();
export const readMeCard = (): Promise<MeCard | null> => Contacts.meCard();
export const openMeCardInContacts = () => Contacts.openMeCard();
export const onContactsChanged = (listener: () => void) => Contacts.addListener("onContactsChanged", listener);
