import { LIMITS_V3, PLATFORM_KEYS, PLUGIN_ID_PATTERN, githubRepo, httpsUrl, interfaceName, pluginId, semver, semverRange, slug, symbol } from "./manifestParts";
import { isRange } from "./semver";
import { arr, bool, freeText, int, json, nullable, obj, oneOf, record, str, text, validate, type Infer } from "./spec";

export const REGISTRY_LIMITS = { plugins: 20000, versions: 500, revocations: 5000, reason: 1000, versionMatches: 256, description: 1000 } as const;

const sha256 = str({ pattern: "^[a-f0-9]{64}$", rule: "a lowercase hex SHA-256" });
const timestamp = str({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$", rule: "a UTC time like 2026-11-25T10:00:00Z" });
const seq = int(0, Number.MAX_SAFE_INTEGER);
const tags = obj({ latest: semver, beta: semver }, { what: "tags" });
const tier = oneOf(["js_sandbox", "native"] as const);
const scope = oneOf(["global", "profile"] as const);
const dependencyMap = record(semverRange, { keyPattern: PLUGIN_ID_PATTERN, keyRule: "a scoped plugin id like @scope/name", max: LIMITS_V3.dependencies });
const interfaces = arr(interfaceName, { max: LIMITS_V3.interfaces, unique: true });
const license = str({ pattern: "^[A-Za-z0-9.+\\- ()]{1,64}$", rule: "an SPDX license expression" });

export const indexEntrySpec = obj(
  {
    id: pluginId,
    name: text(LIMITS_V3.name),
    description: freeText(REGISTRY_LIMITS.description),
    icon: nullable(symbol),
    iconUrl: nullable(httpsUrl),
    official: bool(),
    tier,
    repo: githubRepo,
    scope,
    categories: arr(slug, { max: LIMITS_V3.categories, unique: true }),
    keywords: arr(text(LIMITS_V3.keyword), { max: LIMITS_V3.keywords }),
    license: nullable(license),
    homepage: nullable(httpsUrl),
    tags,
    installs: int(0, Number.MAX_SAFE_INTEGER),
    updatedAt: timestamp,
  },
  { required: ["id", "name", "description", "icon", "official", "tier", "repo", "scope", "categories", "keywords", "license", "homepage", "tags", "installs", "updatedAt"], what: "an index entry" },
);

export const registryIndexSpec = obj(
  { seq, generatedAt: timestamp, plugins: arr(indexEntrySpec, { max: REGISTRY_LIMITS.plugins }) },
  { required: ["seq", "generatedAt", "plugins"], what: "the registry index" },
);

export const artifactSpec = obj(
  {
    url: httpsUrl,
    sha256,
    sizeBytes: int(1, 64 * 1024 * 1024),
    officialSig: str({ pattern: "^[A-Za-z0-9_-]{86}$", rule: "an unpadded base64url Ed25519 signature" }),
  },
  { required: ["url", "sha256", "sizeBytes"], what: "an artifact" },
);

const artifactsSpec = obj(Object.fromEntries(PLATFORM_KEYS.map((platform) => [platform, artifactSpec])) as Record<(typeof PLATFORM_KEYS)[number], typeof artifactSpec>, { what: "artifacts" });

export const versionEntrySpec = obj(
  {
    version: semver,
    repo: githubRepo,
    channel: oneOf(["latest", "beta"] as const),
    publishedAt: timestamp,
    engines: obj({ ardia: semverRange, sdk: semverRange }, { required: ["ardia"], what: "engines" }),
    dependencies: dependencyMap,
    optionalDependencies: dependencyMap,
    provides: interfaces,
    consumes: interfaces,
    permissions: json(),
    artifacts: artifactsSpec,
    yanked: bool(),
  },
  {
    required: ["version", "repo", "channel", "publishedAt", "engines", "dependencies", "optionalDependencies", "provides", "consumes", "permissions", "artifacts", "yanked"],
    what: "a version",
  },
);

export const pluginDetailSpec = obj(
  {
    id: pluginId,
    name: text(LIMITS_V3.name),
    description: freeText(REGISTRY_LIMITS.description),
    official: bool(),
    tier,
    repo: githubRepo,
    tags,
    versions: arr(versionEntrySpec, { max: REGISTRY_LIMITS.versions }),
  },
  { required: ["id", "name", "description", "official", "tier", "repo", "tags", "versions"], what: "a plugin's registry entry" },
);

export const REVOCATION_ACTIONS = ["yank", "disable", "block"] as const;
export type RevocationAction = (typeof REVOCATION_ACTIONS)[number];

const versionMatch = str({ test: isRange, min: 1, max: 256, rule: "a version like 1.2.0 (matched exactly) or a range like >=1.2.0 <1.3.0" });

export const revocationMatchSpec = obj(
  {
    id: pluginId,
    versions: arr(versionMatch, { min: 1, max: REGISTRY_LIMITS.versionMatches }),
    scope: str({ pattern: "^@[a-z0-9][a-z0-9-]{0,38}$", rule: "a plugin scope like @acme" }),
    githubOwner: str({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$", rule: "a GitHub user or organization" }),
    repo: githubRepo,
    sha256,
    registry: str({ pattern: "^(?:https?://)?[a-z0-9](?:[a-z0-9.-]{0,252})(?::\\d{1,5})?/?$", rule: "a registry host like ardia.dev or an origin like https://ardia.dev" }),
  },
  { what: "match" },
);

export const revocationEntrySpec = obj(
  {
    entryId: str({ pattern: "^[A-Za-z0-9._:-]{1,128}$", rule: "1 to 128 letters, digits, ., _, : and -" }),
    seq,
    match: revocationMatchSpec,
    action: oneOf(REVOCATION_ACTIONS),
    rollbackTo: semver,
    reason: text(REGISTRY_LIMITS.reason),
    issuedAt: timestamp,
  },
  { required: ["entryId", "seq", "match", "action", "reason", "issuedAt"], what: "a revocation" },
);

export const revocationListSpec = obj(
  { seq, issuedAt: timestamp, entries: arr(revocationEntrySpec, { max: REGISTRY_LIMITS.revocations }) },
  { required: ["seq", "issuedAt", "entries"], what: "the revocation list" },
);

export type RegistryIndexPayload = Infer<typeof registryIndexSpec>;
export type RegistryIndexEntry = Infer<typeof indexEntrySpec>;
export type RegistryArtifact = Infer<typeof artifactSpec>;
export type RegistryArtifacts = Infer<typeof artifactsSpec>;
export type RegistryVersion = Infer<typeof versionEntrySpec>;
export type RegistryPluginPayload = Infer<typeof pluginDetailSpec>;
export type RevocationMatchSpec = Infer<typeof revocationMatchSpec>;
export type RevocationEntry = Infer<typeof revocationEntrySpec>;
export type RegistryRevocationsPayload = Infer<typeof revocationListSpec>;

export type Validated<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const MATCH_KEYS = ["id", "versions", "scope", "githubOwner", "repo", "sha256", "registry"] as const;

export function validateRegistryIndex(raw: unknown): Validated<RegistryIndexPayload> {
  const result = validate(registryIndexSpec, raw);
  if (!result.ok) return result;
  const problems: string[] = [];
  const seen = new Set<string>();
  result.value.plugins.forEach((entry, i) => {
    if (seen.has(entry.id)) problems.push(`plugins[${i}].id: ${entry.id} is listed twice`);
    seen.add(entry.id);
  });
  return problems.length ? { ok: false, problems } : result;
}

export function validatePluginDetail(raw: unknown, expectedId?: string): Validated<RegistryPluginPayload> {
  const result = validate(pluginDetailSpec, raw);
  if (!result.ok) return result;
  const detail = result.value;
  const problems: string[] = [];
  if (expectedId !== undefined && detail.id !== expectedId) problems.push(`id is ${detail.id}, but this file is for ${expectedId}`);
  const seen = new Set<string>();
  detail.versions.forEach((entry, i) => {
    if (seen.has(entry.version)) problems.push(`versions[${i}].version: ${entry.version} is listed twice`);
    seen.add(entry.version);
    if (!Object.keys(entry.artifacts).length) problems.push(`versions[${i}].artifacts must have at least one platform`);
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      if (Object.hasOwn(entry[field], detail.id)) problems.push(`versions[${i}].${field}: a plugin can't depend on itself`);
    }
  });
  const live = detail.versions.filter((v) => !v.yanked);
  if (live.some((v) => v.channel === "latest") && detail.tags.latest === undefined) problems.push("tags.latest is required while a latest release isn't yanked");
  else if (live.length && !live.some((v) => v.channel === "latest") && detail.tags.beta === undefined) problems.push("tags.beta is required while a beta release isn't yanked");
  for (const [tag, version] of Object.entries(detail.tags)) {
    const entry = detail.versions.find((v) => v.version === version);
    if (!entry) problems.push(`tags.${tag}: ${version} isn't one of the versions`);
    else if (entry.yanked) problems.push(`tags.${tag}: ${version} is yanked`);
    else if (tag === "latest" && entry.channel !== "latest") problems.push(`tags.latest: ${version} is a beta version`);
  }
  return problems.length ? { ok: false, problems } : result;
}

export function validateRevocationList(raw: unknown, options: { minSeq?: number } = {}): Validated<RegistryRevocationsPayload> {
  const result = validate(revocationListSpec, raw);
  if (!result.ok) return result;
  const list = result.value;
  const problems: string[] = [];
  if (options.minSeq !== undefined && list.seq < options.minSeq) problems.push(`seq ${list.seq} is older than the list already seen (${options.minSeq})`);
  const ids = new Set<string>();
  list.entries.forEach((entry, i) => {
    if (ids.has(entry.entryId)) problems.push(`entries[${i}].entryId: ${entry.entryId} is listed twice`);
    ids.add(entry.entryId);
    if (entry.seq > list.seq) problems.push(`entries[${i}].seq ${entry.seq} is newer than the list's seq ${list.seq}`);
    if (!MATCH_KEYS.some((key) => entry.match[key] !== undefined)) problems.push(`entries[${i}].match must name at least one of ${MATCH_KEYS.join(", ")}`);
    if (entry.match.versions !== undefined && entry.match.id === undefined) problems.push(`entries[${i}].match.versions needs entries[${i}].match.id`);
    if (entry.rollbackTo !== undefined && entry.match.id === undefined) problems.push(`entries[${i}].rollbackTo needs entries[${i}].match.id`);
  });
  return problems.length ? { ok: false, problems } : result;
}
