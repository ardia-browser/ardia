import { compareAndroidReleases, parseAndroidRelease, type AndroidRelease, type AndroidReleaseChannel } from "./androidRelease.ts";

export const RELEASE_REPO = "ardia-browser/ardia";
export const RELEASE_TAG_PREFIX = "android-v";
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_RETRY_INCOMPLETE_MS = 10 * 60 * 1000;
export const UPDATE_RETRY_FAILED_MS = 30 * 60 * 1000;
export const UPDATE_CHECK_LONGEST_WAIT_MS = 24 * 60 * 60 * 1000;
export const UPDATE_RETRY_SOONEST_MS = 60 * 1000;
export const UNPUBLISHED_REMEMBERED_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
export const UPDATE_CHECKSUM_TIMEOUT_MS = 30_000;
export const UPDATE_CHECKSUM_WITH_DIGEST_TIMEOUT_MS = 10_000;
export const MAX_RELEASE_LOOKUPS = 3;
export const MAX_GITHUB_BODY_CHARS = 1_000_000;

const MAX_TAG_REFS = 2_000;
const MAX_ASSETS = 50;
const MAX_REMEMBERED = 50;
const MAX_OFFERED = 20;
const TAG_REF = /^refs\/tags\/android-v([0-9A-Za-z.-]{1,40})$/;
const ISO_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/;
const APK_PATH = /^\/ardia-browser\/ardia\/releases\/download\/android-v([0-9A-Za-z.-]{1,40})\/Ardia-([0-9A-Za-z.-]{1,40})\.apk$/;

export type ReleaseVersion = AndroidRelease;

export type ReleaseChannel = AndroidReleaseChannel;

export type OfferedRelease = { version: string; downloadUrl: string; checksumUrl: string; sha256: string | null };

export const parseAndroidVersion = (text: unknown): ReleaseVersion | null => parseAndroidRelease(text);

export const compareReleaseVersions = compareAndroidReleases;

export const offeredOnChannel = (channel: ReleaseChannel, candidate: ReleaseVersion) => channel === "nightly" || candidate.channel === "stable";

export function installedReleaseVersion(os: string, releaseVersion: string | null | undefined, isDev: boolean): ReleaseVersion | null {
  if (os !== "android" || isDev) return null;
  return parseAndroidVersion(releaseVersion);
}

export const releaseTag = (version: ReleaseVersion) => `${RELEASE_TAG_PREFIX}${version.text}`;

export const apkName = (version: ReleaseVersion) => `Ardia-${version.text}.apk`;

export const apkDownloadUrl = (version: ReleaseVersion) => `https://github.com/${RELEASE_REPO}/releases/download/${releaseTag(version)}/${apkName(version)}`;

export const apkChecksumUrl = (version: ReleaseVersion) => `${apkDownloadUrl(version)}.sha256`;

export const releasePageUrl = (version: ReleaseVersion) => `https://github.com/${RELEASE_REPO}/releases/tag/${releaseTag(version)}`;

export const releaseTagsUrl = () => `https://api.github.com/repos/${RELEASE_REPO}/git/matching-refs/tags/${RELEASE_TAG_PREFIX}`;

