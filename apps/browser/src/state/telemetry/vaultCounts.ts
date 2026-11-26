import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";
import { percentile } from "./transport";

export const VAULT_REFUSALS = ["not_granted", "no_login", "no_form", "needs_passkey", "needs_human", "password_manager_plugin", "task_expired", "denied", "locked", "conflict", "busy", "failed", "bad_request"] as const;
export type VaultRefusal = (typeof VAULT_REFUSALS)[number];
export type VaultGrantVia = "sheet" | "phone" | "always";
export type VaultTiming = "login" | "autofill" | "unlock" | "sheet" | "ready" | "fill" | "decide" | "profile" | "seed" | "load" | "scan" | "transfer";
export const VAULT_FAILURES = ["unreachable", "field_missing", "field_changed", "steps", "no_submit_control", "interrupted", "basic_auth", "proxy_auth", "get_form", "error_page"] as const;
export const VAULT_EVIDENCE = ["strong", "weak", "none"] as const;
const SIGNAL_FIELDS = { navigated: "navigated", httpOnlyCookie: "session_cookie", formGone: "form_gone", pathChanged: "path_changed" } as const;
export const noteVaultFailure = (reason: string | undefined, consent?: ConsentToken | null) => {
  if (reason && (VAULT_FAILURES as readonly string[]).includes(reason)) bump(`vault_failures_${reason}`, consent);
};
export const VAULT_TRANSFERS = ["none", "complete", "partial", "sent", "timed_out"] as const;
export type VaultTransferOutcome = (typeof VAULT_TRANSFERS)[number];

const MAX_SAMPLES = 200;
const COUNTS = ["vault_fills", "vault_autofills", "vault_tasks", "vault_codes_filled", "vault_codes_kept", "vault_always_added", ...VAULT_REFUSALS.map((code) => `vault_refusals_${code}`), "vault_grants_sheet", "vault_grants_phone", "vault_grants_always", "vault_phone_approvals", "vault_logins_joined", "vault_autofill_skipped_several", "vault_autofill_held_for_login", ...VAULT_TRANSFERS.map((t) => `vault_transfers_${t}`), ...VAULT_FAILURES.map((r) => `vault_failures_${r}`), ...VAULT_EVIDENCE.map((e) => `vault_submitted_evidence_${e}`), ...Object.values(SIGNAL_FIELDS).map((s) => `vault_signals_${s}`), "vault_conflict_keys", "vault_transfer_failures", "vault_blocked_requests", "vault_stops_after_move"] as const;

let counts: Record<string, number> = {};
let samples: Record<VaultTiming, number[]> = { login: [], autofill: [], unlock: [], sheet: [], ready: [], fill: [], decide: [], profile: [], seed: [], load: [], scan: [], transfer: [] };

const bump = (field: string, consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (counts[field] = (counts[field] ?? 0) + 1));

export const noteVaultFill = (auto: boolean, usedCode: boolean, consent?: ConsentToken | null) => {
  bump(auto ? "vault_autofills" : "vault_fills", consent);
  if (usedCode) bump("vault_codes_filled", consent);
};
export const noteVaultRefusal = (code: VaultRefusal, consent?: ConsentToken | null) => bump(`vault_refusals_${code}`, consent);
export const noteVaultGrant = (via: VaultGrantVia, consent?: ConsentToken | null) => (bump("vault_tasks", consent), bump(`vault_grants_${via}`, consent), via === "phone" && bump("vault_phone_approvals", consent));
export function noteVaultTransfer(outcome: VaultTransferOutcome | undefined, sums: { conflicts?: number; transferFailed?: number; blockedRequests?: number }, consent?: ConsentToken | null) {
  if (outcome && (VAULT_TRANSFERS as readonly string[]).includes(outcome)) bump(`vault_transfers_${outcome}`, consent);
  const add = (field: string, n: number | undefined) => {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return;
    const amount = Math.min(Math.round(n), 10_000);
    countFor(consentOrNow(consent), () => void (counts[field] = (counts[field] ?? 0) + amount));
  };
  add("vault_conflict_keys", sums.conflicts);
  add("vault_transfer_failures", sums.transferFailed);
  add("vault_blocked_requests", sums.blockedRequests);
}

export type VaultCoordination = "joined" | "skipped_several" | "held_for_login";
const COORDINATION_FIELDS: Record<VaultCoordination, string> = { joined: "vault_logins_joined", skipped_several: "vault_autofill_skipped_several", held_for_login: "vault_autofill_held_for_login" };
export const noteVaultCoordination = (what: VaultCoordination, consent?: ConsentToken | null) => bump(COORDINATION_FIELDS[what], consent);

export function noteVaultSignals(signals: Record<string, boolean> | null, consent?: ConsentToken | null) {
  for (const [name, field] of Object.entries(SIGNAL_FIELDS)) if (signals?.[name] === true) bump(`vault_signals_${field}`, consent);
}

export const noteVaultStopAfterMove = (consent?: ConsentToken | null) => bump("vault_stops_after_move", consent);

export const noteVaultEvidence = (evidence: string | undefined, consent?: ConsentToken | null) => {
  if (evidence && (VAULT_EVIDENCE as readonly string[]).includes(evidence)) bump(`vault_submitted_evidence_${evidence}`, consent);
};

export const noteVaultCodeKept = (consent?: ConsentToken | null) => bump("vault_codes_kept", consent);
export const noteVaultAlwaysAdded = (consent?: ConsentToken | null) => bump("vault_always_added", consent);

export function noteVaultTiming(kind: VaultTiming, ms: number | undefined, consent?: ConsentToken | null) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  countFor(consentOrNow(consent), () => void (samples[kind].length < MAX_SAMPLES && samples[kind].push(Math.round(ms * 10) / 10)));
}

export function takeVaultCounts(): Record<string, number> {
  const taken: Record<string, number> = Object.fromEntries(COUNTS.map((field) => [field, counts[field] ?? 0]));
  for (const [kind, list] of Object.entries(samples) as [VaultTiming, number[]][]) {
    if (!list.length) continue;
    const sorted = [...list].sort((a, b) => a - b);
    taken[`vault_${kind}_ms_count`] = sorted.length;
    taken[`vault_${kind}_ms_p50`] = percentile(sorted, 0.5);
    taken[`vault_${kind}_ms_p95`] = percentile(sorted, 0.95);
    taken[`vault_${kind}_ms_max`] = sorted.at(-1)!;
  }
  counts = {};
  samples = { login: [], autofill: [], unlock: [], sheet: [], ready: [], fill: [], decide: [], profile: [], seed: [], load: [], scan: [], transfer: [] };
  return taken;
}
