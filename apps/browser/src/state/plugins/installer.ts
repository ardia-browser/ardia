import { cancelPluginArtifactFetch, fetchPluginArtifact, onPluginArtifactProgress, removePluginFiles, type PluginArtifactResult } from "../../platform/plugins";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { openSettings } from "../settings/settingsWindows";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { notePlugin, artifactFetchCause } from "../telemetry/pluginCounts";
import { warnFor } from "../telemetry/consoleConsent";
import { dropCandidate, wantCandidate } from "./candidates";
import { releaseOrphanedConsent } from "./consentSurface";
import { waitForInstall, type InstallResult } from "./installWaiters";
import { isNativeTier, verifyOfficialArtifact } from "@ardia/plugin-sdk/registry";
import { pluginSubtle } from "../../platform/pluginCrypto";
import { newInPlan, planInstall, runningPlatform, storeFolderOf, type InstallPlan, type PlannedPlugin, type PlanRequest } from "./installPlan";
import { ALREADY_ASKING, approvePlugin, requestPluginConsent, rescanPlugins, settledPromotions } from "./lifecycle";
import { currentLock, dropStagedLock, stageLockEntries, updateLock, type LockEntry } from "./lockfile";
import { revocationPreflight } from "./revocations";
import { activeManifest, currentPlugins, recordOf, setPluginFetch, usePlugins } from "./store";
import { githubDetail } from "./githubSource";
import { registryFetcher } from "./registryClient";
import { officialNativeKeys } from "./registryKeys";
import { isOfficialId, isPluginId } from "../../lib/pluginIds";

export const FETCH_REASONS: Record<Exclude<PluginArtifactResult, { ok: true }>["code"], string> = {
  offline: "Couldn't download it. Check your internet connection, then try again.",
  failed: "Couldn't download it. Try again.",
  verify: "The download didn't match the copy the registry signed, so it wasn't installed.",
  cancelled: "Cancelled.",
  unsupported: "Not available in this version of Ardia.",
};

export const OFFLINE_REGISTRY = "Couldn't reach the plugin registry";

export type InstallOptions = { showSheet?: boolean; silent?: boolean; onConsent?: (id: number) => void; alive?: () => boolean };

let progressWatched = false;

function watchProgress() {
  if (progressWatched) return;
  progressWatched = true;
  try {
    onPluginArtifactProgress((e) => {
      if (currentPlugins().fetches[e.name]?.state === "fetching") setPluginFetch(e.name, { state: "fetching", received: e.received, total: e.total });
    });
  } catch {
    progressWatched = false;
  }
}

export type Downloaded = { plugin: PlannedPlugin; folderId: string; payloadDigest: string; official: boolean };

export function artifactSpecOf(plugin: PlannedPlugin) {
  const signed = isOfficialId(plugin.id) && plugin.artifact.officialSig ? { officialSig: plugin.artifact.officialSig, platform: plugin.artifact.platform } : {};
  return { name: plugin.key, id: plugin.id, version: plugin.version, url: plugin.artifact.url, sha256: plugin.artifact.sha256, sizeBytes: plugin.artifact.sizeBytes, ...signed };
}

export function identityProblem(plugin: PlannedPlugin, candidate: { folderId: string; version: string }): string | null {
  if (candidate.folderId !== storeFolderOf(plugin.artifact.sha256)) return `${plugin.id}: the download Ardia got back isn't the one the registry signed`;
  return candidate.version === plugin.version ? null : `${plugin.id}: the download is version ${candidate.version}, not ${plugin.version}`;
}

export async function downloadPlan(plugins: readonly PlannedPlugin[], consent: ConsentToken | null, quiet = false): Promise<{ ok: true; downloaded: Downloaded[] } | { ok: false; reason: string; cancelled?: true }> {
  watchProgress();
  const downloaded: Downloaded[] = [];
  for (const plugin of plugins) {
    if (!quiet) setPluginFetch(plugin.key, { state: "fetching", received: 0, total: plugin.artifact.sizeBytes });
    notePlugin("registry_downloads", consent);
    const result = await fetchPluginArtifact(artifactSpecOf(plugin)).catch(
      (error: unknown): PluginArtifactResult => ({ ok: false, code: "failed", reason: String(error) }),
    );
    if (!quiet) setPluginFetch(plugin.key, null);
    if (!result.ok) {
      notePlugin(result.code === "offline" ? "registry_download_offline" : result.code === "verify" ? "registry_verify_failures" : "registry_download_failures", consent);
      if (result.code !== "cancelled") notePlugin(artifactFetchCause(result.cause), consent);
      warnFor(consent, `[plugins] ${plugin.id} wasn't downloaded (${result.code}): ${result.reason}`);
      return result.code === "cancelled" ? { ok: false, reason: FETCH_REASONS.cancelled, cancelled: true } : { ok: false, reason: `${plugin.id}: ${FETCH_REASONS[result.code]}` };
    }
    const mismatch = identityProblem(plugin, result.candidate);
    if (mismatch) {
      notePlugin("registry_verify_failures", consent);
      return { ok: false, reason: mismatch };
    }
    downloaded.push({ plugin, folderId: result.candidate.folderId, payloadDigest: result.candidate.payloadDigest, official: result.official === true });
  }
  return { ok: true, downloaded };
}

