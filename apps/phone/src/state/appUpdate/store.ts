import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import {
  checksumVerdict,
  downloadOutlivedBy,
  downloadProgressOf,
  downloadRecordText,
  dueForUpdateCheck,
  findUpdate,
  handOffResultOf,
  installedReleaseVersion,
  installOutcomeOf,
  installSessionOf,
  installStatusOf,
  nextCheckAt,
  parseCheckAt,
  parseCommittedInstall,
  parseDownloadRecord,
  parseOfferedVersions,
  parseUnpublished,
  releasePageUrl,
  rememberUnpublished,
  updateDotShown,
  updateDownloadRequest,
  updateReadyMessage,
  updateRow,
  verifyOutcomeOf,
  withOfferedVersion,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECKSUM_TIMEOUT_MS,
  UPDATE_CHECKSUM_WITH_DIGEST_TIMEOUT_MS,
  type HandOffResult,
  type OfferedRelease,
  type ReleaseVersion,
  type UpdateHandoff,
  type UpdateStatus,
} from "../../lib/appUpdate";
import { whenIdle } from "../../lib/whenIdle";
import { downloads } from "../../platform/downloads";
import { pages } from "../../platform/pages";
import { fetchGitHubJson, fetchReleaseChecksum } from "../../platform/releases";
import { copyLink, openExternal } from "../../platform/system";
import { openSettings } from "../settings/nav";
import { readPreference, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { countUsage } from "../telemetry/telemetry";

export const UPDATE_NEXT_CHECK_KEY = "app_update_next_check_at";
export const UPDATE_OFFERED_KEY = "app_update_offered_versions";
export const UPDATE_UNPUBLISHED_KEY = "app_update_unpublished";
export const UPDATE_DOWNLOAD_KEY = "app_update_download";
export const UPDATE_COMMITTED_KEY = "app_update_committed";
export const UPDATE_SEEN_KEY = "app_update_seen_version";

const LAUNCH_QUIET_MS = 8_000;
const LAUNCH_IDLE_TIMEOUT_MS = 5_000;

type UpdateState = { status: UpdateStatus; offer: OfferedRelease | null; handoff: UpdateHandoff | null; progress: number | null; seenVersion: string | null };

export const useAppUpdate = create<UpdateState>()(() => ({ status: "idle", offer: null, handoff: null, progress: null, seenVersion: null }));

let installed: ReleaseVersion | null | undefined;

function installedVersion(): ReleaseVersion | null {
  if (installed !== undefined) return installed;
  try {
    installed = installedReleaseVersion(Platform.OS, pages.appRelease()?.releaseVersion, __DEV__);
  } catch {
    installed = null;
  }
  return installed;
}

export const appUpdatesOffered = () => installedVersion() !== null;

function readStored(key: string): string | null {
  try {
    return readPreference(browserDatabase(), key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    writePreference(browserDatabase(), key, value);
  } catch {
    return;
  }
}

const inFront = () => AppState.currentState === "active";

export const useUpdateDot = () => useAppUpdate((state) => appUpdatesOffered() && updateDotShown(state.status, state.offer, state.seenVersion));

export function markUpdateSeen() {
  const { offer, status } = useAppUpdate.getState();
  if (!offer || status === "current" || useAppUpdate.getState().seenVersion === offer.version) return;
  writeStored(UPDATE_SEEN_KEY, offer.version);
  useAppUpdate.setState({ seenVersion: offer.version });
}

let rowsShowing = 0;

export function showingUpdateRow() {
  rowsShowing += 1;
  markUpdateSeen();
  return () => {
    rowsShowing = Math.max(0, rowsShowing - 1);
  };
}

function announceOffer(offer: OfferedRelease) {
  if (rowsShowing > 0) {
    markUpdateSeen();
    return;
  }
  const { seenVersion } = useAppUpdate.getState();
  if (seenVersion === offer.version) return;
  const offered = parseOfferedVersions(readStored(UPDATE_OFFERED_KEY));
  if (offered.includes(offer.version)) return;
  writeStored(UPDATE_OFFERED_KEY, JSON.stringify(withOfferedVersion(offered, offer.version)));
  countUsage("app_update_offers_shown");
}

function showOffer(offer: OfferedRelease, status: UpdateStatus) {
  const same = useAppUpdate.getState().offer?.version === offer.version;
  useAppUpdate.setState({ status, offer, handoff: same ? useAppUpdate.getState().handoff : null, progress: same ? useAppUpdate.getState().progress : null });
  announceOffer(offer);
  return same;
}

async function runCheck(version: ReleaseVersion) {
  useAppUpdate.setState({ status: "checking" });
  countUsage("app_update_checks");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const startedAt = Date.now();
    const known = parseUnpublished(readStored(UPDATE_UNPUBLISHED_KEY), startedAt);
    const result = await findUpdate(version, (url) => fetchGitHubJson(url, controller.signal), known);
    const now = Date.now();
    if (result.unpublished.length > 0) writeStored(UPDATE_UNPUBLISHED_KEY, JSON.stringify(rememberUnpublished(known, result.unpublished, now)));
    const next = nextCheckAt(result, now);
    writeStored(UPDATE_NEXT_CHECK_KEY, next === null ? "" : String(next));
    if (result.kind === "available") {
      const same = showOffer(result.offer, "available");
      if (storedDownload()?.version === result.offer.version && !same) await refreshDownload(false);
      return;
    }
    const keep = result.kind !== "current";
    useAppUpdate.setState({ status: result.kind, offer: keep ? useAppUpdate.getState().offer : null, handoff: keep ? useAppUpdate.getState().handoff : null });
  } catch {
    useAppUpdate.setState({ status: "failed" });
  } finally {
    clearTimeout(deadline);
  }
}

export function checkForUpdate() {
  const version = installedVersion();
  if (!version || useAppUpdate.getState().status === "checking") return;
  void runCheck(version);
}

function checkIfDue() {
  const version = installedVersion();
  if (!version || !inFront() || useAppUpdate.getState().status === "checking") return;
  if (!dueForUpdateCheck(Date.now(), parseCheckAt(readStored(UPDATE_NEXT_CHECK_KEY)))) return;
  void runCheck(version);
}

let started = false;

export function startUpdateChecks() {
  watchUpdateDownloads();
  if (started || !appUpdatesOffered()) return;
  started = true;
  useAppUpdate.setState({ seenVersion: readStored(UPDATE_SEEN_KEY) || null });
  void handleLaunchInstallRequest();
  whenIdle(checkIfDue, LAUNCH_QUIET_MS, LAUNCH_IDLE_TIMEOUT_MS);
  AppState.addEventListener("change", (next) => {
    if (next === "active") checkIfDue();
  });
}

const setHandoff = (version: string, handoff: UpdateHandoff | null) => {
  if (useAppUpdate.getState().offer?.version === version) useAppUpdate.setState({ handoff });
};

const storedDownload = () => parseDownloadRecord(readStored(UPDATE_DOWNLOAD_KEY));

const forgetDownload = () => writeStored(UPDATE_DOWNLOAD_KEY, "");

const isCurrent = (id: string) => storedDownload()?.id === id;

async function handOff(url: string, title: string): Promise<HandOffResult> {
  if (Platform.OS === "android" && downloads.handsOffAppUpdates()) {
    try {
      return handOffResultOf(await downloads.handOffAppUpdate(url, title));
    } catch {
      return { handoff: "unavailable", id: null };
    }
  }
  try {
    await openExternal(url);
    return { handoff: "browser", id: null };
  } catch {
    return { handoff: "unavailable", id: null };
  }
}

let verifyingId: string | null = null;
let verified: { id: string; sha256: string } | null = null;
let installing: { id: string; session: string } | null = null;
let readyNotified: string | null = null;
const autoVerified = new Set<string>();

async function startDownload(offer: OfferedRelease) {
  const request = updateDownloadRequest(offer);
  if (!request) return;
  countUsage("app_update_offers_opened");
  const previous = storedDownload();
  if (previous) await downloads.discardAppUpdate(previous.id).catch(() => false);
  readyNotified = null;
  verified = null;
  installing = null;
  const result = await handOff(request.url, request.title);
  if (result.handoff === "downloading") {
    writeStored(UPDATE_DOWNLOAD_KEY, downloadRecordText(offer, result.id));
    useAppUpdate.setState({ progress: null });
    setHandoff(offer.version, "downloading");
    void downloads.askForUpdateNotifications().catch(() => undefined);
    return;
  }
  forgetDownload();
  setHandoff(offer.version, result.handoff);
  if (result.handoff === "unavailable") countUsage("app_update_handoffs_failed");
}

async function verifyDownloaded(offer: OfferedRelease, id: string): Promise<string | null> {
  const request = updateDownloadRequest(offer);
  if (!request || verifyingId === id) return null;
  if (verified?.id === id) return verified.sha256;
  verifyingId = id;
  setHandoff(offer.version, "verifying");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), request.sha256 ? UPDATE_CHECKSUM_WITH_DIGEST_TIMEOUT_MS : UPDATE_CHECKSUM_TIMEOUT_MS);
  try {
    const answer = await fetchReleaseChecksum(request.checksumUrl, controller.signal);
    clearTimeout(deadline);
    if (!isCurrent(id)) return null;
    const verdict = checksumVerdict(answer, request.version, request.sha256);
    if (verdict.kind === "unverified") {
      setHandoff(offer.version, "unchecked");
      return null;
    }
    if (verdict.kind === "refused") {
      await refuse(offer, id);
      return null;
    }
    const outcome = verifyOutcomeOf(await downloads.verifyAppUpdate(id, verdict.sha256, request.fileName).catch(() => "failed"));
    if (!isCurrent(id)) return null;
    if (outcome === "refused") {
      await refuse(offer, id);
      return null;
    }
    if (outcome === "gone") {
      forgetDownload();
      setHandoff(offer.version, null);
      return null;
    }
    if (outcome !== "verified") {
      setHandoff(offer.version, "unprepared");
      return null;
    }
    setHandoff(offer.version, "ready");
    verified = { id, sha256: verdict.sha256 };
    return verdict.sha256;
  } finally {
    clearTimeout(deadline);
    if (verifyingId === id) verifyingId = null;
  }
}

