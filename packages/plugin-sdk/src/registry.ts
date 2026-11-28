import { verifyEnvelope, type CryptoOptions, type PublicKeys } from "./envelope";
import type { Validated } from "./registryTypes";

export {
  CanonicalJsonError,
  ENVELOPE_CONTEXT,
  REGISTRY_ENVELOPE_VERSION,
  REGISTRY_SIGNATURE_DOMAIN,
  canonicalJson,
  envelopeMessage,
  fromBase64,
  fromBase64Url,
  signEnvelope,
  toBase64,
  toBase64Url,
  utf8,
  verifyEnvelope,
  type CryptoOptions,
  type PublicKeys,
  type SignedEnvelope,
  type SubtleLike,
  type VerifyResult,
} from "./envelope";
export {
  REGISTRY_LIMITS,
  REVOCATION_ACTIONS,
  artifactSpec,
  indexEntrySpec,
  pluginDetailSpec,
  registryIndexSpec,
  revocationEntrySpec,
  revocationListSpec,
  revocationMatchSpec,
  validatePluginDetail,
  validateRegistryIndex,
  validateRevocationList,
  versionEntrySpec,
  type RegistryArtifact,
  type RegistryArtifacts,
  type RegistryIndexEntry,
  type RegistryIndexPayload,
  type RegistryPluginPayload,
  type RegistryRevocationsPayload,
  type RegistryVersion,
  type RevocationAction,
  type RevocationEntry,
  type RevocationMatchSpec,
  type Validated,
} from "./registryTypes";
export {
  currentPlatform,
  matchRevocations,
  pickArtifact,
  registryKey,
  sameRegistry,
  strongestRevocation,
  versionMatches,
  type PickedArtifact,
  type RevocationMatch,
  type RevocationTarget,
} from "./revocations";
export {
  resolvePluginGraph,
  type Channel,
  type ResolvedPlugin,
  type ResolveInput,
  type ResolveProblem,
  type ResolveProblemCode,
  type ResolveResult,
  type ResolveRoot,
  type SkippedDependency,
  type Catalog,
} from "./resolve";
export { diffSecuritySurface, securitySurface, type SecurityDiff, type SecuritySurfaceInput } from "./securitySurface";
export {
  OFFICIAL_ARTIFACT_DOMAIN,
  OFFICIAL_SCOPE,
  isNativeTier,
  officialArtifactMessage,
  officialArtifactProblem,
  reachesOutsideSandbox,
  signOfficialArtifact,
  verifyOfficialArtifact,
  type NativeTierInput,
  type OfficialArtifactClaim,
  type OfficialVerifyResult,
} from "./officialArtifact";
export type { PlatformKey } from "./manifestParts";

export async function verifySignedJson<T>(
  envelope: unknown,
  publicKeys: PublicKeys,
  validateBody: (payload: unknown) => Validated<T>,
  options: CryptoOptions = {},
): Promise<{ ok: true; kid: string; value: T } | { ok: false; problems: string[] }> {
  const verified = await verifyEnvelope(envelope, publicKeys, options);
  if (!verified.ok) return { ok: false, problems: [verified.reason] };
  const checked = validateBody(verified.payload);
  return checked.ok ? { ok: true, kid: verified.kid, value: checked.value } : checked;
}
