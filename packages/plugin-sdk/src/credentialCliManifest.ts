import { Checks, isFields, KEY, KEY_RULE, P, type Fields } from "./credentialManifestChecks";
import { envOf } from "./credentialEnvManifest";
import type { CredentialCli, CredentialVerb, LockParamSource } from "./credentialManifestTypes";
import { verbOf } from "./credentialVerbManifest";

const CLI = `${P}.cli`;
const PROGRAM = /^[a-z][a-z0-9._-]{0,31}$/;
const VERSION = /^\d{1,6}(\.\d{1,6}){1,3}$/;
const VERB_ID = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){0,3}$/;
const LIMITS = { patterns: 8, pattern: 200, literal: 256, verbs: 48, verbId: 48, install: 200, url: 2048 } as const;

function isSafeRegex(source: string): boolean {
  if (source.length < 1 || source.length > LIMITS.pattern || !source.startsWith("^") || !source.endsWith("$")) return false;
  if (/\\[1-9]|\\k<|\(\?[=!]|\(\?<[=!]/.test(source)) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function patternsOf(c: Checks, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const doc = c.object(`${CLI}.patterns`, value);
  if (!doc) return {};
  const entries = Object.entries(doc);
  if (entries.length > LIMITS.patterns) c.add(`${CLI}.patterns must be an object of at most ${LIMITS.patterns} patterns`);
  const out: Record<string, string> = {};
  for (const [key, source] of entries.slice(0, LIMITS.patterns)) {
    if (!KEY.test(key)) c.add(`${CLI}.patterns: ${key} isn't a pattern name of ${KEY_RULE}`);
    else if (typeof source !== "string" || !isSafeRegex(source)) c.add(`${CLI}.patterns.${key} must be a regular expression of 1 to ${LIMITS.pattern} characters that starts with ^ and ends with $`);
    else out[key] = source;
  }
  return out;
}

function installOf(c: Checks, value: unknown): CredentialCli["install"] {
  const doc = c.object(`${CLI}.install`, value);
  if (!doc) return { command: "" };
  c.only(`${CLI}.install`, doc, ["command", "update", "url"]);
  const command = c.text(`${CLI}.install.command`, doc.command, LIMITS.install) ?? "";
  const update = c.text(`${CLI}.install.update`, doc.update, LIMITS.install, false);
  const url = doc.url === undefined ? null : typeof doc.url === "string" && /^https:\/\/[^/?#@\s]+/i.test(doc.url) && doc.url.length <= LIMITS.url && !/\s/.test(doc.url) ? doc.url : (c.add(`${CLI}.install.url must be an https address`), null);
  return { command, ...(update ? { update } : {}), ...(url ? { url } : {}) };
}

function lockSourceOf(value: unknown): LockParamSource | null {
  if (!isFields(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys === "from" && value.from === "session") return { from: "session" };
  if (keys === "from,key" && value.from === "preference" && typeof value.key === "string" && KEY.test(value.key)) return { from: "preference", key: value.key };
  if (keys === "literal" && typeof value.literal === "string" && value.literal.length <= LIMITS.literal) return { literal: value.literal };
  return null;
}

function onLockOf(c: Checks, value: unknown, verbs: Readonly<Record<string, CredentialVerb>>): CredentialCli["onLock"] {
  if (value === undefined) return null;
  const path = `${CLI}.onLock`;
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, ["verb", "params", "skipWithTouchID"]);
  const verb = typeof doc.verb === "string" && Object.hasOwn(verbs, doc.verb) ? verbs[doc.verb]! : null;
  if (!verb) c.add(`${path}.verb: ${String(doc.verb)} isn't one of ${CLI}.verbs`);
  const params: Record<string, LockParamSource> = {};
  const given = doc.params === undefined ? {} : (c.object(`${path}.params`, doc.params) ?? {});
  for (const [slot, source] of Object.entries(given)) {
    const parsed = lockSourceOf(source);
    if (!parsed) c.add(`${path}.params.${slot} must be { from: session }, { from: preference, key } or { literal }`);
    else if (verb && !Object.hasOwn(verb.slots, slot)) c.add(`${path}.params.${slot}: ${slot} isn't a slot of ${String(doc.verb)}`);
    else params[slot] = parsed;
  }
  const skipWithTouchID = c.flag(`${path}.skipWithTouchID`, doc.skipWithTouchID, false);
  return verb ? { verb: doc.verb as string, params, skipWithTouchID } : null;
}

function verbsOf(c: Checks, value: unknown, program: string, patterns: Readonly<Record<string, string>>, cliNames: ReadonlySet<string>): Record<string, CredentialVerb> {
  const doc = isFields(value) ? value : null;
  const ids = doc ? Object.keys(doc) : [];
  if (!doc || ids.length < 1 || ids.length > LIMITS.verbs) {
    c.add(`${CLI}.verbs must be an object of 1 to ${LIMITS.verbs} verbs`);
    if (!doc) return {};
  }
  const out: Record<string, CredentialVerb> = {};
  for (const id of ids.slice(0, LIMITS.verbs)) {
    if (!VERB_ID.test(id) || id.length > LIMITS.verbId) {
      c.add(`${CLI}.verbs: ${id} isn't a verb id, like list.items`);
      continue;
    }
    const verb = verbOf(c, `${CLI}.verbs.${id}`, doc![id], { program, patterns, cliNames });
    if (verb) out[id] = verb;
  }
  return out;
}

export function cliOf(c: Checks, value: unknown): CredentialCli | null {
  const doc: Fields | null = isFields(value) ? value : null;
  if (!doc) return (c.add(`${CLI} must be an object`), null);
  c.only(CLI, doc, ["name", "install", "minimumVersion", "patterns", "env", "onLock", "verbs"]);
  const name = c.matching(`${CLI}.name`, doc.name, PROGRAM, "a program name, like bw");
  const install = installOf(c, doc.install);
  const minimumVersion = c.matching(`${CLI}.minimumVersion`, doc.minimumVersion, VERSION, "a version, like 2024.6.0", false);
  const patterns = patternsOf(c, doc.patterns);
  const env = envOf(c, `${CLI}.env`, doc.env, { inCli: true, secretSlots: new Set(), cliNames: new Set() });
  const patternNames = Object.fromEntries((isFields(doc.patterns) ? Object.keys(doc.patterns) : []).map((key) => [key, patterns[key] ?? ""]));
  const verbs = verbsOf(c, doc.verbs, name ?? "", patternNames, new Set(env.map((e) => e.name)));
  const onLock = onLockOf(c, doc.onLock, verbs);
  return name ? { name, install, minimumVersion, patterns, env, onLock, verbs } : null;
}
