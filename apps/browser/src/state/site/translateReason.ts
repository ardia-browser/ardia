import { errorText } from "../../lib/errors";

export type TranslateStage = "detect" | "start" | "collect" | "model" | "apply" | "follow";

export type FinishStage = TranslateStage | "revert" | "same_language" | "status" | "prepare" | "open";

export type TranslateReason = "pair_unavailable" | "no_window" | "page_not_ready" | "model_no_answer" | "page_closed" | "other";

export class TranslateFailure extends Error {
  reason: TranslateReason;
  constructor(message: string, reason: TranslateReason) {
    super(message);
    this.reason = reason;
  }
}

export function failureReason(error: unknown, stage: FinishStage): TranslateReason {
  if (error instanceof TranslateFailure) return error.reason;
  if (stage === "prepare" && /\bno window\b/i.test(errorText(error))) return "no_window";
  return "other";
}

const failedAt = new WeakMap<object, FinishStage>();

export async function failingAt<T>(stage: FinishStage, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (typeof error === "object" && error !== null && !failedAt.has(error)) failedAt.set(error, stage);
    throw error;
  }
}

export function failureStage(error: unknown, reached: FinishStage): FinishStage {
  return (typeof error === "object" && error !== null ? failedAt.get(error) : undefined) ?? reached;
}

export const MODEL_ERRORS = [
  "cancelled", "nothing_to_translate", "unable_to_identify_language", "internal_error", "already_cancelled",
  "not_installed", "unsupported_source_language", "unsupported_target_language", "unsupported_language_pairing", "unavailable",
];
