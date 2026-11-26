import {
  currentPlatform,
  resolvePluginGraph,
  verifyOfficialArtifact,
  type RegistryPluginPayload,
  type ResolvedPlugin,
} from "@ardia/plugin-sdk/registry";
import { systemInfo } from "../../platform/app";
import { pluginSubtle } from "../../platform/pluginCrypto";
import { PLATFORM_IDS } from "../../lib/platformTerms";
import { isOfficialId, keyOfId } from "../../lib/pluginIds";
import { currentLock, type Channel, type LockSource } from "./lockfile";
import { currentPlugins } from "./store";
import { fetchDetail, registryFetcher, registryForId, type RegistryRef } from "./registryClient";
import { officialNativeKeys } from "./registryKeys";
import { currentRevocations } from "./revocations";
import { githubDetail } from "./githubSource";
import { pluginsArdiaVersion } from "./appChecks";

export const MAX_PLAN_PLUGINS = 32;

export type PlannedPlugin = ResolvedPlugin & { key: string; source: LockSource; official: boolean; tier: RegistryPluginPayload["tier"]; repo: string };

export type InstallPlan = { root: string; plugins: PlannedPlugin[]; skipped: string[] };

export type PlanResult = { ok: true; plan: InstallPlan } | { ok: false; code: "offline" | "verify" | "missing" | "keys" | "resolve" | "revoked" | "official"; reason: string };

export type PlanRequest = { id: string; channel?: Channel; source?: LockSource; range?: string };

type Found = { detail: RegistryPluginPayload; source: LockSource };

export const runningPlatform = () => currentPlatform(PLATFORM_IDS.otel, systemInfo().arch);

export const storeFolderOf = (sha256: string) => `store-${sha256}`;

const sourceUrl = (source: LockSource) => (source.kind === "registry" ? source.url : undefined);

async function detailFor(id: string, source: LockSource | undefined, root: boolean): Promise<{ ok: true; found: Found } | Exclude<PlanResult, { ok: true }>> {
  if (source?.kind === "github" && root) {
    const got = await githubDetail(registryFetcher(), source.repo, runningPlatform());
    return got.ok ? { ok: true, found: { detail: got.detail, source } } : { ok: false, code: "missing", reason: got.reason };
  }
  const ref: RegistryRef = registryForId(id);
  if (isOfficialId(id) && !ref.isDefault) return { ok: false, code: "official", reason: "@ardia plugins come only from Ardia's registry" };
  const got = await fetchDetail(ref, id);
  if (!got.ok) return { ok: false, code: got.code, reason: got.code === "missing" ? `${id} isn't in the plugin registry` : got.reason };
  return { ok: true, found: { detail: got.value, source: { kind: "registry", url: ref.url } } };
}

async function officialProblem(plugin: ResolvedPlugin, found: Found): Promise<string | null> {
  if (!isOfficialId(plugin.id)) return null;
  if (found.source.kind !== "registry" || !found.detail.official) return `${plugin.id} isn't marked official by Ardia's registry`;
  if (found.detail.tier !== "native") return null;
  const verified = await verifyOfficialArtifact(
    { id: plugin.id, version: plugin.version, platform: plugin.artifact.platform, sha256: plugin.artifact.sha256 },
    plugin.artifact.officialSig,
    officialNativeKeys(),
    { subtle: pluginSubtle() },
  );
  return verified.ok ? null : `${plugin.id} ${plugin.version} isn't signed by Ardia's release key: ${verified.reason}`;
}

export function installedRanges(): Record<string, { from: string; range: string }[]> {
  const out: Record<string, { from: string; range: string }[]> = {};
  for (const listing of Object.values(currentPlugins().listings)) {
    const v3 = listing.manifest?.v3;
    if (!v3) continue;
    for (const [dep, range] of Object.entries(v3.dependencies ?? {})) (out[dep] ??= []).push({ from: v3.id, range });
  }
  return out;
}

export async function planInstall(request: PlanRequest, keepInstalled = true): Promise<PlanResult> {
  const found = new Map<string, Found>();
  const queue: string[] = [request.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (found.has(id)) continue;
    if (found.size >= MAX_PLAN_PLUGINS) return { ok: false, code: "resolve", reason: `It pulls in more than ${MAX_PLAN_PLUGINS} plugins` };
    const got = await detailFor(id, id === request.id ? request.source : undefined, id === request.id);
    if (!got.ok) {
      if (id === request.id) return got;
      continue;
    }
    found.set(id, got.found);
    for (const version of got.found.detail.versions) for (const dep of [...Object.keys(version.dependencies), ...Object.keys(version.optionalDependencies)]) if (!found.has(dep)) queue.push(dep);
  }
  const lock = currentLock();
  const installed = Object.fromEntries(Object.values(lock).flatMap((entry) => (entry.version && entry.id !== request.id ? [[entry.id, entry.version]] : [])));
  const resolved = resolvePluginGraph({
    roots: [{ id: request.id, ...(request.range ? { range: request.range } : {}), channel: request.channel ?? lock[request.id]?.channel ?? "latest" }],
    catalog: (id) => found.get(id)?.detail,
    ardiaVersion: pluginsArdiaVersion(systemInfo().appVersion) ?? "0.0.0",
    platform: runningPlatform(),
    installed,
    keepInstalled,
    revocations: currentRevocations(),
    heldBy: installedRanges(),
    registry: (id: string) => {
      const from = found.get(id);
      return from ? sourceUrl(from.source) : undefined;
    },
  });
  if (!resolved.ok) {
    const problem = resolved.problems[0];
    return { ok: false, code: "resolve", reason: problem?.message ?? "Its dependencies couldn't be worked out" };
  }
  const plugins: PlannedPlugin[] = [];
  for (const plugin of resolved.plan) {
    const from = found.get(plugin.id)!;
    const key = keyOfId(plugin.id);
    if (!key) return { ok: false, code: "resolve", reason: `${plugin.id} isn't a plugin id` };
    const problem = await officialProblem(plugin, from);
    if (problem) return { ok: false, code: "official", reason: problem };
    plugins.push({ ...plugin, key, source: from.source, official: isOfficialId(plugin.id), tier: from.detail.tier, repo: plugin.entry.repo });
  }
  return { ok: true, plan: { root: request.id, plugins, skipped: resolved.skipped.map((s) => s.id) } };
}

export function onDisk(p: PlannedPlugin): boolean {
  const listing = currentPlugins().listings[p.key];
  return listing?.source === "store" && listing.folderId === storeFolderOf(p.artifact.sha256) && !!listing.manifest && listing.manifest.version === p.version;
}

export function newInPlan(plan: InstallPlan): PlannedPlugin[] {
  const lock = currentLock();
  return plan.plugins.filter((p) => lock[p.id]?.version !== p.version || lock[p.id]?.sha256 !== p.artifact.sha256 || !onDisk(p));
}
