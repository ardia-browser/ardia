import type { PlatformKey } from "./manifestParts";
import type { RegistryArtifact, RegistryRevocationsPayload, RegistryVersion, RevocationAction, RevocationEntry } from "./registryTypes";
import { satisfies } from "./semver";

export type RevocationTarget = {
  id: string;
  version: string;
  sha256?: string;
  githubOwner?: string;
  repo?: string;
  registry?: string;
  yanked?: boolean;
};

export type RevocationMatch = { entry: RevocationEntry | null; source: "list" | "registry"; action: RevocationAction; rollbackTo?: string };

const SEVERITY: Record<RevocationAction, number> = { block: 3, disable: 2, yank: 1 };

const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

const scopeOf = (id: string) => id.slice(0, Math.max(0, id.indexOf("/")));

export function registryKey(value: string): { host: string; origin: string | null } {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, "");
  const found = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)$/.exec(trimmed);
  if (found) return { host: found[2]!, origin: `${found[1]}://${found[2]}` };
  return { host: trimmed, origin: null };
}

export function sameRegistry(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const left = registryKey(a);
  const right = registryKey(b);
  if (left.origin && right.origin) return left.origin === right.origin;
  return left.host === right.host;
}

export function versionMatches(version: string, selectors: readonly string[]): boolean {
  return selectors.some((selector) => satisfies(version, selector, { includePrerelease: true, bareExact: true }));
}

function entryMatches(entry: RevocationEntry, target: RevocationTarget): boolean {
  const m = entry.match;
  if (m.id !== undefined && m.id !== target.id) return false;
  if (m.versions !== undefined && !versionMatches(target.version, m.versions)) return false;
  if (m.scope !== undefined && m.scope !== scopeOf(target.id)) return false;
  if (m.githubOwner !== undefined && !same(m.githubOwner, target.githubOwner ?? target.repo?.split("/")[0])) return false;
  if (m.repo !== undefined && !same(m.repo, target.repo)) return false;
  if (m.sha256 !== undefined && m.sha256 !== target.sha256?.toLowerCase()) return false;
  if (m.registry !== undefined && !sameRegistry(m.registry, target.registry)) return false;
  return true;
}

const isEntryList = (value: RegistryRevocationsPayload | readonly RevocationEntry[]): value is readonly RevocationEntry[] => Array.isArray(value);

export function matchRevocations(target: RevocationTarget, revocations: RegistryRevocationsPayload | readonly RevocationEntry[] | null | undefined): RevocationMatch[] {
  const entries: readonly RevocationEntry[] = !revocations ? [] : isEntryList(revocations) ? revocations : revocations.entries;
  const matches: RevocationMatch[] = entries
    .filter((entry) => entryMatches(entry, target))
    .map((entry) => ({ entry, source: "list" as const, action: entry.action, ...(entry.rollbackTo !== undefined ? { rollbackTo: entry.rollbackTo } : {}) }));
  if (target.yanked) matches.push({ entry: null, source: "registry", action: "yank" });
  return matches.sort((a, b) => SEVERITY[b.action] - SEVERITY[a.action]);
}

export const strongestRevocation = (matches: readonly RevocationMatch[]): RevocationAction | null => matches[0]?.action ?? null;

export function currentPlatform(os: string, arch: string): PlatformKey | null {
  const system = os === "darwin" ? "macos" : os === "win32" ? "windows" : os;
  const cpu = arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  const key = `${system}-${cpu}`;
  return (["macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "windows-x64"] as const).find((k) => k === key) ?? null;
}

export type PickedArtifact = RegistryArtifact & { platform: PlatformKey };

export function pickArtifact(version: Pick<RegistryVersion, "artifacts">, platform: PlatformKey | null): PickedArtifact | null {
  const exact = platform ? version.artifacts[platform] : undefined;
  if (exact && platform) return { ...exact, platform };
  const universal = version.artifacts.universal;
  return universal ? { ...universal, platform: "universal" } : null;
}
