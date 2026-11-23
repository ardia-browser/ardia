import { CREDENTIAL_LIMITS, VERB_TIMEOUTS_MS } from "./credentialConstants";
import { deniedMatch, deniedRunName } from "./deniedCommands";
import { base64, isLoopbackHost, isRecord, sortedJson, stringsIn, urlParts, utf8Bytes, utf8Length } from "./credentialData";
import { isSecretHandle } from "./credentialErrors";
import { readCredentialContribution } from "./credentialManifest";
import type { CredentialCli, CredentialVerb, VerbSlot } from "./credentialManifestTypes";
import type { FakeLaunch, SecretHandle, VerbParam, VerbParams } from "./credentialTypes";

export type VerbRefusalCode = "refused" | "bad_request" | "expired" | "denied";

export type VerbRefusal = { code: VerbRefusalCode; message: string };

export type BuiltVerb = { launch: FakeLaunch; verb: CredentialVerb; consumed: string[]; jsonStrings: string[] };

export type SecretLookup = (handle: SecretHandle) => string | null;

const CODE_SLOT = new RegExp(CREDENTIAL_LIMITS.codeSlotPattern);
const BREAKS = /[\n\r\0]/;
const CONTROL_OR_DIRECTION = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const refusal = (code: VerbRefusalCode, message: string): VerbRefusal => ({ code, message });

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > CREDENTIAL_LIMITS.stdinJsonDepth) return depth;
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : null;
  if (!children) return depth;
  return children.reduce<number>((most, entry) => Math.max(most, jsonDepth(entry, depth + 1)), depth + 1);
}

export function httpsUrlProblem(value: string, allowLocalHttp: boolean): boolean {
  if (utf8Length(value) > CREDENTIAL_LIMITS.urlSlotLength || value.startsWith("-") || /\s/.test(value) || BREAKS.test(value) || CONTROL_OR_DIRECTION.test(value)) return true;
  const parts = urlParts(value);
  if (!parts || parts.userinfo) return true;
  if (parts.scheme === "https") return false;
  return !(parts.scheme === "http" && allowLocalHttp && isLoopbackHost(parts.host));
}

export const effectiveTimeout = (asked: unknown, verbTimeoutMs: number) =>
  typeof asked === "number" && Number.isFinite(asked) ? Math.max(VERB_TIMEOUTS_MS.least, Math.min(asked, verbTimeoutMs)) : verbTimeoutMs;

export function deniedCommand(program: string, argv: readonly string[]): string | null {
  const denied = deniedMatch(program, argv);
  return denied ? `${deniedRunName(program, denied)} is never allowed.` : null;
}

const TEXT_RULES: Record<VerbSlot["type"], (slot: VerbSlot) => string> = {
  id: (slot) => `must match the pattern ${slot.pattern ?? ""}`,
  enum: (slot) => `must be one of ${(slot.values ?? []).join(", ")}`,
  url: (slot) => (slot.allowLocalHttp ? "must be an https address, or http to this Mac" : "must be an https address"),
  email: () => "must be an email address",
  code: () => "must be 1 to 64 letters and digits",
  flag: () => "must be true or false",
  secret: () => "must be a secret handle",
  json: () => "must be JSON",
};

const holdsHandle = (value: unknown): boolean => isSecretHandle(value) || (Array.isArray(value) ? value.some(holdsHandle) : isRecord(value) && Object.values(value).some(holdsHandle));

type Checked = { value: string | boolean | null; secret?: string; json?: unknown } | VerbRefusal;

function checkSlot(cli: CredentialCli, verbId: string, name: string, slot: VerbSlot, value: VerbParam, secrets: SecretLookup): Checked {
  const bad = (rule: string) => refusal("bad_request", `${name} for ${verbId} ${rule}.`);
  if (slot.type === "secret") {
    if (!isSecretHandle(value)) return bad("must be a secret handle");
    const secret = secrets(value);
    if (secret === null) return refusal("expired", `${value.$secret} was used or has ended.`);
    if (utf8Length(secret) > CREDENTIAL_LIMITS.secretBytes) return bad("is longer than Ardia passes");
    return { value: null, secret };
  }
  if (isSecretHandle(value)) return refusal("bad_request", "a handle only goes in a secret slot.");
  if (slot.type === "json") {
    if (holdsHandle(value)) return refusal("bad_request", "a handle only goes in a secret slot.");
    let encoded: string;
    try {
      encoded = sortedJson(value, CREDENTIAL_LIMITS.stdinJsonDepth);
    } catch {
      return bad(`must be JSON of depth at most ${CREDENTIAL_LIMITS.stdinJsonDepth}`);
    }
    if (jsonDepth(value) > CREDENTIAL_LIMITS.stdinJsonDepth || utf8Length(encoded) > CREDENTIAL_LIMITS.stdinBytes) return bad("is bigger than Ardia passes");
    return { value: null, json: value };
  }
  if (slot.type === "flag") return typeof value === "boolean" ? { value } : bad("must be true or false");
  const rule = TEXT_RULES[slot.type](slot);
  if (typeof value !== "string" || BREAKS.test(value)) return bad(rule);
  switch (slot.type) {
    case "id": {
      const pattern = slot.pattern === undefined ? undefined : cli.patterns[slot.pattern];
      const ok = pattern !== undefined && utf8Length(value) <= CREDENTIAL_LIMITS.idSlotLength && new RegExp(pattern).test(value);
      return ok ? { value } : bad(rule);
    }
    case "enum":
      return (slot.values ?? []).includes(value) ? { value } : bad(rule);
    case "url":
      return httpsUrlProblem(value, slot.allowLocalHttp === true) ? bad(rule) : { value };
    case "email":
      return value.includes("@") && !/\s/.test(value) && !value.startsWith("-") && utf8Length(value) <= CREDENTIAL_LIMITS.emailSlotLength ? { value } : bad(rule);
    case "code":
      return CODE_SLOT.test(value) ? { value } : bad(rule);
  }
  return bad("has a type Ardia doesn't know");
}

