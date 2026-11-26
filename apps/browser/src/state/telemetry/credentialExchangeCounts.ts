import { capture, type ConsentToken } from "./client";

export type CredentialExchangeImportCounts = {
  kind: "apple" | "onePassword" | "bitwarden" | "other";
  passwords: number;
  existing: number;
  failed: number;
  codes: number;
  codes_failed: number;
  passkeys_left: number;
  no_site: number;
  unsupported: number;
  batched: boolean;
  receive_ms: number;
  parse_ms: number;
  save_ms: number;
};

export function noteCredentialExchangeImport(counts: CredentialExchangeImportCounts, consent: ConsentToken | null) {
  capture("credential_exchange_import", counts, consent);
}

export function noteCredentialExchangeFailure(stage: "receive" | "save", consent: ConsentToken | null) {
  capture("credential_exchange_import_failed", { stage }, consent);
}
