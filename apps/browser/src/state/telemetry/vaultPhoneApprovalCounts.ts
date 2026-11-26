import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";

const counts = { asked: 0, allowed: 0, denied: 0, expired: 0, cancelled: 0, unreachable: 0, refused: 0, unenrolled: 0, bad_signature: 0, trusted: 0, answerMsTotal: 0, answerMsMost: 0 };

export type PhoneApprovalOutcome = "asked" | "allowed" | "denied" | "expired" | "cancelled" | "unreachable" | "refused" | "unenrolled" | "bad_signature" | "trusted";

const FIELD: Record<PhoneApprovalOutcome, string> = {
  asked: "vault_phone_asks",
  allowed: "vault_phone_allowed",
  denied: "vault_phone_denied",
  expired: "vault_phone_expired",
  cancelled: "vault_phone_cancelled",
  unreachable: "vault_phone_unreachable",
  refused: "vault_phone_refused",
  unenrolled: "vault_phone_unenrolled",
  bad_signature: "vault_phone_bad_signature",
  trusted: "vault_phone_keys_trusted",
};

export function notePhoneApproval(outcome: PhoneApprovalOutcome, consent: ConsentToken | null | undefined, answeredInMs?: number) {
  const ms = answeredInMs !== undefined && Number.isFinite(answeredInMs) ? Math.max(0, Math.round(answeredInMs)) : null;
  countFor(consentOrNow(consent), () => {
    counts[outcome] += 1;
    if (ms === null) return;
    counts.answerMsTotal += ms;
    counts.answerMsMost = Math.max(counts.answerMsMost, ms);
  });
}

export function takeVaultPhoneApprovalCounts() {
  const taken = {
    vault_phone_asks: counts.asked,
    vault_phone_allowed: counts.allowed,
    vault_phone_denied: counts.denied,
    vault_phone_expired: counts.expired,
    vault_phone_cancelled: counts.cancelled,
    vault_phone_unreachable: counts.unreachable,
    vault_phone_refused: counts.refused,
    vault_phone_unenrolled: counts.unenrolled,
    vault_phone_bad_signature: counts.bad_signature,
    vault_phone_keys_trusted: counts.trusted,
    vault_phone_answer_ms_total: counts.answerMsTotal,
    vault_phone_answer_ms_max: counts.answerMsMost,
  };
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
  return taken;
}
