import type { AutofillStatus, CredentialAvailability, PasswordStatus } from "./hostCredentials.ts";
import { BASIC_STORE_NOTICE, revealAsks, unprotectedNotice, unprotectedTitle } from "@platform/secretWording";

type CredentialKind = "passwords" | "autofill";

function unavailableEntries(status: PasswordStatus | AutofillStatus, kind: CredentialKind): CredentialAvailability[] {
  const entries = kind === "passwords" ? [(status as PasswordStatus).passwords] : [(status as AutofillStatus).addresses, (status as AutofillStatus).cards];
  return entries.filter((entry): entry is CredentialAvailability => !!entry && !entry.available);
}

export function credentialNotice(status: PasswordStatus | AutofillStatus | null | undefined, kind: CredentialKind): string | null {
  if (!status) return null;
  const parts: string[] = [];
  for (const entry of unavailableEntries(status, kind)) if (entry.message && !parts.includes(entry.message)) parts.push(entry.message);
  if (!status.reauth) {
    parts.push(
      status.reauthMessage
        ? `${status.reauthMessage}.`
        : kind === "passwords"
          ? "System authentication is unavailable, so saved passwords can't be shown, changed or exported."
          : "System authentication is unavailable, so card numbers can't be shown.",
    );
  }
  if (status.protectionFallback) {
    parts.push(unprotectedNotice(kind));
  }
  if (status.backend === "basic") parts.push(BASIC_STORE_NOTICE);
  return parts.length ? parts.join(" ") : null;
}

export function credentialNoticeTitle(status: PasswordStatus | AutofillStatus, kind: CredentialKind): string {
  if (unavailableEntries(status, kind).length) return kind === "passwords" ? "Passwords are unavailable" : "Some autofill data is unavailable";
  if (status.protectionFallback || status.backend === "basic") return unprotectedTitle(kind);
  if (!status.reauth) return "System authentication is unavailable";
  return kind === "passwords" ? "Passwords are unavailable" : "Some autofill data is unavailable";
}

export function credentialStorage(status: PasswordStatus | AutofillStatus | null | undefined, kind: CredentialKind): string | null {
  if (!status?.protection || !status.storage) return null;
  const auth = revealAsks(kind);
  const lead = kind === "passwords" ? "Saved separately for each profile and" : "Card numbers are";
  switch (status.protection) {
    case "keyring":
    case "portal":
      return `${lead} encrypted with a key from ${status.storage}. ${auth}`;
    case "obfuscated":
      return `${lead} protected only by ${status.storage}. ${auth}`;
    case "none":
      return `${kind === "passwords" ? "Saved passwords" : "Card numbers"} can't be protected: no encryption key is available.`;
    default:
      return `Ardia couldn't check which key protects ${kind === "passwords" ? "saved passwords" : "card numbers"}, so whether they're encrypted is unknown.`;
  }
}
