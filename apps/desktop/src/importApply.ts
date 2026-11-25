import { applyResult as sharedApplyResult, importDestination, type ImportCounts, type ImportDestination } from "../../browser/src/state/import/apply.ts";
import type { ImportKind, ImportResult } from "../../browser/src/platform/importModule.ts";
import type { ConsentToken } from "../../browser/src/state/telemetry/choice.ts";
import type { PendingPasswords, WrittenPasswords } from "./hostImport.ts";

export * from "../../browser/src/state/import/apply.ts";

type PasswordSink = {
  pending(result: unknown): PendingPasswords | null;
  write(token: string, profile: string): Promise<WrittenPasswords>;
  discard(token: string): void;
};

export async function applyPendingPasswords(
  sink: PasswordSink,
  profileId: string,
  result: ImportResult,
  requested: ImportKind[],
  onFailed?: (kind: ImportKind) => void,
  destination: ImportDestination | null = importDestination(profileId),
): Promise<number> {
  const pending = sink.pending(result);
  if (!pending) return 0;
  if (!requested.includes("passwords")) {
    sink.discard(pending.token);
    return 0;
  }
  if (!destination?.current()) {
    sink.discard(pending.token);
    onFailed?.("passwords");
    return 0;
  }
  try {
    return (await sink.write(pending.token, destination.engineId)).added;
  } catch {
    onFailed?.("passwords");
    return 0;
  }
}

let sink: PasswordSink | null = null;

export function setImportPasswordSink(next: PasswordSink | null) {
  sink = next;
}

export async function applyResult(
  profileId: string,
  result: ImportResult,
  browserName: string,
  requested: ImportKind[],
  onFailed?: (kind: ImportKind) => void,
  destination: ImportDestination | null = importDestination(profileId),
  consent?: ConsentToken | null,
): Promise<ImportCounts> {
  const counts = await sharedApplyResult(profileId, result, browserName, requested, onFailed, destination, consent);
  if (sink) counts.passwords += await applyPendingPasswords(sink, profileId, result, requested, onFailed, destination);
  else if (requested.includes("passwords") && result && (result as { passwords?: unknown }).passwords) onFailed?.("passwords");
  return counts;
}
