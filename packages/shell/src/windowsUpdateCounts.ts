export type WindowsUpdateVerifyCounts = {
  verified: number;
  signature: number;
  manifest: number;
  tooLarge: number;
  missing: number;
  network: number;
  verifier: number;
  other: number;
};

export type WindowsUpdateCountsNative = {
  takeCounts(): Record<string, WindowsUpdateVerifyCounts>;
  setConsentEpoch(epoch: string): void;
};
