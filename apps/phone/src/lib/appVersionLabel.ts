export const TESTFLIGHT_RECEIPT_NAME = "sandboxReceipt";

export type AppReleaseInfo = { releaseVersion: string; build: string; receiptName: string | null };

type ReleaseVersion = { appleVersion: string; nightly: number | null };

export function parseReleaseVersion(text: string): ReleaseVersion | null {
  const match = /^(\d+\.\d+\.\d+)(?:-nightly\.(\d+))?$/.exec(text);
  const appleVersion = match?.[1];
  if (!appleVersion) return null;
  return { appleVersion, nightly: match?.[2] === undefined ? null : Number(match[2]) };
}

export function appVersionLabel(release: AppReleaseInfo, isDebug: boolean): string {
  const parsed = isDebug ? null : parseReleaseVersion(release.releaseVersion);
  if (!parsed) return `Ardia Dev (${release.build})`;
  const nightlyWithoutReceipt = release.receiptName === null && parsed.nightly !== null;
  if (release.receiptName !== TESTFLIGHT_RECEIPT_NAME && !nightlyWithoutReceipt) return `Ardia ${parsed.appleVersion} (${release.build})`;
  return parsed.nightly === null ? `Ardia ${parsed.appleVersion} Nightly (${release.build})` : `Ardia ${parsed.appleVersion} Nightly ${parsed.nightly} (${release.build})`;
}
