import { DENIED_ENV_PATTERNS, HOST_ENV } from "./credentialConstants";
import { Checks, isFields, isPluginFile, P } from "./credentialManifestChecks";
import type { EnvEntry } from "./credentialManifestTypes";

const CLI = `${P}.cli`;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_KINDS = ["literal", "secretSlot", "testFolder", "testLiteral"] as const;
const LIMITS = { env: 16, literal: 256, testFolder: 64 } as const;

export function deniedEnvPattern(name: string): string | null {
  for (const pattern of DENIED_ENV_PATTERNS) {
    const matches = pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
    if (matches) return pattern;
  }
  return null;
}

export type EnvScope = { inCli: boolean; secretSlots: ReadonlySet<string>; cliNames: ReadonlySet<string> };

export function envOf(c: Checks, path: string, value: unknown, scope: EnvScope): EnvEntry[] {
  const raw = c.list(path, value, 0, LIMITS.env) ?? [];
  const seen = new Set<string>();
  const out: EnvEntry[] = [];
  raw.forEach((item, i) => {
    const at = `${path}[${i}]`;
    const kinds = isFields(item) ? ENV_KINDS.filter((kind) => item[kind] !== undefined) : [];
    const extra = isFields(item) ? Object.keys(item).filter((k) => k !== "name" && !(ENV_KINDS as readonly string[]).includes(k)) : [];
    if (!isFields(item) || item.name === undefined || kinds.length !== 1 || extra.length) return c.add(`${at} needs a name and exactly one of literal, secretSlot, testFolder or testLiteral`);
    const kind = kinds[0]!;
    const name = c.matching(`${at}.name`, item.name, ENV_NAME, "an environment variable name, like BW_NOINTERACTION");
    if (!name) return;
    if (HOST_ENV.includes(name)) return c.add(`${at}.name: ${name} is set by Ardia`);
    const denied = kind === "testFolder" ? null : deniedEnvPattern(name);
    if (denied) return c.add(`${at}.name: ${name} matches ${denied}, which Ardia never passes`);
    if (seen.has(name)) c.add(`${path} has ${name} twice`);
    else if (!scope.inCli && scope.cliNames.has(name)) c.add(`${CLI}.env has ${name} twice`);
    seen.add(name);
    const entry = envEntryOf(c, at, kind, item[kind], name, scope);
    if (entry) out.push(entry);
  });
  return out;
}

function envEntryOf(c: Checks, at: string, kind: (typeof ENV_KINDS)[number], value: unknown, name: string, scope: EnvScope): EnvEntry | null {
  if (kind === "secretSlot") {
    if (scope.inCli) return (c.add(`${at}.secretSlot: only a verb's env can name a slot`), null);
    if (typeof value !== "string" || !scope.secretSlots.has(value)) return (c.add(`${at}.secretSlot: ${String(value)} isn't a secret slot of this verb`), null);
    return { name, secretSlot: value };
  }
  if ((kind === "testFolder" || kind === "testLiteral") && !scope.inCli) return (c.add(`${at}.${kind} only goes in ${CLI}.env`), null);
  if (kind === "testFolder") {
    const ok = typeof value === "string" && (value === "" || (value.length <= LIMITS.testFolder && isPluginFile(value)));
    return ok ? { name, testFolder: value } : (c.add(`${at}.testFolder must be "" or a plain folder path of 1 to ${LIMITS.testFolder} characters`), null);
  }
  const text = c.plain(`${at}.${kind}`, value, LIMITS.literal, `must be text of at most ${LIMITS.literal} characters, with no control characters`);
  if (text === null) return null;
  return kind === "literal" ? { name, literal: text } : { name, testLiteral: text };
}

