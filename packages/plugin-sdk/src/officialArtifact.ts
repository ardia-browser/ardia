import { canonicalJson, fromBase64, fromBase64Url, toBase64Url, utf8, type CryptoOptions, type PublicKeys, type SubtleLike } from "./envelope";
import { PLATFORM_KEYS, PLUGIN_ID_PATTERN, type PlatformKey } from "./manifestParts";
import { isSemver } from "./semver";

export const OFFICIAL_ARTIFACT_DOMAIN = "ardia-official-native-v1\n";

export const OFFICIAL_SCOPE = "@ardia/";

export type OfficialArtifactClaim = { id: string; version: string; platform: PlatformKey; sha256: string };

export type OfficialVerifyResult = { ok: true; kid: string } | { ok: false; reason: string };

const ED25519 = { name: "Ed25519" } as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const ID = new RegExp(PLUGIN_ID_PATTERN);

export function officialArtifactProblem(claim: OfficialArtifactClaim): string | null {
  if (!ID.test(claim.id)) return "id must be a scoped plugin id like @ardia/cli";
  if (!claim.id.startsWith(OFFICIAL_SCOPE)) return "only @ardia/* plugins carry an official signature";
  if (!isSemver(claim.version)) return "version must be a semver version";
  if (!(PLATFORM_KEYS as readonly string[]).includes(claim.platform)) return "platform isn't one Ardia builds for";
  if (!SHA256.test(claim.sha256)) return "sha256 must be 64 lowercase hex digits";
  return null;
}

export function officialArtifactMessage(claim: OfficialArtifactClaim): Uint8Array {
  const problem = officialArtifactProblem(claim);
  if (problem) throw new Error(problem);
  return utf8(OFFICIAL_ARTIFACT_DOMAIN + canonicalJson({ v: 1, id: claim.id, version: claim.version, platform: claim.platform, sha256: claim.sha256 }));
}

function subtleOf(options: CryptoOptions): SubtleLike {
  const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!subtle) throw new Error("There's no WebCrypto here; pass options.subtle to sign or verify official artifacts.");
  return subtle;
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const found = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  return found ? fromBase64(found[1] ?? "") : null;
}

export async function signOfficialArtifact(claim: OfficialArtifactClaim, privateKeyPem: string, options: CryptoOptions = {}): Promise<string> {
  const pkcs8 = pemBody(privateKeyPem, "PRIVATE KEY");
  if (!pkcs8) throw new Error("The private key must be a PKCS #8 PEM (-----BEGIN PRIVATE KEY-----).");
  const subtle = subtleOf(options);
  const key = await subtle.importKey("pkcs8", pkcs8, ED25519, false, ["sign"]);
  return toBase64Url(new Uint8Array(await subtle.sign(ED25519, key, officialArtifactMessage(claim))));
}

const entriesOf = (keys: PublicKeys): [string, string][] => (keys instanceof Map ? [...keys.entries()] : Object.entries(keys as Record<string, string>));

export async function verifyOfficialArtifact(claim: OfficialArtifactClaim, officialSig: string | undefined, publicKeys: PublicKeys, options: CryptoOptions = {}): Promise<OfficialVerifyResult> {
  const problem = officialArtifactProblem(claim);
  if (problem) return { ok: false, reason: problem };
  if (officialSig === undefined) return { ok: false, reason: "The artifact has no official signature" };
  const signature = SIG.test(officialSig) ? fromBase64Url(officialSig) : null;
  if (!signature || signature.length !== 64) return { ok: false, reason: "The official signature isn't 64 bytes of unpadded base64url" };
  const keys = entriesOf(publicKeys);
  if (!keys.length) return { ok: false, reason: "This Ardia has no official signing key" };
  const message = officialArtifactMessage(claim);
  try {
    const subtle = subtleOf(options);
    for (const [kid, text] of keys) {
      const spki = text.includes("-----BEGIN") ? pemBody(text, "PUBLIC KEY") : null;
      const raw = spki ? null : fromBase64(text);
      const key = spki ? await subtle.importKey("spki", spki, ED25519, false, ["verify"]) : raw && raw.length === 32 ? await subtle.importKey("raw", raw, ED25519, false, ["verify"]) : null;
      if (key && (await subtle.verify(ED25519, key, signature, message))) return { ok: true, kid };
    }
    return { ok: false, reason: "No official key matches the signature" };
  } catch (error) {
    return { ok: false, reason: `The official signature couldn't be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type NativeTierInput = { sidecar?: unknown; contributes?: { programs?: readonly unknown[] }; permissions?: { control?: boolean } };

export const isNativeTier = (manifest: NativeTierInput): boolean =>
  (manifest.sidecar !== undefined && manifest.sidecar !== null) || (manifest.contributes?.programs?.length ?? 0) > 0 || manifest.permissions?.control === true;

export const reachesOutsideSandbox = (manifest: NativeTierInput): boolean => (manifest.contributes?.programs?.length ?? 0) > 0 || manifest.permissions?.control === true;