async function refuse(offer: OfferedRelease, id: string) {
  countUsage("app_update_checksums_refused");
  await downloads.discardAppUpdate(id).catch(() => false);
  if (verified?.id === id) verified = null;
  if (!isCurrent(id)) return;
  forgetDownload();
  setHandoff(offer.version, "refused");
}

let awaitingPermissionReturn = false;

async function askForInstallPermission(offer: OfferedRelease) {
  setHandoff(offer.version, "needs_permission");
  if (!inFront()) return;
  awaitingPermissionReturn = await downloads.openInstallPermission().catch(() => false);
}

async function installUpdate(offer: OfferedRelease, id: string) {
  const request = updateDownloadRequest(offer);
  if (!request || !isCurrent(id)) return;
  if (!downloads.canInstallPackages()) {
    await askForInstallPermission(offer);
    return;
  }
  const sha256 = await verifyDownloaded(offer, id);
  if (!sha256 || !isCurrent(id)) return;
  const answer = await downloads.installVerifiedUpdate(request.fileName, sha256, id).catch(() => "failed");
  const outcome = installOutcomeOf(answer);
  if (!isCurrent(id)) return;
  if (outcome === "refused") {
    await refuse(offer, id);
    return;
  }
  if (outcome === "needs_permission") {
    await askForInstallPermission(offer);
    return;
  }
  if (outcome === "gone") {
    verified = null;
    setHandoff(offer.version, "ready");
    return;
  }
  const session = installSessionOf(answer);
  if (outcome === "installing" && session) {
    installing = { id, session };
    writeStored(UPDATE_COMMITTED_KEY, JSON.stringify({ version: offer.version, session }));
    countUsage("app_update_installs_started");
    setHandoff(offer.version, "installing");
    return;
  }
  setHandoff(offer.version, "install_failed");
}