export const releaseLookupUrl = (version: ReleaseVersion) => `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${releaseTag(version)}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readGitHubJson(text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_GITHUB_BODY_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function newerTaggedVersions(body: unknown, installed: ReleaseVersion): ReleaseVersion[] {
  if (!Array.isArray(body)) return [];
  const found = new Map<number, ReleaseVersion>();
  for (const entry of body.slice(0, MAX_TAG_REFS)) {
    if (!isRecord(entry)) continue;
    const match = typeof entry.ref === "string" ? TAG_REF.exec(entry.ref) : null;
    const version = parseAndroidVersion(match?.[1]);
    if (!version || !offeredOnChannel(installed.channel, version) || compareReleaseVersions(version, installed) <= 0) continue;
    found.set(version.code, version);
  }
  return [...found.values()].sort((a, b) => compareReleaseVersions(b, a));
}

export function releaseOfDownloadUrl(url: unknown): ReleaseVersion | null {
  if (typeof url !== "string" || url.length > 300) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "" || parsed.href !== url) return null;
  const match = APK_PATH.exec(parsed.pathname);
  const version = parseAndroidVersion(match?.[1]);
  return version !== null && match?.[2] === version.text && apkDownloadUrl(version) === url ? version : null;
}

export const isReleaseDownloadUrl = (url: unknown): url is string => releaseOfDownloadUrl(url) !== null;

export function updateDownloadRequest(offer: { version?: unknown; downloadUrl?: unknown; checksumUrl?: unknown; sha256?: unknown } | null | undefined): { url: string; checksumUrl: string; fileName: string; title: string; version: ReleaseVersion; sha256: string | null } | null {
  if (!offer || typeof offer !== "object") return null;
  const version = releaseOfDownloadUrl(offer.downloadUrl);
  if (!version || offer.version !== version.text || offer.checksumUrl !== apkChecksumUrl(version)) return null;
  const sha256 = "sha256" in offer && typeof offer.sha256 === "string" && /^[0-9a-f]{64}$/.test(offer.sha256) ? offer.sha256 : null;
  return { url: apkDownloadUrl(version), checksumUrl: apkChecksumUrl(version), fileName: apkName(version), title: `Ardia ${version.text}`, version, sha256 };
}

const SHA256 = /^[0-9a-f]{64}$/;

export function assetDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  return match ? match[1]! : null;
}

export type ChecksumVerdict = { kind: "verified"; sha256: string } | { kind: "refused" } | { kind: "unverified" };

export function checksumVerdict(answer: { kind: "text"; text: string } | { kind: "missing" } | { kind: "unreachable" }, version: ReleaseVersion, apiDigest: string | null): ChecksumVerdict {
  const digest = typeof apiDigest === "string" && SHA256.test(apiDigest) ? apiDigest : null;
  if (answer.kind === "unreachable") return digest ? { kind: "verified", sha256: digest } : { kind: "unverified" };
  if (answer.kind === "missing") return { kind: "refused" };
  const fromFile = parseReleaseChecksum(answer.text, version);
  if (!fromFile || (digest !== null && digest !== fromFile)) return { kind: "refused" };
  return { kind: "verified", sha256: fromFile };
}

export function parseReleaseChecksum(text: unknown, version: ReleaseVersion): string | null {
  if (typeof text !== "string" || text.length > 512) return null;
  const match = /^([0-9a-f]{64}) [ *]([0-9A-Za-z.-]{1,60})(?:\r?\n)?$/.exec(text);
  return match && match[2] === apkName(version) ? match[1]! : null;
}

export function isPublishedTime(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_TIME.exec(value);
  if (!match) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 19) === match[1];
}

export function publishedRelease(body: unknown, version: ReleaseVersion): OfferedRelease | null {
  if (!isRecord(body)) return null;
  if (body.draft !== false || body.tag_name !== releaseTag(version) || !isPublishedTime(body.published_at)) return null;
  const assets = body.assets;
  if (!Array.isArray(assets)) return null;
  const expectedUrl = apkDownloadUrl(version);
  const uploadedAsset = (name: string, url: string) => assets.slice(0, MAX_ASSETS).find((asset: unknown): asset is Record<string, unknown> => isRecord(asset) && asset.name === name && asset.state === "uploaded" && asset.browser_download_url === url);
  const uploaded = (name: string, url: string) => uploadedAsset(name, url) !== undefined;
  if (!uploaded(apkName(version), expectedUrl) || !uploaded(`${apkName(version)}.sha256`, apkChecksumUrl(version)) || !isReleaseDownloadUrl(expectedUrl)) return null;
  return { version: version.text, downloadUrl: expectedUrl, checksumUrl: apkChecksumUrl(version), sha256: assetDigest(uploadedAsset(apkName(version), expectedUrl)?.digest) };
}

export type UnpublishedMemo = Record<string, number>;

export function parseUnpublished(text: string | null | undefined, now: number): UnpublishedMemo {
  const body = readGitHubJson(text);
  if (!isRecord(body)) return {};
  const kept: [string, number][] = [];
  for (const [version, at] of Object.entries(body)) {
    if (parseAndroidVersion(version) === null || !Number.isSafeInteger(at)) continue;
    if ((at as number) > now + UPDATE_RETRY_SOONEST_MS || now - (at as number) >= UNPUBLISHED_REMEMBERED_MS) continue;
    kept.push([version, at as number]);
  }
  return Object.fromEntries(kept.sort((a, b) => b[1] - a[1]).slice(0, MAX_REMEMBERED));
}

export function rememberUnpublished(memo: UnpublishedMemo, versions: readonly string[], now: number): UnpublishedMemo {
  const next: UnpublishedMemo = { ...memo };
  for (const version of versions) if (parseAndroidVersion(version)) next[version] = now;
  return parseUnpublished(JSON.stringify(next), now);
}

export function parseOfferedVersions(text: string | null | undefined): string[] {
  const body = readGitHubJson(text);
  if (!Array.isArray(body)) return [];
  return [...new Set(body.filter((version): version is string => parseAndroidVersion(version) !== null))].slice(-MAX_OFFERED);
}

export const withOfferedVersion = (offered: readonly string[], version: string) => [...offered.filter((known) => known !== version), version].slice(-MAX_OFFERED);

export function updateOfferWanted(offer: OfferedRelease | null, offered: readonly string[]): offer is OfferedRelease {
  return offer !== null && !offered.includes(offer.version);
}

export type GitHubJsonAnswer = { kind: "json"; body: unknown } | { kind: "missing" } | { kind: "refused"; retryAt: number | null } | { kind: "unreachable" };

export type UpdateCheckResult =
  | { kind: "available"; offer: OfferedRelease; unpublished: string[] }
  | { kind: "current"; unpublished: string[] }
  | { kind: "incomplete"; unpublished: string[] }
  | { kind: "failed"; answered: boolean; retryAt: number | null; unpublished: string[] };

export async function findUpdate(installed: ReleaseVersion, fetchJson: (url: string) => Promise<GitHubJsonAnswer>, known: UnpublishedMemo = {}): Promise<UpdateCheckResult> {
  const unpublished: string[] = [];
  const tags = await fetchJson(releaseTagsUrl());
  if (tags.kind !== "json") return { kind: "failed", answered: tags.kind !== "unreachable", retryAt: tags.kind === "refused" ? tags.retryAt : null, unpublished };
  if (!Array.isArray(tags.body)) return { kind: "failed", answered: true, retryAt: null, unpublished };
  const candidates = newerTaggedVersions(tags.body, installed).filter((candidate) => !Object.hasOwn(known, candidate.text));
  let lookups = 0;
  for (const candidate of candidates) {
    if (lookups === MAX_RELEASE_LOOKUPS) return { kind: "incomplete", unpublished };
    lookups += 1;
    const release = await fetchJson(releaseLookupUrl(candidate));
    if (release.kind === "missing") {
      unpublished.push(candidate.text);
      continue;
    }
    if (release.kind !== "json") return { kind: "failed", answered: release.kind !== "unreachable", retryAt: release.kind === "refused" ? release.retryAt : null, unpublished };
    const offer = publishedRelease(release.body, candidate);
    if (offer) return { kind: "available", offer, unpublished };
    unpublished.push(candidate.text);
  }
  return { kind: "current", unpublished };
}

export function retryAtFrom(status: number, header: (name: string) => string | null, now: number): number | null {
  const retryAfter = header("retry-after")?.trim() ?? "";
  if (/^\d{1,6}$/.test(retryAfter)) return now + Number(retryAfter) * 1000;
  if (retryAfter !== "") {
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return at;
  }
  const reset = header("x-ratelimit-reset")?.trim() ?? "";
  if ((status === 403 || status === 429) && header("x-ratelimit-remaining")?.trim() === "0" && /^\d{1,12}$/.test(reset)) return Number(reset) * 1000;
  return null;
}

export function nextCheckAt(result: UpdateCheckResult, now: number): number | null {
  if (result.kind === "available" || result.kind === "current") return now + UPDATE_CHECK_EVERY_MS;
  if (result.kind === "incomplete") return now + UPDATE_RETRY_INCOMPLETE_MS;
  if (!result.answered) return null;
  if (result.retryAt === null) return now + UPDATE_RETRY_FAILED_MS;
  return Math.min(now + UPDATE_CHECK_LONGEST_WAIT_MS, Math.max(now + UPDATE_RETRY_SOONEST_MS, result.retryAt));
}

export function parseCheckAt(text: string | null | undefined): number | null {
  if (typeof text !== "string" || !/^\d{1,16}$/.test(text)) return null;
  const at = Number(text);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

export function dueForUpdateCheck(now: number, nextAt: number | null): boolean {
  if (nextAt === null) return true;
  if (nextAt - now > UPDATE_CHECK_LONGEST_WAIT_MS) return true;
  return now >= nextAt;
}

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "incomplete" | "failed";

export type UpdateHandoff = "downloading" | "verifying" | "ready" | "needs_permission" | "installing" | "failed" | "refused" | "unchecked" | "unprepared" | "install_failed" | "browser" | "unavailable";

export type UpdateRowAction = "check" | "download" | "install" | "permission" | "copy" | "none";

export type UpdateRow = { title: string; detail: string | undefined; actionLabel: string | undefined; action: UpdateRowAction };

export const updateReadyMessage = (offer: OfferedRelease) => `Ardia ${offer.version} is ready to install`;

const TRY_AGAIN = "Try again";

export const progressDetail = (progress: number | null | undefined) => (typeof progress === "number" && Number.isFinite(progress) && progress >= 0 && progress <= 1 ? `${Math.floor(progress * 100)}%` : undefined);

export function updateRow(status: UpdateStatus, offer: OfferedRelease | null, handoff: UpdateHandoff | null, progress: number | null = null): UpdateRow {
  if (offer && status !== "current") {
    const v = offer.version;
    switch (handoff) {
      case "downloading":
        return { title: `Downloading Ardia ${v}…`, detail: progressDetail(progress), actionLabel: undefined, action: "none" };
      case "verifying":
        return { title: `Checking Ardia ${v}…`, detail: undefined, actionLabel: undefined, action: "none" };
      case "ready":
        return { title: updateReadyMessage(offer), detail: undefined, actionLabel: "Install", action: "install" };
      case "installing":
        return { title: updateReadyMessage(offer), detail: "Confirm in Android’s installer.", actionLabel: "Install", action: "install" };
      case "needs_permission":
        return { title: "Allow Ardia to install apps", detail: undefined, actionLabel: "Open settings", action: "permission" };
      case "failed":
        return { title: "The download didn’t finish", detail: undefined, actionLabel: TRY_AGAIN, action: "download" };
      case "refused":
        return { title: "The download didn’t match the release", detail: undefined, actionLabel: TRY_AGAIN, action: "download" };
      case "unchecked":
        return { title: "Couldn’t check the download", detail: undefined, actionLabel: TRY_AGAIN, action: "install" };
      case "unprepared":
        return { title: "Couldn’t prepare the update", detail: undefined, actionLabel: TRY_AGAIN, action: "install" };
      case "install_failed":
        return { title: "Couldn’t install the update", detail: undefined, actionLabel: TRY_AGAIN, action: "install" };
      case "unavailable":
        return { title: "Couldn’t start the download", detail: undefined, actionLabel: "Copy link", action: "copy" };
      default:
        return { title: `Ardia ${v} is available`, detail: undefined, actionLabel: "Download", action: "download" };
    }
  }
  if (status === "checking") return { title: "Checking for updates…", detail: undefined, actionLabel: undefined, action: "none" };
  if (status === "current") return { title: "Ardia is up to date", detail: undefined, actionLabel: "Check", action: "check" };
  if (status === "incomplete" || status === "failed") return { title: "Couldn’t check for updates", detail: undefined, actionLabel: TRY_AGAIN, action: "check" };
  return { title: "Check for updates", detail: undefined, actionLabel: undefined, action: "check" };
}

export const updateDotShown = (status: UpdateStatus, offer: OfferedRelease | null, seenVersion: string | null) => offer !== null && status !== "current" && offer.version !== seenVersion;

export type HandOffResult = { handoff: "downloading"; id: string } | { handoff: "browser" | "unavailable"; id: null };

const DOWNLOAD_ID = /^[1-9]\d{0,18}$/;

export function handOffResultOf(value: unknown): HandOffResult {
  if (isRecord(value) && value.handoff === "notifications" && typeof value.id === "string" && DOWNLOAD_ID.test(value.id)) return { handoff: "downloading", id: value.id };
  if (isRecord(value) && value.handoff === "browser") return { handoff: "browser", id: null };
  return { handoff: "unavailable", id: null };
}

export type DownloadProgress = "downloading" | "ready" | "failed" | "gone";

export function downloadProgressOf(value: unknown): DownloadProgress {
  if (value === "pending" || value === "running" || value === "paused") return "downloading";
  if (value === "successful") return "ready";
  if (value === "failed") return "failed";
  return "gone";
}

export type InstallOutcome = "installing" | "needs_permission" | "gone" | "refused" | "failed";

export function installOutcomeOf(value: unknown): InstallOutcome {
  const result = isRecord(value) ? value.result : value;
  if (result === "committed") return "installing";
  if (result === "needs_permission" || result === "gone" || result === "refused") return result;
  if (result === "mismatch") return "refused";
  return "failed";
}

const SESSION_ID = /^[0-9]{1,10}$/;

export const installSessionOf = (value: unknown): string | null => (isRecord(value) && value.result === "committed" && typeof value.session === "string" && SESSION_ID.test(value.session) ? value.session : null);

export type InstallStatus = { kind: "update" | "file"; status: "confirming" | "success" | "aborted" | "failure"; session: string; download: string };

export function installStatusOf(value: unknown): InstallStatus | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "update" || value.kind === "file" ? value.kind : null;
  const status = value.status === "confirming" || value.status === "success" || value.status === "aborted" || value.status === "failure" ? value.status : null;
  const session = typeof value.session === "string" && SESSION_ID.test(value.session) ? value.session : null;
  const download = typeof value.download === "string" && /^[0-9]{1,19}$/.test(value.download) ? value.download : null;
  return kind && status && session && download ? { kind, status, session, download } : null;
}

export type CommittedInstall = { version: string; session: string };

export function parseCommittedInstall(text: string | null | undefined): CommittedInstall | null {
  const body = readGitHubJson(text);
  if (!isRecord(body) || typeof body.session !== "string" || !SESSION_ID.test(body.session) || parseAndroidVersion(body.version) === null) return null;
  return { version: body.version as string, session: body.session };
}

export type VerifyOutcome = "verified" | "refused" | "gone" | "copy_failed" | "failed";

export function verifyOutcomeOf(value: unknown): VerifyOutcome {
  if (value === "verified" || value === "gone" || value === "copy_failed") return value;
  if (value === "mismatch") return "refused";
  return "failed";
}

export type UpdateDownloadRecord = { version: string; id: string; offer: OfferedRelease };

export function parseDownloadRecord(text: string | null | undefined): UpdateDownloadRecord | null {
  const body = readGitHubJson(text);
  if (!isRecord(body) || typeof body.id !== "string" || !DOWNLOAD_ID.test(body.id) || !isRecord(body.offer)) return null;
  const request = updateDownloadRequest(body.offer);
  if (!request) return null;
  const offer: OfferedRelease = { version: request.version.text, downloadUrl: request.url, checksumUrl: request.checksumUrl, sha256: request.sha256 };
  return { version: offer.version, id: body.id, offer };
}

export const downloadRecordText = (offer: OfferedRelease, id: string) => JSON.stringify({ id, offer: { version: offer.version, downloadUrl: offer.downloadUrl, checksumUrl: offer.checksumUrl, sha256: offer.sha256 } });

export const downloadOutlivedBy = (record: UpdateDownloadRecord, installed: ReleaseVersion) => {
  const version = parseAndroidVersion(record.version);
  return version === null || compareReleaseVersions(version, installed) <= 0;
};
