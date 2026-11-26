import { create } from "zustand";
import type { RegistryIndexEntry } from "@ardia/plugin-sdk/registry";
import { installPluginArchive, installPluginFolder } from "../../platform/plugins";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { isPluginId, keyOfId, splitPluginId } from "../../lib/pluginIds";
import { consentToken } from "../telemetry/consentPeriod";
import { notePlugin } from "../telemetry/pluginCounts";
import { wantCandidate } from "./candidates";
import { installPlugin, OFFLINE_REGISTRY } from "./installer";
import type { InstallResult } from "./installWaiters";
import { requestPluginConsent, rescanPlugins, updateRecord } from "./lifecycle";
import { currentLock, mutateLock, stageLockEntries, type Channel } from "./lockfile";
import { customRegistries, defaultRegistry, fetchIndex, registryForId, type RegistryRef } from "./registryClient";
import { revocationPreflight, revocationReason, stoppingRevocation } from "./revocations";
import { dropCandidate } from "./candidates";
import { registryUrl } from "./registryKeys";
import { parseKeyList } from "./registryKeys";
import { pluginsExtras, writePluginsExtras } from "./savedState";
import { currentPlugins, recordOf } from "./store";
import { openSettings } from "../settings/settingsWindows";

export type CatalogEntry = RegistryIndexEntry & { registry: string; isDefault: boolean };

type CatalogState = { state: "idle" | "loading" | "ready" | "offline"; entries: CatalogEntry[]; reason: string | null; at: number };

export const useCatalog = create<CatalogState>()(() => ({ state: "idle", entries: [], reason: null, at: 0 }));

const STALE_MS = 10 * 60 * 1000;

let loading: Promise<void> | null = null;

export const routesHere = (ref: RegistryRef, id: string) => !!splitPluginId(id) && registryForId(id).url === ref.url && (ref.isDefault || !id.startsWith("@ardia/"));

async function indexOf(ref: RegistryRef): Promise<{ entries: CatalogEntry[]; reason: string | null }> {
  const got = await fetchIndex(ref);
  if (!got.ok) return { entries: [], reason: got.reason };
  return { entries: got.value.plugins.filter((p) => routesHere(ref, p.id)).map((p) => ({ ...p, registry: ref.url, isDefault: ref.isDefault })), reason: null };
}

