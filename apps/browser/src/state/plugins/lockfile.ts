import { create } from "zustand";
import { isSemver } from "@ardia/plugin-sdk/semver";
import { documentSaved, readDocument, syncDocument, writeDocument } from "../../platform/documents";
import { isFields } from "../../lib/decode";
import { isPluginId, keyOfId } from "../../lib/pluginIds";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { warnFor } from "../telemetry/consoleConsent";
import type { ConsentToken } from "../telemetry/choice";

export const LOCK_DOC = "Plugins/plugins-lock.json";
const VERSION = 1;
const SHA = /^[0-9a-f]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const PLATFORM = /^(?:universal|macos-arm64|macos-x64|linux-x64|linux-arm64|windows-x64)$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_ENTRIES = 256;

export type Channel = "latest" | "beta";

export type LockSource = { kind: "registry"; url: string } | { kind: "github"; repo: string } | { kind: "file" };

export type LockProvenance = {
  version: string | null;
  source: LockSource;
  sha256: string | null;
  payloadDigest: string | null;
  dependencies: string[];
  repo?: string;
  officialSig?: string;
  platform?: string;
};

export type LockEntry = LockProvenance & {
  id: string;
  key: string;
  channel: Channel;
  root: boolean;
  official: boolean;
  installedAt: number;
  pending?: "migration";
  previous?: LockProvenance;
};

export type PluginLock = Record<string, LockEntry>;

function sourceOf(raw: unknown): LockSource | null {
  if (!isFields(raw)) return null;
  if (raw.kind === "registry" && typeof raw.url === "string" && /^https?:\/\/\S{1,2000}$/.test(raw.url)) return { kind: "registry", url: raw.url };
  if (raw.kind === "github" && typeof raw.repo === "string" && REPO.test(raw.repo)) return { kind: "github", repo: raw.repo };
  if (raw.kind === "file") return { kind: "file" };
  return null;
}

function provenanceOf(raw: Record<string, unknown>, source: LockSource): LockProvenance {
  const dependencies = Array.isArray(raw.dependencies) ? raw.dependencies.filter(isPluginId) : [];
  return {
    version: typeof raw.version === "string" && isSemver(raw.version) ? raw.version : null,
    source,
    sha256: typeof raw.sha256 === "string" && SHA.test(raw.sha256) ? raw.sha256 : null,
    payloadDigest: typeof raw.payloadDigest === "string" && SHA.test(raw.payloadDigest) ? raw.payloadDigest : null,
    dependencies: [...new Set(dependencies)].sort(),
    ...(typeof raw.repo === "string" && REPO.test(raw.repo) ? { repo: raw.repo } : {}),
    ...(typeof raw.officialSig === "string" && SIG.test(raw.officialSig) ? { officialSig: raw.officialSig } : {}),
    ...(typeof raw.platform === "string" && PLATFORM.test(raw.platform) ? { platform: raw.platform } : {}),
  };
}

function entryOf(id: string, raw: unknown): LockEntry | null {
  const key = isPluginId(id) ? keyOfId(id) : null;
  const source = isFields(raw) ? sourceOf(raw.source) : null;
  if (!key || !isFields(raw) || !source) return null;
  const earlierSource = isFields(raw.previous) ? sourceOf(raw.previous.source) : null;
  return {
    id,
    key,
    ...provenanceOf(raw, source),
    channel: raw.channel === "beta" ? "beta" : "latest",
    root: raw.root !== false,
    official: raw.official === true,
    installedAt: typeof raw.installedAt === "number" && Number.isFinite(raw.installedAt) ? raw.installedAt : 0,
    ...(raw.pending === "migration" ? { pending: "migration" as const } : {}),
    ...(isFields(raw.previous) && earlierSource ? { previous: provenanceOf(raw.previous, earlierSource) } : {}),
  };
}

export function parseLock(json: string | null): PluginLock {
  const doc = parseSaved(json, VERSION);
  if (!doc || !isFields(doc.plugins)) return {};
  const out: PluginLock = {};
  for (const [id, raw] of Object.entries(doc.plugins).slice(0, MAX_ENTRIES)) {
    const entry = entryOf(id, raw);
    if (entry) out[id] = entry;
  }
  return out;
}

export type StagedLock = Record<string, { folderId: string; entry: LockEntry }>;

const STORE_FOLDER = /^store-[0-9a-f]{64}$/;
const MAX_STAGED = 64;

export function parseStaged(json: string | null): StagedLock {
  const doc = parseSaved(json, VERSION);
  if (!doc || !isFields(doc.staged)) return {};
  const out: StagedLock = {};
  for (const [key, raw] of Object.entries(doc.staged).slice(0, MAX_STAGED)) {
    if (!isFields(raw) || typeof raw.folderId !== "string" || !STORE_FOLDER.test(raw.folderId) || !isFields(raw.entry) || typeof raw.entry.id !== "string") continue;
    const entry = entryOf(raw.entry.id, raw.entry);
    if (entry && entry.key === key && entry.sha256 === raw.folderId.slice(6)) out[key] = { folderId: raw.folderId, entry };
  }
  return out;
}

export function provenance(entry: LockProvenance): LockProvenance {
  return {
    version: entry.version,
    source: entry.source,
    sha256: entry.sha256,
    payloadDigest: entry.payloadDigest,
    dependencies: [...entry.dependencies],
    ...(entry.repo ? { repo: entry.repo } : {}),
    ...(entry.officialSig ? { officialSig: entry.officialSig } : {}),
    ...(entry.platform ? { platform: entry.platform } : {}),
  };
}