function installStatus(event: unknown) {
  const status = installStatusOf(event);
  if (!status || status.kind !== "update") return;
  const { offer } = useAppUpdate.getState();
  const current = installing;
  if (!offer || !current || current.session !== status.session || current.id !== status.download || !isCurrent(current.id)) return;
  if (status.status === "confirming") return;
  installing = null;
  if (status.status === "success") return;
  writeStored(UPDATE_COMMITTED_KEY, "");
  if (status.status === "aborted") {
    countUsage("app_update_installs_cancelled");
    setHandoff(offer.version, "ready");
    return;
  }
  countUsage("app_update_installs_failed");
  setHandoff(offer.version, "install_failed");
}

async function notifyReady(offer: OfferedRelease, id: string) {
  if (readyNotified === id || !isCurrent(id)) return;
  const request = updateDownloadRequest(offer);
  if (!request) return;
  const posted = await downloads.notifyUpdateReady(request.fileName, updateReadyMessage(offer), "Tap to install.").catch(() => false);
  if (posted && isCurrent(id)) readyNotified = id;
}

async function restoreDownload() {
  const record = storedDownload();
  const version = installedVersion();
  if (!record || !version) return;
  if (downloadOutlivedBy(record, version)) {
    if (parseCommittedInstall(readStored(UPDATE_COMMITTED_KEY))?.version === version.text) countUsage("app_update_installs_completed");
    writeStored(UPDATE_COMMITTED_KEY, "");
    await downloads.discardAppUpdate(record.id).catch(() => false);
    if (isCurrent(record.id)) forgetDownload();
    return;
  }
  const { offer, status } = useAppUpdate.getState();
  if (!offer || offer.version !== record.version) showOffer(record.offer, status === "checking" ? status : "available");
  await refreshDownload(false);
}

