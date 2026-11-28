import { contributesSpec } from "./manifestContributes";
import {
  DEFAULT_IDLE_TIMEOUT_SEC,
  LIMITS_V3,
  MANIFEST_V3,
  PLATFORM_KEYS,
  PLUGIN_ID_PATTERN,
  activationEvent,
  argument,
  description,
  githubRepo,
  httpsUrl,
  interfaceName,
  pluginId,
  pluginPath,
  scriptPath,
  semver,
  semverRange,
  slug,
  symbol,
  title,
} from "./manifestParts";
import { permissionsSpec } from "./manifestPermissions";
import { manifestRules, needsGlobalScope } from "./manifestRules";
import { INVALID, arr, int, isPlainObject, obj, oneOf, record, str, text, withDefault, type Infer, type JsonSchema, type Spec } from "./spec";

export {
  ACTIVATION_PREFIXES_V3,
  DEFAULT_IDLE_TIMEOUT_SEC,
  INTERFACE_PATTERN,
  LIMITS_V3,
  MANIFEST_V3,
  MATCH_PATTERN,
  MENU_SLOTS_V3,
  NETWORK_HOST_PATTERN,
  PANEL_MODES_V3,
  PLATFORM_KEYS,
  PLUGIN_ID_PATTERN,
  RUN_AT,
  SEMVER_PATTERN,
  STATE_EVENTS_V3,
  STATE_INTENTS_V3,
  isPluginPath,
  normalizeShortcut,
  type PlatformKey,
} from "./manifestParts";
export { permissionGrants, permissionsSpec, PERMISSION_KEYS, type PermissionsV3 } from "./manifestPermissions";
export type { CommandV3, ContentScriptV3, ContributesV3, PageStyleV3 } from "./manifestContributes";
export { coveredBy, hostCoveredBy, patternCovers, urlMatches } from "./matchPatterns";
export { needsGlobalScope } from "./manifestRules";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const dependencyMap = record(semverRange, {
  keyPattern: PLUGIN_ID_PATTERN,
  keyRule: "a scoped plugin id like @scope/name",
  max: LIMITS_V3.dependencies,
  description: "Plugin ids and the semver ranges this plugin works with",
});

const assetName = str({ pattern: "^[A-Za-z0-9._{}-]{1,128}$", rule: "a release asset file name; {version} and {platform} are filled in" });

const releaseSpec = obj(
  {
    github: githubRepo,
    tagPrefix: str({ pattern: "^[A-Za-z0-9._/-]{0,40}$", rule: "up to 40 letters, digits, ., _, / and -", description: 'Put before the version in a tag, like "v" for v1.2.3' }),
    asset: assetName,
    assets: obj(Object.fromEntries(PLATFORM_KEYS.map((platform) => [platform, assetName])) as Record<(typeof PLATFORM_KEYS)[number], typeof assetName>, { what: "release.assets" }),
  },
  { required: ["github"], what: "release", description: "Where Ardia finds the plugin's releases" },
);

function argvSpec(): Spec<string[]> {
  const program = pluginPath("a program inside the plugin's folder, as a relative path like bin/server");
  return {
    accepts: Array.isArray,
    check(value, path, problems) {
      if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS_V3.argv) {
        problems.push(`${path} must be a list of 1 to ${LIMITS_V3.argv}`);
        return INVALID;
      }
      const out: string[] = [];
      let failed = false;
      value.forEach((entry, i) => {
        const checked = (i === 0 ? program : argument).check(entry, `${path}[${i}]`, problems);
        if (checked === INVALID) failed = true;
        else out.push(checked);
      });
      return failed ? INVALID : out;
    },
    schema: () => ({
      type: "array",
      minItems: 1,
      maxItems: LIMITS_V3.argv,
      prefixItems: [program.schema()],
      items: argument.schema(),
      description: "The program, a relative path inside the plugin's folder, then its arguments",
    }),
  };
}

const sidecarSpec = obj(
  {
    run: argvSpec(),
    memoryMB: int(LIMITS_V3.memoryMB[0], LIMITS_V3.memoryMB[1], "The sidecar's memory limit"),
  },
  { required: ["run"], what: "sidecar" },
);

const interfaces = arr(interfaceName, { max: LIMITS_V3.interfaces, unique: true });

