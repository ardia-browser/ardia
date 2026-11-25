import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

export const KEYRING_PROTECTIONS = ["keyring", "portal", "obfuscated", "none", "unknown"] as const;
export const KEYRING_FAILURES = ["locked", "unavailable", "encryption", "store"] as const;
export const KEYRING_SOURCES = ["passwords", "sync", "live"] as const;

type Protection = (typeof KEYRING_PROTECTIONS)[number];
type Failure = (typeof KEYRING_FAILURES)[number];
type Source = (typeof KEYRING_SOURCES)[number];

const FIELDS = [
  "keyring_checks",
  "keyring_fallbacks",
  ...KEYRING_PROTECTIONS.map((protection) => `keyring_protection_${protection}`),
  ...KEYRING_SOURCES.flatMap((source) => KEYRING_FAILURES.map((failure) => `keyring_${source}_${failure}`)),
];

const none = () => Object.fromEntries(FIELDS.map((field) => [field, 0])) as Record<string, number>;

let counts = none();

const add = (field: string, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (counts[field] = (counts[field] ?? 0) + 1));

const PASSWORD_REASONS: Record<string, Failure> = { keyringLocked: "locked", encryptionUnavailable: "encryption", storeFailed: "store" };

export function noteKeyringCheck(status: { protection?: unknown; protectionFallback?: unknown; passwords?: { reason?: unknown } | null }, consent?: ConsentToken | null) {
  const protection: Protection = (KEYRING_PROTECTIONS as readonly unknown[]).includes(status.protection) ? (status.protection as Protection) : "unknown";
  add("keyring_checks", consent);
  add(`keyring_protection_${protection}`, consent);
  if (status.protectionFallback === true) add("keyring_fallbacks", consent);
  const reason = status.passwords?.reason;
  if (typeof reason === "string" && Object.hasOwn(PASSWORD_REASONS, reason)) add(`keyring_passwords_${PASSWORD_REASONS[reason]}`, consent);
}

export function noteKeyringFailure(source: Source, failure: Failure, consent?: ConsentToken | null) {
  add(`keyring_${source}_${failure}`, consent);
}

export function takeKeyringCounts() {
  const taken = counts;
  counts = none();
  return taken;
}