export const cancelInstall = (key: string) => cancelPluginArtifactFetch(key);

export function lockEntriesFor(plan: InstallPlan, downloaded: readonly Downloaded[], requested: PlanRequest): Record<string, LockEntry> {
  const lock = currentLock();
  const byId = new Map(downloaded.map((d) => [d.plugin.id, d]));
  return Object.fromEntries(
    plan.plugins.map((p) => {
      const was = lock[p.id];
      const got = byId.get(p.id);
      const signed = p.official && p.artifact.officialSig ? { officialSig: p.artifact.officialSig } : {};
      const entry: LockEntry = {
        id: p.id,
        key: p.key,
        version: p.version,
        channel: p.id === plan.root ? (requested.channel ?? was?.channel ?? "latest") : (was?.channel ?? "latest"),
        source: p.source,
        sha256: p.artifact.sha256,
        payloadDigest: got?.payloadDigest ?? was?.payloadDigest ?? null,
        dependencies: p.dependencies,
        repo: p.repo,
        platform: p.artifact.platform,
        ...signed,
        root: p.id === plan.root || (was?.root ?? false),
        official: p.official,
        installedAt: got ? Date.now() : (was?.installedAt ?? Date.now()),
        ...(was?.previous ? { previous: was.previous } : {}),
      };
      return [p.id, entry];
    }),
  );
}

export function stagePlanLock(plan: InstallPlan, downloaded: readonly Downloaded[], requested: PlanRequest, consent: ConsentToken | null): Promise<boolean> {
  const entries = lockEntriesFor(plan, downloaded, requested);
  return stageLockEntries(downloaded.map((d) => ({ folderId: d.folderId, entry: entries[d.plugin.id]! })), consent);
}

export async function recordUnchangedInLock(plan: InstallPlan, downloaded: readonly Downloaded[], requested: PlanRequest, consent: ConsentToken | null) {
  const fetched = new Set(downloaded.map((d) => d.plugin.id));
  const entries = Object.entries(lockEntriesFor(plan, downloaded, requested)).filter(([id]) => !fetched.has(id));
  return !entries.length || updateLock((now) => ({ ...now, ...Object.fromEntries(entries) }), consent);
}

export async function officialDownloadProblem(d: Downloaded): Promise<string | null> {
  const manifest = currentPlugins().candidates[d.plugin.key]?.manifest?.v3;
  if (!isOfficialId(d.plugin.id) || !manifest || !isNativeTier(manifest)) return null;
  const refused = `${d.plugin.id} ${d.plugin.version} reaches outside the sandbox but isn't signed by Ardia's release key`;
  if (!d.official) return refused;
  const verified = await verifyOfficialArtifact(
    { id: d.plugin.id, version: d.plugin.version, platform: d.plugin.artifact.platform, sha256: d.plugin.artifact.sha256 },
    d.plugin.artifact.officialSig,
    officialNativeKeys(),
    { subtle: pluginSubtle() },
  );
  return verified.ok ? null : `${refused}: ${verified.reason}`;
}

async function dropDownloads(downloaded: readonly Downloaded[]) {
  await Promise.all(
    downloaded.map(async (d) => {
      dropCandidate(d.plugin.key);
      await dropStagedLock(d.plugin.key);
      await removePluginFiles(d.plugin.key, "store", d.folderId).catch(() => undefined);
    }),
  );
}

function candidateHash(key: string, folderId: string): string | null {
  const candidate = currentPlugins().candidates[key];
  return candidate?.folderId === folderId && candidate.manifest ? candidate.hash : null;
}

function listingProblem(key: string, folderId: string): string | null {
  const candidate = currentPlugins().candidates[key];
  if (candidate?.folderId !== folderId) return "It changed while it was installing. Try again.";
  return candidate.manifest ? null : (candidate.problems[0] ?? "It can't load.");
}

