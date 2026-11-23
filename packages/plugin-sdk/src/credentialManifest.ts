import { CREDENTIAL_CAPABILITIES, CREDENTIAL_MEMORY_MB } from "./credentialConstants";
import { cliOf } from "./credentialCliManifest";
import { Checks, isFields, isPluginFile, P, SYMBOL, type Fields } from "./credentialManifestChecks";
import type { CredentialContribution } from "./credentialManifestTypes";
import { signInOf } from "./credentialSignInManifest";
import type { CredentialCapability } from "./credentialTypes";

export { P as CREDENTIAL_PROVIDER_PATH } from "./credentialManifestChecks";
export type * from "./credentialManifestTypes";

const TOP_KEYS = ["title", "symbol", "icon", "accent", "readsOffline", "approvalLastsSeconds", "capabilities", "signIn", "cli"];
const ACCENT = /^#[0-9A-Fa-f]{6}$/;
const DEFAULT_SYMBOL = "key.fill";
const LIMITS = { title: 40, capabilities: 8, approvalSeconds: 86400 } as const;

function capabilitiesOf(c: Checks, value: unknown): CredentialCapability[] {
  const raw = c.list(`${P}.capabilities`, value, 0, LIMITS.capabilities) ?? [];
  const out: CredentialCapability[] = [];
  raw.forEach((capability, i) => {
    if (!(CREDENTIAL_CAPABILITIES as readonly unknown[]).includes(capability)) c.add(`${P}.capabilities[${i}] must be one of ${CREDENTIAL_CAPABILITIES.join(", ")}`);
    else if (out.includes(capability as CredentialCapability)) c.add(`${P}.capabilities has ${String(capability)} twice`);
    else out.push(capability as CredentialCapability);
  });
  return out;
}

function lookOf(c: Checks, doc: Fields): { symbol: string; icon: string | null } {
  if (doc.symbol !== undefined && doc.icon !== undefined) c.add(`${P} takes a symbol or an icon, not both`);
  const symbol = c.matching(`${P}.symbol`, doc.symbol, SYMBOL, "an SF Symbol name", false) ?? DEFAULT_SYMBOL;
  if (doc.icon === undefined) return { symbol, icon: null };
  const icon = typeof doc.icon === "string" && isPluginFile(doc.icon) && doc.icon.toLowerCase().endsWith(".png") ? doc.icon : null;
  if (!icon) c.add(`${P}.icon must be a .png file inside the plugin's folder, like icon.png`);
  return { symbol, icon };
}

export function credentialProviderOf(problems: string[], value: unknown): CredentialContribution | null {
  if (value === undefined) return null;
  const c = new Checks();
  const doc = c.object(P, value);
  if (doc) {
    c.only(P, doc, TOP_KEYS);
    const parsed = contributionOf(c, doc);
    problems.push(...c.problems);
    return c.problems.length ? null : parsed;
  }
  problems.push(...c.problems);
  return null;
}

function contributionOf(c: Checks, doc: Fields): CredentialContribution | null {
  const title = c.text(`${P}.title`, doc.title, LIMITS.title);
  const look = lookOf(c, doc);
  const accent = c.matching(`${P}.accent`, doc.accent, ACCENT, "a color like #175DDC", false);
  const readsOffline = c.flag(`${P}.readsOffline`, doc.readsOffline, true);
  const approvalLastsSeconds = c.integer(`${P}.approvalLastsSeconds`, doc.approvalLastsSeconds, 1, LIMITS.approvalSeconds, null);
  const capabilities = capabilitiesOf(c, doc.capabilities);
  const signIn = signInOf(c, doc.signIn);
  const cli = cliOf(c, doc.cli);
  if (capabilities.includes("selfHosted") && signIn && !signIn.servers.some((s) => s.custom)) c.add(`${P}.capabilities: selfHosted needs a custom server in ${P}.signIn.servers`);
  if (capabilities.includes("masterPassword") && isFields(doc.signIn) && doc.signIn.unlock === undefined) c.add(`${P}.capabilities: masterPassword needs ${P}.signIn.unlock`);
  if (!title || !signIn || !cli) return null;
  return { title, ...look, accent, readsOffline, approvalLastsSeconds, capabilities, signIn, cli };
}

export function closedPluginProblems(manifest: Fields): string[] {
  const problems: string[] = [];
  if (manifest.main === undefined) problems.push(`${P} needs a main`);
  if (manifest.sidecar !== undefined) problems.push(`${P} runs in main, not a sidecar`);
  const contributes = isFields(manifest.contributes) ? manifest.contributes : {};
  for (const key of Object.keys(contributes)) if (key !== "credentialProvider") problems.push(`contributes.${key}: a credential provider contributes nothing else`);
  const permissions = manifest.permissions;
  const asks = Array.isArray(permissions) ? permissions.length > 0 : isFields(permissions) ? Object.keys(permissions).length > 0 : permissions !== undefined;
  if (asks) problems.push("permissions: a credential provider asks for no permissions");
  if (manifest.activationEvents !== undefined) problems.push("activationEvents: a credential provider starts when Ardia asks it, so it takes no activation events");
  if (manifest.official !== true) problems.push(`${P} needs official: true`);
  return problems;
}

export function credentialMemoryProblem(memoryMB: unknown): string | null {
  if (memoryMB === undefined) return null;
  const { least, most } = CREDENTIAL_MEMORY_MB;
  return typeof memoryMB === "number" && Number.isInteger(memoryMB) && memoryMB >= least && memoryMB <= most ? null : `memoryMB must be a whole number from ${least} to ${most}`;
}

export const declaresCredentialProvider = (manifest: unknown): boolean => isFields(manifest) && isFields(manifest.contributes) && manifest.contributes.credentialProvider !== undefined;

function contributionIn(manifest: unknown): unknown {
  return declaresCredentialProvider(manifest) ? ((manifest as Fields).contributes as Fields).credentialProvider : manifest;
}

export function checkCredentialManifest(manifest: unknown): string[] {
  const problems: string[] = [];
  if (declaresCredentialProvider(manifest)) {
    const doc = manifest as Fields;
    problems.push(...closedPluginProblems(doc));
    const memory = credentialMemoryProblem(doc.memoryMB);
    if (memory) problems.push(memory);
  }
  const given = contributionIn(manifest);
  if (given === undefined) return [`${P} must be an object`];
  credentialProviderOf(problems, given);
  return problems;
}

export function readCredentialContribution(manifest: unknown): CredentialContribution {
  const problems: string[] = [];
  const contribution = credentialProviderOf(problems, contributionIn(manifest) ?? null);
  if (!contribution) throw new Error(`The credential provider manifest has problems:\n${problems.join("\n")}`);
  return contribution;
}
