import { validateManifestV3, type ManifestV3 } from "@ardia/plugin-sdk/manifest";
import { validatePluginDetail, type PlatformKey, type RegistryArtifact, type RegistryPluginPayload, type RegistryVersion } from "@ardia/plugin-sdk/registry";
import { isFields } from "../../lib/decode";
import type { RegistryFetcher } from "./registryClient";

export const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const MAX_RELEASES = 20;
const MAX_BODY = 4 << 20;
const SHA = /^[0-9a-f]{64}$/;

export type GithubResult = { ok: true; detail: RegistryPluginPayload } | { ok: false; reason: string };

type Release = { tag: string; prerelease: boolean; publishedAt: string; assets: { name: string; url: string; size: number }[] };

export function parseGithubSpec(text: string): string | null {
  const repo = text.trim().replace(/^github:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return GITHUB_REPO.test(repo) ? repo : null;
}

async function getText(fetcher: RegistryFetcher, url: string): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await fetcher(url, { Accept: url.startsWith(API) ? "application/vnd.github+json" : "*/*" }, abort.signal);
    if (response.status !== 200) return null;
    const text = await response.text();
    return text.length <= MAX_BODY ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function releasesOf(raw: unknown): Release[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_RELEASES).flatMap((entry): Release[] => {
    if (!isFields(entry) || entry.draft === true || typeof entry.tag_name !== "string" || !Array.isArray(entry.assets)) return [];
    const assets = entry.assets.flatMap((a) => (isFields(a) && typeof a.name === "string" && typeof a.browser_download_url === "string" && typeof a.size === "number" ? [{ name: a.name, url: a.browser_download_url, size: a.size }] : []));
    const publishedAt = typeof entry.published_at === "string" ? entry.published_at.replace(/\.\d+Z$/, "Z") : "1970-01-01T00:00:00Z";
    return [{ tag: entry.tag_name, prerelease: entry.prerelease === true, publishedAt, assets }];
  });
}

function json(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const fill = (template: string, version: string, name: string, platform: string) => template.replace(/\{version\}/g, version).replace(/\{name\}/g, name).replace(/\{platform\}/g, platform);

export function wantedAssets(m: Pick<ManifestV3, "id" | "version" | "release">, platform: PlatformKey | null): { platform: PlatformKey; name: string | null }[] {
  const name = m.id.slice(m.id.indexOf("/") + 1);
  const perPlatform = m.release?.assets as Partial<Record<PlatformKey, string>> | undefined;
  const wanted: { platform: PlatformKey; name: string | null }[] = [];
  if (platform && platform !== "universal" && perPlatform?.[platform]) wanted.push({ platform, name: fill(perPlatform[platform]!, m.version, name, platform) });
  if (perPlatform?.universal) wanted.push({ platform: "universal", name: fill(perPlatform.universal, m.version, name, "universal") });
  const template = m.release?.asset;
  if (template?.includes("{platform}")) {
    if (platform && platform !== "universal") wanted.push({ platform, name: fill(template, m.version, name, platform) });
  } else if (template) wanted.push({ platform: "universal", name: fill(template, m.version, name, "universal") });
  if (!perPlatform && !template) wanted.push({ platform: "universal", name: null });
  return wanted;
}

async function artifactOf(fetcher: RegistryFetcher, release: Release, assetName: string | null): Promise<RegistryArtifact | null> {
  const asset = release.assets.find((a) => (assetName ? a.name === assetName : a.name.endsWith(".tar.gz")));
  const shaAsset = asset && release.assets.find((a) => a.name === `${asset.name}.sha256`);
  const shaText = shaAsset ? await getText(fetcher, shaAsset.url) : null;
  const sha256 = shaText?.trim().split(/\s+/)[0]?.toLowerCase();
  return asset && sha256 && SHA.test(sha256) ? { url: asset.url, sha256, sizeBytes: Math.max(1, asset.size) } : null;
}

async function versionOf(fetcher: RegistryFetcher, repo: string, release: Release, platform: PlatformKey | null): Promise<{ version: RegistryVersion; manifest: ManifestV3 } | null> {
  const text = await getText(fetcher, `${RAW}/${repo}/${encodeURIComponent(release.tag)}/plugin.json`);
  const checked = text ? validateManifestV3(json(text)) : null;
  if (!checked?.ok) return null;
  const m = checked.manifest;
  const artifacts: Partial<Record<PlatformKey, RegistryArtifact>> = {};
  for (const wanted of wantedAssets(m, platform)) {
    if (artifacts[wanted.platform]) continue;
    const found = await artifactOf(fetcher, release, wanted.name);
    if (found) artifacts[wanted.platform] = found;
  }
  if (!Object.keys(artifacts).length) return null;
  const version: RegistryVersion = {
    version: m.version,
    repo,
    channel: release.prerelease || m.version.includes("-") ? "beta" : "latest",
    publishedAt: release.publishedAt,
    engines: { ardia: m.engines.ardia, ...(m.engines.sdk ? { sdk: m.engines.sdk } : {}) },
    dependencies: { ...(m.dependencies ?? {}) },
    optionalDependencies: { ...(m.optionalDependencies ?? {}) },
    provides: [...(m.provides ?? [])],
    consumes: [...(m.consumes ?? [])],
    permissions: (m.permissions ?? {}) as RegistryVersion["permissions"],
    artifacts: artifacts as RegistryVersion["artifacts"],
    yanked: false,
  };
  return { version, manifest: m };
}

export async function githubDetail(fetcher: RegistryFetcher, repo: string, platform: PlatformKey | null = null): Promise<GithubResult> {
  if (!GITHUB_REPO.test(repo)) return { ok: false, reason: "That isn't a GitHub repository like owner/repo" };
  const listed = await getText(fetcher, `${API}/repos/${repo}/releases?per_page=${MAX_RELEASES}`);
  if (listed === null) return { ok: false, reason: "Couldn't read that repository's releases on GitHub" };
  const releases = releasesOf(json(listed));
  const latest = releases.find((r) => !r.prerelease);
  const beta = releases.find((r) => r.prerelease);
  const read = (await Promise.all([latest, beta].filter((r): r is Release => !!r).map((r) => versionOf(fetcher, repo, r, platform)))).filter((v): v is NonNullable<typeof v> => !!v);
  const first = read[0];
  if (!first) return { ok: false, reason: "Its newest release has no manifest 3 plugin.json, or no .tar.gz for this computer with a .sha256 beside it" };
  if (read.some((r) => r.manifest.id !== first.manifest.id)) return { ok: false, reason: "Its releases don't agree on the plugin's id" };
  if (first.manifest.id.startsWith("@ardia/")) return { ok: false, reason: "@ardia plugins come only from Ardia's registry" };
  const versions = [...new Map(read.map((r) => [r.version.version, r.version])).values()];
  const tags = { ...(versions.find((v) => v.channel === "latest") ? { latest: versions.find((v) => v.channel === "latest")!.version } : {}), ...(versions.find((v) => v.channel === "beta") ? { beta: versions.find((v) => v.channel === "beta")!.version } : {}) };
  const detail = { id: first.manifest.id, name: first.manifest.name, description: first.manifest.description, official: false, tier: "js_sandbox" as const, repo, tags, versions };
  const checked = validatePluginDetail(detail, first.manifest.id);
  return checked.ok ? { ok: true, detail: checked.value } : { ok: false, reason: checked.problems[0] ?? "Its releases couldn't be read" };
}
