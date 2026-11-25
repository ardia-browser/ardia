import { windowsUpdateCounts } from "../../platform/windowsUpdateCounts";
import { stillValid, type ConsentToken } from "./client";

const FIELDS = {
  verified: "windows_update_manifest_verified",
  signature: "windows_update_manifest_failures_signature",
  manifest: "windows_update_manifest_failures_manifest",
  tooLarge: "windows_update_manifest_failures_too_large",
  missing: "windows_update_manifest_failures_missing",
  network: "windows_update_manifest_failures_network",
  verifier: "windows_update_manifest_failures_verifier",
  other: "windows_update_manifest_failures_other",
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];

export function takeWindowsUpdateCounts(): Partial<Record<Field, number>> {
  const valid = Object.entries(windowsUpdateCounts.takeCounts()).filter(([epoch]) => stillValid(epoch as ConsentToken));
  if (!valid.length) return {};
  const sent = Object.fromEntries(Object.values(FIELDS).map((field) => [field, 0])) as Record<Field, number>;
  for (const [, raw] of valid) {
    for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, Field][]) {
      const n = raw?.[key] ?? 0;
      sent[field] += Number.isSafeInteger(n) && n > 0 ? n : 0;
    }
  }
  return sent;
}