export async function prepareInstall(request: PlanRequest, consent: ConsentToken | null, quiet = false): Promise<{ ok: true; plan: InstallPlan; downloaded: Downloaded[] } | { ok: false; reason: string; cancelled?: true }> {
  const preflight = await revocationPreflight();
  if (!preflight.ok) {
    notePlugin("registry_offline", consent);
    return { ok: false, reason: `${OFFLINE_REGISTRY}. ${preflight.reason}` };
  }
  const planned = await planInstall(request);
  if (!planned.ok) {
    notePlugin(planned.code === "offline" ? "registry_offline" : planned.code === "verify" || planned.code === "official" ? "registry_verify_failures" : "registry_install_refusals", consent);
    return { ok: false, reason: planned.code === "offline" || planned.code === "keys" ? `${OFFLINE_REGISTRY}. ${planned.reason}` : planned.reason };
  }
  if (!(await rescanPlugins(consent))) return { ok: false, reason: "Ardia couldn't read its plugin store to see what's already there, so nothing was installed. Try again." };
  const fetching = newInPlan(planned.plan);
  const got = await downloadPlan(fetching, consent, quiet);
  if (!got.ok) return got;
  for (const d of got.downloaded) wantCandidate(d.plugin.key, d.folderId);
  if (!(await rescanPlugins(consent))) {
    await dropDownloads(got.downloaded);
    return { ok: false, reason: "Ardia couldn't read its plugin store after the download, so nothing was installed. Try again." };
  }
  for (const d of got.downloaded) {
    const problem = listingProblem(d.plugin.key, d.folderId);
    const unsigned = problem ? null : await officialDownloadProblem(d);
    if (problem || unsigned) {
      if (unsigned) notePlugin("registry_verify_failures", consent);
      await dropDownloads(got.downloaded);
      await rescanPlugins(consent);
      return { ok: false, reason: unsigned ?? `${d.plugin.id}: ${problem}` };
    }
  }
  if (!(await stagePlanLock(planned.plan, got.downloaded, request, consent))) {
    await dropDownloads(got.downloaded);
    await rescanPlugins(consent);
    return { ok: false, reason: "Ardia couldn't save what it downloaded to plugins-lock.json, so it wasn't installed. Try again." };
  }
  return { ok: true, plan: planned.plan, downloaded: got.downloaded };
}

async function withGithubId(request: PlanRequest): Promise<{ ok: true; request: PlanRequest } | { ok: false; reason: string }> {
  if (request.source?.kind !== "github" || isPluginId(request.id)) return { ok: true, request };
  const got = await githubDetail(registryFetcher(), request.source.repo, runningPlatform());
  return got.ok ? { ok: true, request: { ...request, id: got.detail.id } } : got;
}

export async function installPlugin(given: PlanRequest, options: InstallOptions = {}): Promise<InstallResult> {
  if (!PLATFORM_FEATURES.plugins) return { ok: false, reason: `Not available on ${PLATFORM_TERMS.os} yet.` };
  const consent = consentToken();
  const named = await withGithubId(given);
  if (!named.ok) return named;
  const request = named.request;
  releaseOrphanedConsent();
  if (currentPlugins().consent && !options.silent) return { ok: false, reason: ALREADY_ASKING };
  notePlugin("registry_install_starts", consent);
  const prepared = await prepareInstall(request, consent);
  if (!prepared.ok) return prepared;
  if (options.alive && !options.alive()) return { ok: false, reason: "Cancelled.", cancelled: true };
  const rootPlugin = prepared.plan.plugins.find((p) => p.id === request.id)!;
  const fresh = prepared.downloaded.map((d) => ({ name: d.plugin.key, hash: candidateHash(d.plugin.key, d.folderId) }));
  const waiting = fresh.filter((f): f is { name: string; hash: string } => !!f.hash);
  const root = waiting.find((w) => w.name === rootPlugin.key) ?? (activeManifest(currentPlugins(), rootPlugin.key) ? null : { name: rootPlugin.key, hash: currentPlugins().listings[rootPlugin.key]?.hash ?? "" });
  const bundle = waiting.filter((w) => w.name !== rootPlugin.key);
  const finish = async (approved: readonly { name: string }[]): Promise<InstallResult> => {
    const promoted = await settledPromotions(approved.map((w) => w.name));
    if (!promoted.ok) return promoted;
    if (!recordUnchangedInLock(prepared.plan, prepared.downloaded, request, consent)) return { ok: false, reason: "Ardia couldn't save its plugin settings. Try again." };
    notePlugin("registry_installs", consent);
    return { ok: true };
  };
  if (!root || !root.hash) {
    if (!bundle.every((b) => approvePlugin(b.name, b.hash, consent))) return { ok: false, reason: "Ardia couldn't save its plugin settings. Try again." };
    return finish(bundle);
  }
  if (options.silent || recordOf(currentPlugins(), root.name).preapproved) {
    const approved = [...bundle, root].every((w) => approvePlugin(w.name, w.hash, consent));
    if (!approved) return { ok: false, reason: "Ardia couldn't save its plugin settings. Try again." };
    return finish([...bundle, root]);
  }
  releaseOrphanedConsent();
  if (currentPlugins().consent) return { ok: false, reason: ALREADY_ASKING };
  if (!requestPluginConsent(root.name, { bundle })) return { ok: false, reason: "Can't install it right now." };
  options.onConsent?.(currentPlugins().consent!.id);
  const done = waitForInstall(root.name);
  if (options.showSheet !== false) openSettings("plugins", null, root.name);
  const result = await done;
  if (!result.ok) {
    await dropDownloads(prepared.downloaded);
    return result;
  }
  if (!recordUnchangedInLock(prepared.plan, prepared.downloaded, request, consent)) return { ok: false, reason: "Ardia couldn't save its plugin settings. Try again." };
  notePlugin("registry_installs", consent);
  return result;
}

export const isInstalling = (key: string) => currentPlugins().fetches[key]?.state === "fetching";

export const useInstallFetch = (key: string) => usePlugins((s) => s.fetches[key] ?? null);
