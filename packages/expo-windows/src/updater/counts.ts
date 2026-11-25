import type { WindowsUpdateCountsNative, WindowsUpdateVerifyCounts } from "@ardia/shell";

export const WINDOWS_UPDATE_VERIFY_FAILURES = ["signature", "manifest", "tooLarge", "missing", "network", "verifier", "other"] as const;
export type WindowsUpdateVerifyFailure = (typeof WINDOWS_UPDATE_VERIFY_FAILURES)[number];
export type WindowsUpdateVerifyKey = keyof WindowsUpdateVerifyCounts;

const zero = (): WindowsUpdateVerifyCounts => ({ verified: 0, signature: 0, manifest: 0, tooLarge: 0, missing: 0, network: 0, verifier: 0, other: 0 });

export function createWindowsUpdateCounts(): WindowsUpdateCountsNative & {
  consentEpoch(): string;
  note(key: WindowsUpdateVerifyKey, startedEpoch?: string): void;
} {
  let held: Record<string, WindowsUpdateVerifyCounts> = {};
  let epoch = "";
  return {
    consentEpoch() {
      return epoch;
    },
    note(key, startedEpoch) {
      if (!epoch) return;
      if (startedEpoch !== undefined && startedEpoch !== epoch) return;
      const into = (held[epoch] ??= zero());
      into[key] += 1;
    },
    takeCounts() {
      const taken = held;
      held = {};
      return taken;
    },
    setConsentEpoch(next) {
      if (next === epoch) return;
      epoch = next;
      held = {};
    },
  };
}

export const windowsUpdateCounts = createWindowsUpdateCounts();
