import { consentOrNow, countFor, type ConsentToken } from "./consentPeriod";
import { nativeConsent } from "./nativeConsent";

export const UPDATE_DOWNLOAD_FAILURES = ["version", "kind", "network", "manifest", "tooLarge", "busy", "disk", "other"] as const;
export const UPDATE_INSTALL_FAILURES = ["usage", "missing", "manifest", "signature", "notNewer", "kind", "checksum", "install", "busy", "polkit", "timeout", "extract", "auth", "relaunch", "disk", "other"] as const;
const UPDATE_INSTALL_KINDS = ["deb", "tarball", "appimage"] as const;

type UpdateDownloadFailure = (typeof UPDATE_DOWNLOAD_FAILURES)[number];
type UpdateInstallFailure = (typeof UPDATE_INSTALL_FAILURES)[number];
export type UpdateInstallKind = (typeof UPDATE_INSTALL_KINDS)[number];

const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const downloadFailureField = (reason: UpdateDownloadFailure) => `update_download_failures_${snake(reason)}`;
const installFailureField = (reason: UpdateInstallFailure) => `update_install_failures_${snake(reason)}`;
const installField = (kind: UpdateInstallKind) => `update_installs_${kind}`;

const SELF_UPDATE_FIELDS = [
  "update_downloads_started",
  "update_downloads_finished",
  ...UPDATE_DOWNLOAD_FAILURES.map(downloadFailureField),
  ...UPDATE_INSTALL_KINDS.map(installField),
  ...UPDATE_INSTALL_FAILURES.map(installFailureField),
  "update_restarts",
  "update_install_starts",
];

const noSelfUpdates = () => Object.fromEntries(SELF_UPDATE_FIELDS.map((field) => [field, 0])) as Record<string, number>;

let checks = { asked: 0, automatic: 0, failed: 0, found: 0, pageOpens: 0, noticesDismissed: 0, managedFlatpak: 0, managedPackage: 0, switchRefreshes: 0, switchRefreshFailures: 0, unsandboxed: 0, passwordGranted: 0, passwordDenied: 0, passwordCancelled: 0 };
let selfUpdates = noSelfUpdates();

const countSelfUpdate = (field: string, consent: ConsentToken | null | undefined) => countFor(consentOrNow(consent), () => void (selfUpdates[field] = (selfUpdates[field] ?? 0) + 1));

export function noteUpdateCheck(asked: boolean, outcome: "found" | "upToDate" | "failed", consent?: ConsentToken | null) {
  const fields = { update_checks_asked: +asked, update_checks_automatic: +!asked, update_check_failures: +(outcome === "failed"), update_checks_found: +(outcome === "found") };
  countFor(consentOrNow(consent), () => {
    checks.asked += fields.update_checks_asked;
    checks.automatic += fields.update_checks_automatic;
    checks.failed += fields.update_check_failures;
    checks.found += fields.update_checks_found;
  });
}

export const noteUpdatePageOpened = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (checks.pageOpens += 1));
export const noteUpdateNoticeDismissed = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (checks.noticesDismissed += 1));
export const noteManagedUpdateOffer = (manager: "flatpak" | "package", consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (manager === "flatpak" ? (checks.managedFlatpak += 1) : (checks.managedPackage += 1)));

const updateDownloadFailure = (reason: unknown): UpdateDownloadFailure => (UPDATE_DOWNLOAD_FAILURES as readonly unknown[]).includes(reason) ? (reason as UpdateDownloadFailure) : "other";
const updateInstallFailure = (reason: unknown): UpdateInstallFailure => (UPDATE_INSTALL_FAILURES as readonly unknown[]).includes(reason) ? (reason as UpdateInstallFailure) : "other";

export const noteUpdateDownloadStarted = (consent: ConsentToken | null) => countSelfUpdate("update_downloads_started", consent);
export const noteUpdateDownloadFinished = (consent: ConsentToken | null) => countSelfUpdate("update_downloads_finished", consent);
export const noteUpdateDownloadFailed = (reason: unknown, consent: ConsentToken | null) => countSelfUpdate(downloadFailureField(updateDownloadFailure(reason)), consent);
export const noteUpdateInstalled = (kind: UpdateInstallKind, consent: ConsentToken | null) => countSelfUpdate(installField(kind), consent);
export const noteUpdateInstallFailed = (reason: unknown, consent: ConsentToken | null) => countSelfUpdate(installFailureField(updateInstallFailure(reason)), consent);
export const noteUpdateRestart = (consent: ConsentToken | null) => countSelfUpdate("update_restarts", consent);

export type SparkleUpdateEvent = ({ type: "updateStep"; step: "downloadStarted" | "downloadFinished" | "installing" } | { type: "updateFailed"; stage: "download" | "install"; reason: string }) & { epoch?: string };

export function noteSparkleUpdate(event: SparkleUpdateEvent) {
  const now = nativeConsent(event);
  if (event.type === "updateFailed") return event.stage === "download" ? noteUpdateDownloadFailed(event.reason, now) : noteUpdateInstallFailed(event.reason, now);
  if (event.step === "downloadStarted") noteUpdateDownloadStarted(now);
  else if (event.step === "downloadFinished") noteUpdateDownloadFinished(now);
  else if (event.step === "installing") countSelfUpdate("update_install_starts", now);
}

export function noteSwitchRefresh(result: "updated" | "failed" | "already") {
  if (result === "updated") checks.switchRefreshes += 1;
  if (result === "failed") checks.switchRefreshFailures += 1;
}

export const noteUnsandboxedLaunch = (consent?: ConsentToken | null) => countFor(consentOrNow(consent), () => void (checks.unsandboxed += 1));

export function noteLoginPasswordCheck(result: unknown) {
  if (result === "granted") checks.passwordGranted += 1;
  else if (result === "denied") checks.passwordDenied += 1;
  else if (result === "cancelled") checks.passwordCancelled += 1;
}

export function takeUpdateCounts() {
  const taken = {
    update_checks_asked: checks.asked,
    update_checks_automatic: checks.automatic,
    update_check_failures: checks.failed,
    update_checks_found: checks.found,
    update_release_page_opens: checks.pageOpens,
    update_notices_dismissed: checks.noticesDismissed,
    update_offers_managed_flatpak: checks.managedFlatpak,
    update_offers_managed_package: checks.managedPackage,
    kill_switch_refreshes: checks.switchRefreshes,
    kill_switch_refresh_failures: checks.switchRefreshFailures,
    launches_without_sandbox: checks.unsandboxed,
    login_password_checks_granted: checks.passwordGranted,
    login_password_checks_denied: checks.passwordDenied,
    login_password_checks_cancelled: checks.passwordCancelled,
    ...selfUpdates,
  };
  checks = { asked: 0, automatic: 0, failed: 0, found: 0, pageOpens: 0, noticesDismissed: 0, managedFlatpak: 0, managedPackage: 0, switchRefreshes: 0, switchRefreshFailures: 0, unsandboxed: 0, passwordGranted: 0, passwordDenied: 0, passwordCancelled: 0 };
  selfUpdates = noSelfUpdates();
  return taken;
}