export async function refreshDownload(completed: boolean) {
  if (!useAppUpdate.getState().offer && storedDownload()) {
    await restoreDownload();
    return;
  }
  const { offer, handoff } = useAppUpdate.getState();
  const record = storedDownload();
  if (!offer || !record || record.version !== offer.version) return;
  const progress = downloadProgressOf(await downloads.appUpdateStatus(record.id).catch(() => "gone"));
  if (!isCurrent(record.id)) return;
  if (progress === "gone") {
    forgetDownload();
    setHandoff(offer.version, null);
    return;
  }
  if (progress === "failed") {
    await downloads.discardAppUpdate(record.id).catch(() => false);
    if (!isCurrent(record.id)) return;
    forgetDownload();
    setHandoff(offer.version, "failed");
    return;
  }
  if (progress === "downloading") {
    setHandoff(offer.version, "downloading");
    return;
  }
  if (handoff === "installing" || handoff === "verifying") return;
  if (handoff === "needs_permission" && !downloads.canInstallPackages()) return;
  if (handoff !== "unchecked" && handoff !== "unprepared" && handoff !== "install_failed") setHandoff(offer.version, "ready");
  const firstLook = !autoVerified.has(record.id) && verified?.id !== record.id;
  if (!completed && !firstLook) {
    if (verified?.id === record.id && useAppUpdate.getState().handoff === "ready") await notifyReady(offer, record.id);
    return;
  }
  autoVerified.add(record.id);
  if (await verifyDownloaded(offer, record.id)) await notifyReady(offer, record.id);
}

export async function pollDownloadProgress() {
  const record = storedDownload();
  if (!record || useAppUpdate.getState().handoff !== "downloading") return;
  const fraction = await downloads.appUpdateProgress(record.id).catch(() => -1);
  if (!isCurrent(record.id)) return;
  useAppUpdate.setState({ progress: typeof fraction === "number" && fraction >= 0 && fraction <= 1 ? fraction : null });
}

export async function openUpdate() {
  const { status, offer, handoff, progress } = useAppUpdate.getState();
  const row = updateRow(status, offer, handoff, progress);
  if (row.action === "check") {
    checkForUpdate();
    return;
  }
  if (!offer) return;
  const request = updateDownloadRequest(offer);
  if (!request) return;
  const record = storedDownload();
  switch (row.action) {
    case "download":
      await startDownload(offer);
      return;
    case "install":
      if (record && record.version === offer.version) await installUpdate(offer, record.id);
      else await startDownload(offer);
      return;
    case "permission":
      if (downloads.canInstallPackages() && record && record.version === offer.version) await installUpdate(offer, record.id);
      else awaitingPermissionReturn = await downloads.openInstallPermission().catch(() => false);
      return;
    case "copy":
      await copyLink(cleanUrl(releasePageUrl(request.version))).catch(() => undefined);
      return;
    case "none":
      return;
  }
}

let pendingPackage: string | null = null;

export async function installDownloadedPackage(uri: string): Promise<boolean> {
  const outcome = installOutcomeOf(await downloads.installDownloadedFile(uri).catch(() => "failed"));
  if (outcome === "needs_permission") {
    pendingPackage = (await downloads.openInstallPermission().catch(() => false)) ? uri : null;
    return true;
  }
  pendingPackage = null;
  return outcome === "installing";
}

let watchingDownloads = false;

function takeInstallRequest(): boolean {
  try {
    return downloads.takeInstallRequest();
  } catch {
    return false;
  }
}

async function installRequested(requested: boolean) {
  if (!requested) return;
  openSettings({ page: "about" });
  const { offer } = useAppUpdate.getState();
  const record = storedDownload();
  if (!offer || !record || record.version !== offer.version) return;
  await installUpdate(offer, record.id);
}

async function returnedToFront() {
  try {
    installStatus(downloads.takeInstallStatus());
  } catch {
    installStatus(null);
  }
  const package_ = pendingPackage;
  pendingPackage = null;
  if (package_ && downloads.canInstallPackages()) await installDownloadedPackage(package_);
  if (awaitingPermissionReturn) {
    awaitingPermissionReturn = false;
    const { offer } = useAppUpdate.getState();
    const record = storedDownload();
    if (offer && record && record.version === offer.version && downloads.canInstallPackages()) {
      await installUpdate(offer, record.id);
      return;
    }
  }
  const requested = takeInstallRequest();
  await refreshDownload(false);
  await installRequested(requested);
}

export function watchUpdateDownloads() {
  if (watchingDownloads || Platform.OS !== "android") return;
  watchingDownloads = true;
  try {
    downloads.addAppUpdateListener(({ id }) => {
      if (isCurrent(id)) void refreshDownload(true);
    });
    downloads.addInstallStatusListener(installStatus);
  } catch {
    watchingDownloads = false;
  }
  AppState.addEventListener("change", (next) => {
    if (next === "active") void returnedToFront();
  });
}

export async function handleLaunchInstallRequest() {
  const requested = takeInstallRequest();
  await restoreDownload();
  await installRequested(requested);
}