export function refreshCatalog(force = false): Promise<void> {
  if (!PLATFORM_FEATURES.plugins) return Promise.resolve();
  const now = useCatalog.getState();
  if (!force && now.state === "ready" && Date.now() - now.at < STALE_MS) return Promise.resolve();
  const consent = consentToken();
  loading ??= (async () => {
    useCatalog.setState({ state: now.entries.length ? now.state : "loading" });
    notePlugin("catalog_loads", consent);
    const results = await Promise.all([defaultRegistry(), ...customRegistries()].map(indexOf));
    const seen = new Set<string>();
    const entries = results.flatMap((r) => r.entries).filter((e) => !seen.has(e.id) && seen.add(e.id));
    const reason = results[0]?.reason ?? null;
    if (!entries.length && reason) {
      notePlugin("catalog_offline", consent);
      useCatalog.setState({ state: "offline", reason, at: Date.now() });
    } else useCatalog.setState({ state: "ready", entries, reason: null, at: Date.now() });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const CATEGORIES_ALL = "all";

export function filterCatalog(entries: readonly CatalogEntry[], query: string, category: string): CatalogEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((e) => category === CATEGORIES_ALL || e.categories.includes(category))
    .filter((e) => words.every((w) => [e.id, e.name, e.description, ...e.keywords, ...e.categories].some((field) => field.toLowerCase().includes(w))))
    .sort((a, b) => Number(b.official) - Number(a.official) || b.installs - a.installs || a.name.localeCompare(b.name));
}

export const catalogCategories = (entries: readonly CatalogEntry[]): string[] => [...new Set(entries.flatMap((e) => e.categories))].sort();

export type CatalogInstallState = "get" | "installed" | "update" | "installing";

export function installStateOf(id: string): CatalogInstallState {
  const key = keyOfId(id);
  if (!key) return "get";
  const s = currentPlugins();
  if (s.fetches[key]?.state === "fetching") return "installing";
  if (recordOf(s, key).pendingUpdate) return "update";
  return s.listings[key]?.manifest && recordOf(s, key).enabled ? "installed" : "get";
}

export function getPlugin(id: string, channel: Channel = "latest"): Promise<InstallResult> {
  const consent = consentToken();
  notePlugin("catalog_gets", consent);
  return installPlugin({ id, channel }, { showSheet: false });
}

export async function setPluginChannel(key: string, channel: Channel): Promise<boolean> {
  const consent = consentToken();
  let found = false;
  const saved = await mutateLock((now) => {
    const entry = Object.values(now.lock).find((e) => e.key === key);
    if (!entry) return null;
    found = true;
    return { lock: { ...now.lock, [entry.id]: { ...entry, channel } }, staged: now.staged };
  }, consent);
  if (!found) return false;
  notePlugin(channel === "beta" ? "channel_beta" : "channel_latest", consent);
  return saved;
}

export function setPluginProfiles(key: string, profiles: "all" | string[]): boolean {
  return updateRecord(key, (r) => ({ ...r, profiles: profiles === "all" ? "all" : [...new Set(profiles)] }), consentToken());
}

export function addRegistry(url: string, scopes: string, keys: string): { ok: true } | { ok: false; reason: string } {
  const clean = registryUrl(url);
  if (!clean) return { ok: false, reason: "A registry is an https:// address, like https://plugins.acme.example/r" };
  const scopeList = scopes.split(/[\s,]+/).map((s) => s.replace(/\/\*$/, "")).filter(Boolean);
  if (!scopeList.length) return { ok: false, reason: "Name the scopes it serves, like @acme, so Ardia knows which plugins to get from it" };
  if (scopeList.some((s) => !/^@[a-z0-9][a-z0-9-]{0,38}$/.test(s))) return { ok: false, reason: "Scopes look like @acme or @acme/*" };
  if (scopeList.includes("@ardia")) return { ok: false, reason: "@ardia plugins come only from Ardia's registry" };
  const parsed = parseKeyList(keys);
  if (!Object.keys(parsed).length) return { ok: false, reason: "Paste the registry's Ed25519 public key, so Ardia can check what it signs" };
  const extras = pluginsExtras();
  if (extras.registries.some((r) => r.url === clean)) return { ok: false, reason: "That registry is already added" };
  const next = { ...extras, registries: [...extras.registries, { url: clean, scopes: scopeList, keys: parsed }] };
  if (!writePluginsExtras(next, currentPlugins().records, consentToken())) return { ok: false, reason: "Ardia couldn't save its plugin settings. Try again." };
  notePlugin("registries_added");
  void refreshCatalog(true);
  return { ok: true };
}

export function removeRegistry(url: string): boolean {
  const extras = pluginsExtras();
  const next = { ...extras, registries: extras.registries.filter((r) => r.url !== url) };
  const saved = writePluginsExtras(next, currentPlugins().records, consentToken());
  if (saved) void refreshCatalog(true);
  return saved;
}

export async function installFromFile(path: string): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  const consent = consentToken();
  const archive = /\.(?:tar\.gz|tgz)$/i.test(path);
  notePlugin(archive ? "file_installs_archive" : "file_installs_folder", consent);
  const preflight = await revocationPreflight();
  if (!preflight.ok) return { ok: false, reason: preflight.reason };
  const result = await (archive ? installPluginArchive(path) : installPluginFolder(path)).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) return result;
  if (result.candidate) wantCandidate(result.name, result.candidate.folderId);
  await rescanPlugins(consent);
  const listed = currentPlugins().candidates[result.name] ?? currentPlugins().listings[result.name];
  const version = listed?.manifest?.version ?? result.candidate?.version ?? null;
  const revoked = isPluginId(result.id) && version ? stoppingRevocation({ id: result.id, version, sha256: result.sha256 ?? null, source: { kind: "file" } }, true) : null;
  if (revoked) {
    notePlugin("file_installs_revoked", consent);
    if (result.candidate) dropCandidate(result.name);
    await rescanPlugins(consent);
    return { ok: false, reason: `${result.id} ${version} was turned off by Ardia's registry: ${revocationReason(revoked)}` };
  }
  const entry = archive && isPluginId(result.id) && result.candidate ? { id: result.id, key: result.name, version, channel: "latest" as const, source: { kind: "file" as const }, sha256: result.sha256 ?? null, payloadDigest: null, dependencies: Object.keys(listed?.manifest?.v3?.dependencies ?? {}).sort(), root: true, official: false, installedAt: Date.now() } : null;
  if (entry && result.candidate && !(await stageLockEntries([{ folderId: result.candidate.folderId, entry }], consent))) {
    dropCandidate(result.name);
    await rescanPlugins(consent);
    return { ok: false, reason: "Ardia couldn't save the archive's details to plugins-lock.json, so it wasn't installed. Try again." };
  }
  if (!requestPluginConsent(result.name)) return { ok: false, reason: currentPlugins().candidates[result.name]?.problems[0] ?? currentPlugins().listings[result.name]?.problems[0] ?? "It can't load." };
  openSettings("plugins", null, result.name);
  return { ok: true, name: result.name };
}

export function installFromDeepLink(id: string): boolean {
  if (!isPluginId(id) || !PLATFORM_FEATURES.plugins) return false;
  notePlugin("deep_link_installs");
  openSettings("plugins", null, `get:${id}`);
  return true;
}

export const registryOffline = (reason: string | null) => !!reason && reason.startsWith(OFFLINE_REGISTRY);
