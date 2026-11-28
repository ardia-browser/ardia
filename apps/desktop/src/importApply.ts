import { applyResult as sharedApplyResult, discardImportedResult as sharedDiscardImportedResult, type ApplyOptions, type ImportCounts, type PasswordsWritten } from "../../browser/src/state/import/apply.ts";
import { engineProfile, isIncognitoProfile } from "../../browser/src/state/browser/model.ts";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
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
  { signal, onPasswordsWritten }: ApplyOptions = {},
): Promise<number> {
  const pending = sink.pending(result);
  if (!pending) return 0;
  if (!requested.includes("passwords") || signal?.aborted) {
    sink.discard(pending.token);
    return 0;
  }
  if (isIncognitoProfile(profileId)) {
    sink.discard(pending.token);
    onFailed?.("passwords");
    return 0;
  }
  try {
    const written = await sink.write(pending.token, engineProfile(useBrowser.getState(), profileId));
    onPasswordsWritten?.(writtenReport(written));
    return written.added;
  } catch {
    onFailed?.("passwords");
    return 0;
  }
}

const writtenReport = (written: WrittenPasswords): PasswordsWritten => ({ keptExisting: written.conflicts, failed: written.invalid });

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
  consent?: ConsentToken | null,
  options: ApplyOptions = {},
): Promise<ImportCounts> {
  const counts = await sharedApplyResult(profileId, result, browserName, requested, onFailed, consent, options);
  if (sink) counts.passwords += await applyPendingPasswords(sink, profileId, result, requested, onFailed, options);
  else if (requested.includes("passwords") && result && (result as { passwords?: unknown }).passwords) onFailed?.("passwords");
  return counts;
}


export function discardImportedResult(result: Pick<ImportResult, "vaultToken">) {
  sharedDiscardImportedResult(result);
  const pending = sink?.pending(result);
  if (pending) sink?.discard(pending.token);
}