export const manifestV3Spec = obj(
  {
    $schema: str({ max: 512, rule: "the schema's URL" }),
    manifest: oneOf([MANIFEST_V3] as const, "The manifest's version"),
    id: pluginId,
    name: text(LIMITS_V3.name, "The plugin's name, shown in Settings and the gallery"),
    description,
    version: semver,
    icon: symbol,
    iconUrl: httpsUrl,
    license: str({ pattern: "^[A-Za-z0-9.+\\- ()]{1,64}$", rule: "an SPDX license expression like MIT" }),
    repository: httpsUrl,
    homepage: httpsUrl,
    categories: arr(slug, { max: LIMITS_V3.categories, unique: true }),
    keywords: arr(text(LIMITS_V3.keyword), { max: LIMITS_V3.keywords, description: "Words that find the plugin" }),
    engines: obj({ ardia: semverRange, sdk: semverRange }, { required: ["ardia"], what: "engines" }),
    scope: withDefault(oneOf(["global", "profile"] as const, "profile: one copy per profile. global: one for the whole app (forced by programs and permissions.control)"), "profile"),
    dependencies: dependencyMap,
    optionalDependencies: dependencyMap,
    provides: interfaces,
    consumes: interfaces,
    release: releaseSpec,
    main: scriptPath,
    sidecar: sidecarSpec,
    memoryMB: int(LIMITS_V3.memoryMB[0], LIMITS_V3.memoryMB[1], "main's memory limit"),
    idleTimeoutSec: withDefault(int(LIMITS_V3.idleTimeoutSec[0], LIMITS_V3.idleTimeoutSec[1], "How long main and the sidecar keep running with nothing to do"), DEFAULT_IDLE_TIMEOUT_SEC),
    activationEvents: arr(activationEvent, { max: LIMITS_V3.activationEvents }),
    permissions: permissionsSpec,
    contributes: contributesSpec,
    telemetry: obj(
      { title, items: arr(text(LIMITS_V3.telemetryItem), { min: 1, max: LIMITS_V3.telemetryItems }) },
      { required: ["title", "items"], what: "telemetry", description: "What the plugin counts, shown before it's turned on" },
    ),
  },
  { required: ["manifest", "id", "name", "description", "version", "engines"] },
);

export type ManifestV3 = Infer<typeof manifestV3Spec>;

export type ManifestV3Result = { ok: true; manifest: ManifestV3 } | { ok: false; problems: string[] };

export function parseManifestV3Json(source: string): ManifestV3Result {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, problems: [`plugin.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateManifestV3(raw);
}

export function validateManifestV3(raw: unknown): ManifestV3Result {
  if (!isPlainObject(raw)) return { ok: false, problems: ["The manifest must be a JSON object"] };
  if (raw.manifest !== MANIFEST_V3) return { ok: false, problems: [`manifest must be ${MANIFEST_V3}`] };
  const problems: string[] = [];
  const checked = manifestV3Spec.check(raw, "", problems);
  if (checked === INVALID || problems.length) return { ok: false, problems };
  const manifest = checked;
  const forced = needsGlobalScope(manifest);
  const rules = manifestRules({ ...manifest, scopeGiven: raw.scope !== undefined });
  if (rules.length) return { ok: false, problems: rules };
  return { ok: true, manifest: forced ? { ...manifest, scope: "global" } : manifest };
}

const ifPresent = (path: string[], schema: JsonSchema): JsonSchema =>
  path.reduceRight<JsonSchema>((inner, key) => ({ required: [key], properties: { [key]: inner } }), schema);

export function generateManifestV3JsonSchema(): JsonSchema {
  const body = manifestV3Spec.schema();
  const globalScope: JsonSchema = {
    if: { anyOf: [ifPresent(["contributes", "programs"], { minItems: 1 }), ifPresent(["permissions", "control"], { const: true })] },
    then: { properties: { scope: { const: "global" } } },
  };
  const fullUrls: JsonSchema = {
    if: ifPresent(["permissions", "fullUrls"], { const: true }),
    then: ifPresent(["permissions", "tabs"], { enum: ["read", "write"] }),
  };
  const workspace: JsonSchema = {
    if: ifPresent(["permissions", "workspace"], { const: true }),
    then: { allOf: [ifPresent(["permissions", "tabs"], { const: "write" }), ifPresent(["permissions", "fullUrls"], { const: true })] },
  };
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: "Ardia plugin (manifest 3)",
    ...body,
    allOf: [globalScope, fullUrls, workspace],
    "x-ardia-rules": [
      "pageStyles[].matches and contentScripts[].matches must be covered by permissions.pages",
      "a plugin can't depend on itself, nor list one id in both dependencies and optionalDependencies",
      "views, sidebarViews, omnibox and inputModes need main; tools, hooks and handler commands need main or sidecar",
      "commands, tools, panels and other contributions are unique by id or name, and what they name exists",
    ],
  };
}

export function manifestV3SchemaJson(): string {
  return `${JSON.stringify(generateManifestV3JsonSchema(), null, 2)}\n`;
}