export function withProvenance(entry: LockEntry, given: LockProvenance): LockEntry {
  const { repo: _repo, officialSig: _sig, platform: _platform, ...rest } = entry;
  return { ...rest, ...provenance(given) };
}

export const lockJson = (lock: PluginLock, stagedEntries: StagedLock = {}) => versionedJson(Object.keys(stagedEntries).length ? { plugins: lock, staged: stagedEntries } : { plugins: lock }, VERSION);

type LockState = { lock: PluginLock; staged: StagedLock };

let committed: LockState | null = null;
let lastWrite: Promise<unknown> = Promise.resolve();

export const useLock = create<{ lock: PluginLock }>()(() => ({ lock: {} }));

function state(): LockState {
  if (committed) return committed;
  try {
    const text = readDocument(LOCK_DOC);
    committed = { lock: parseLock(text), staged: parseStaged(text) };
  } catch {
    committed = { lock: {}, staged: {} };
  }
  useLock.setState({ lock: committed.lock });
  return committed;
}

export const currentLock = (): PluginLock => state().lock;

const currentStaged = (): StagedLock => state().staged;

export function mutateLock(change: (now: LockState) => LockState | null, consent: ConsentToken | null): Promise<boolean> {
  const run = lastWrite.then(async () => {
    const base = state();
    const next = change(base);
    if (!next) return true;
    try {
      writeDocument(LOCK_DOC, lockJson(next.lock, next.staged));
    } catch (error) {
      warnFor(consent, "[plugins] couldn't save plugins-lock.json", error);
      return false;
    }
    const landed = await documentSaved(LOCK_DOC)
      .then(() => syncDocument(LOCK_DOC))
      .then(
        () => true,
        () => false,
      );
    if (landed) {
      committed = next;
      useLock.setState({ lock: next.lock });
      return true;
    }
    warnFor(consent, "[plugins] plugins-lock.json didn't reach the disk; Ardia put back what it held before");
    try {
      writeDocument(LOCK_DOC, lockJson(base.lock, base.staged));
    } catch {}
    return false;
  });
  lastWrite = run.catch(() => false);
  return run;
}

export const writeLock = (next: PluginLock, consent: ConsentToken | null): Promise<boolean> => mutateLock((now) => ({ lock: next, staged: now.staged }), consent);

export const updateLock = (change: (now: PluginLock) => PluginLock, consent: ConsentToken | null): Promise<boolean> => mutateLock((now) => ({ lock: change({ ...now.lock }), staged: now.staged }), consent);

export function stageLockEntries(given: readonly { folderId: string; entry: LockEntry }[], consent: ConsentToken | null = null): Promise<boolean> {
  if (!given.length) return Promise.resolve(true);
  return mutateLock((now) => {
    const next = { ...now.staged };
    for (const { folderId, entry } of given) next[entry.key] = { folderId, entry };
    return { lock: now.lock, staged: next };
  }, consent);
}

export const lockEntryByKey = (key: string, given: PluginLock = currentLock()): LockEntry | undefined => Object.values(given).find((entry) => entry.key === key);

export function dependents(id: string, given: PluginLock = currentLock()): string[] {
  return Object.values(given)
    .filter((entry) => entry.dependencies.includes(id))
    .map((entry) => entry.id)
    .sort();
}

export function orphanedBy(removed: string, given: PluginLock = currentLock()): string[] {
  const rest: PluginLock = { ...given };
  delete rest[removed];
  const needed = new Set<string>();
  const walk = (id: string) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const dep of rest[id]?.dependencies ?? []) walk(dep);
  };
  for (const entry of Object.values(rest)) if (entry.root) walk(entry.id);
  return Object.keys(rest).filter((id) => !needed.has(id)).sort();
}

export const stagedLockEntry = (key: string, folderId: string): LockEntry | null => {
  const found = currentStaged()[key];
  return found?.folderId === folderId ? found.entry : null;
};

const withoutStaged = (staged: StagedLock, key: string): StagedLock => Object.fromEntries(Object.entries(staged).filter(([k]) => k !== key));

export function dropStagedLock(key: string, consent: ConsentToken | null = null): Promise<boolean> {
  return mutateLock((now) => (now.staged[key] ? { lock: now.lock, staged: withoutStaged(now.staged, key) } : null), consent);
}

export function commitStagedLock(key: string, next: LockEntry, consent: ConsentToken | null): Promise<boolean> {
  return mutateLock((now) => {
    const kept = Object.fromEntries(Object.entries(now.lock).filter(([id, entry]) => entry.key !== key || id === next.id));
    return { lock: { ...kept, [next.id]: next }, staged: withoutStaged(now.staged, key) };
  }, consent);
}

export function forgetLockKey(key: string, consent: ConsentToken | null): Promise<boolean> {
  return mutateLock((now) => {
    if (!now.staged[key] && !Object.values(now.lock).some((entry) => entry.key === key)) return null;
    return { lock: Object.fromEntries(Object.entries(now.lock).filter(([, entry]) => entry.key !== key)), staged: withoutStaged(now.staged, key) };
  }, consent);
}

export function resetLockForTests() {
  committed = null;
  lastWrite = Promise.resolve();
  useLock.setState({ lock: {} });
}
