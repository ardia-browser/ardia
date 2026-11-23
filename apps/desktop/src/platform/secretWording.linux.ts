type CredentialKind = "passwords" | "autofill";
type KeyStoreState = "ok" | "notFound" | "locked" | "unavailable" | undefined;

export const unprotectedNotice = (kind: CredentialKind): string =>
  `Your keyring didn't answer, so Chromium only obfuscates ${kind === "passwords" ? "new passwords" : "new card numbers"} with its built-in key instead of encrypting them. Unlock or start your keyring (Secret Service or KWallet) and restart Ardia.`;

export const SYNC_KEY_NOT_SAVED = "Couldn’t save the sync key in your keyring.";

export const BASIC_STORE_NOTICE = "Chromium is using its basic password store, which only obfuscates secrets instead of encrypting them with your keyring.";

export const unprotectedTitle = (kind: CredentialKind): string => (kind === "passwords" ? "Passwords aren't encrypted with your keyring" : "Card numbers aren't encrypted with your keyring");

export const revealAsks = (kind: CredentialKind): string =>
  kind === "passwords" ? "Showing, changing or exporting them asks for your system password (polkit)." : "Showing one asks for your system password (polkit).";

export function syncKeyStoreMessage(store: string | undefined, state: KeyStoreState, saving: boolean): string | null {
  if (store !== "secretService") return null;
  if (state === "unavailable")
    return saving
      ? "Couldn’t save the sync key: no keyring is running. Start a Secret Service keyring, like GNOME Keyring or KWallet, and try again."
      : "No keyring is running, so Ardia can’t read this device’s sync key. Start a Secret Service keyring, like GNOME Keyring or KWallet, or enter your recovery phrase.";
  if (state === "locked")
    return saving
      ? "Couldn’t save the sync key: your keyring is locked. Unlock it and try again."
      : "Your keyring is locked. Unlock it, or enter your recovery phrase to keep syncing.";
  return null;
}
