import { PLATFORM_TERMS } from "../../../browser/src/lib/platformTerms.ts";

type CredentialKind = "passwords" | "autofill";
type KeyStoreState = "ok" | "notFound" | "locked" | "unavailable" | undefined;

export const unprotectedNotice = (kind: CredentialKind): string =>
  `Your Keychain didn't give Chromium its encryption key, so ${kind === "passwords" ? "new passwords" : "new card numbers"} are only obfuscated with a built-in key instead of encrypted. Unlock your Keychain and restart Ardia.`;

export const SYNC_KEY_NOT_SAVED = "Couldn’t save the sync key in your Keychain.";

export const BASIC_STORE_NOTICE = "Chromium is using its basic password store, which only obfuscates secrets instead of encrypting them with your Keychain.";

export const unprotectedTitle = (kind: CredentialKind): string => (kind === "passwords" ? "Passwords aren't encrypted with your Keychain" : "Card numbers aren't encrypted with your Keychain");

export const revealAsks = (kind: CredentialKind): string =>
  kind === "passwords" ? `Showing, changing or exporting them asks for ${PLATFORM_TERMS.deviceUnlock}.` : `Showing one asks for ${PLATFORM_TERMS.deviceUnlock}.`;

export const syncKeyStoreMessage = (_store: string | undefined, _state: KeyStoreState, _saving: boolean): string | null => null;