type Resolved = { values: Record<string, string | boolean>; secrets: Record<string, string>; jsons: Record<string, unknown> };

function resolveSlots(cli: CredentialCli, verbId: string, verb: CredentialVerb, params: VerbParams, secrets: SecretLookup): Resolved | VerbRefusal {
  const given = Object.entries(params).filter(([, value]) => value !== undefined);
  if (given.length > CREDENTIAL_LIMITS.verbParams) return refusal("bad_request", `${verbId} takes at most ${CREDENTIAL_LIMITS.verbParams} params.`);
  for (const [key] of given) if (!Object.hasOwn(verb.slots, key)) return refusal("bad_request", `${verbId} has no slot named ${key}.`);
  const out: Resolved = { values: {}, secrets: {}, jsons: {} };
  for (const [name, slot] of Object.entries(verb.slots)) {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      if (slot.type === "flag") out.values[name] = false;
      else if (!slot.optional) return refusal("bad_request", `${name} is required for ${verbId}.`);
      continue;
    }
    const checked = checkSlot(cli, verbId, name, slot, value, secrets);
    if ("code" in checked) return checked;
    if (checked.secret !== undefined) out.secrets[name] = checked.secret;
    else if (checked.json !== undefined) out.jsons[name] = checked.json;
    else if (checked.value !== null) out.values[name] = checked.value;
  }
  return out;
}

function argvOf(cli: CredentialCli, verbId: string, verb: CredentialVerb, values: Resolved["values"]): string[] | VerbRefusal {
  const argv: string[] = [];
  for (const token of verb.argv) {
    if (typeof token === "string") argv.push(token);
    else if ("when" in token) {
      if (values[token.when] === true) argv.push(token.flag);
    } else {
      const value = values[token.slot];
      if (value === undefined) continue;
      const text = String(value);
      if ("flag" in token) argv.push(`${token.flag}=${text}`);
      else if (text.startsWith("-")) return refusal("bad_request", `${token.slot} for ${verbId} can't start with -, since ${cli.name} would read it as an option.`);
      else argv.push(text);
    }
  }
  if (argv.some((token) => token === "--" || BREAKS.test(token))) return refusal("denied", `${cli.name} ${verbId} has an argument Ardia never passes.`);
  const denied = deniedCommand(cli.name, argv);
  return denied ? refusal("denied", denied) : argv;
}

function envOf(cli: CredentialCli, verb: CredentialVerb, secrets: Resolved["secrets"], testFolder: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of [...cli.env, ...verb.env]) {
    if ("literal" in entry) env[entry.name] = entry.literal;
    else if ("secretSlot" in entry) {
      const secret = secrets[entry.secretSlot];
      if (secret !== undefined) env[entry.name] = secret;
    } else if (testFolder === null) continue;
    else if ("testFolder" in entry) env[entry.name] = entry.testFolder ? `${testFolder}/${entry.testFolder}` : testFolder;
    else env[entry.name] = entry.testLiteral;
  }
  return env;
}

function stdinOf(verb: CredentialVerb, resolved: Resolved): string {
  if (!verb.stdin) return "";
  const { slot, encoding } = verb.stdin;
  const raw = Object.hasOwn(resolved.secrets, slot) ? resolved.secrets[slot] : Object.hasOwn(resolved.jsons, slot) ? sortedJson(resolved.jsons[slot]) : undefined;
  if (raw === undefined) return "";
  return encoding === "base64" ? base64(utf8Bytes(raw)) : raw;
}

export function buildVerb(cli: CredentialCli, verbId: string, params: VerbParams, secrets: SecretLookup, testFolder: string | null): BuiltVerb | VerbRefusal {
  const verb = Object.hasOwn(cli.verbs, verbId) ? cli.verbs[verbId] : undefined;
  if (!verb) return refusal("refused", `${cli.name} has no verb ${verbId}.`);
  const resolved = resolveSlots(cli, verbId, verb, params, secrets);
  if ("code" in resolved) return resolved;
  const argv = argvOf(cli, verbId, verb, resolved.values);
  if ("code" in argv) return argv;
  const launch: FakeLaunch = { verb: verbId, argv, env: envOf(cli, verb, resolved.secrets, testFolder), stdin: stdinOf(verb, resolved), timeoutMs: verb.timeoutMs, signIn: verb.signIn };
  return { launch, verb, consumed: Object.values(resolved.secrets), jsonStrings: Object.values(resolved.jsons).flatMap((value) => stringsIn(value)) };
}

export function buildVerbLaunch(manifest: unknown, verb: string, params: VerbParams, secrets: SecretLookup, testFolder: string | null): FakeLaunch | { refused: string } {
  const built = buildVerb(readCredentialContribution(manifest).cli, verb, params, secrets, testFolder);
  return "launch" in built ? built.launch : { refused: built.message };
}
