import { CREDENTIAL_LIMITS } from "./credentialConstants";
import { isRecord, utf8Length } from "./credentialData";
import type { CredentialVerb } from "./credentialManifestTypes";
import type { FakeReply } from "./credentialTypes";

export type FakeOutcome = { launched: boolean; cancelled: boolean; reply: FakeReply };

export type FakeOutput = { body: Record<string, unknown>; notices: Record<string, unknown>[]; lastLine: string | null; succeeded: boolean; hints: string[] };

const ESCAPE_CODES = /\x1B\[[0-9;?]*[A-Za-z]/g;
const LOG_PREFIX = /^\[[A-Za-z]+\]\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/;
const MOST_JSON_STARTS = 64;
const NOISE_SCAN_BYTES = 64 << 10;
const HIDDEN = "[hidden]";

export function cleanStderr(text: string): string {
  const cleaned = text
    .replace(ESCAPE_CODES, "")
    .split("\n")
    .map((line) => line.replace(LOG_PREFIX, ""))
    .join("\n");
  return cleaned.length > CREDENTIAL_LIMITS.stderrBytes ? cleaned.slice(0, CREDENTIAL_LIMITS.stderrBytes) : cleaned;
}

export function tolerantJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  const closing = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (closing < 0) return undefined;
  let tried = 0;
  for (let start = 0; start < Math.min(closing, NOISE_SCAN_BYTES); start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    try {
      return JSON.parse(text.slice(start, closing + 1));
    } catch {}
    if (++tried >= MOST_JSON_STARTS) break;
  }
  return undefined;
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(HIDDEN);
  return out;
}

export function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return value;
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry, secrets)]));
  return value;
}

export const redactable = (values: readonly string[], least: number) => [...new Set(values.filter((value) => value.length >= least))].sort((a, b) => b.length - a.length);

function matchedHints(verb: CredentialVerb, stderr: string): string[] {
  const lowered = stderr.toLowerCase();
  return Object.entries(verb.hints)
    .filter(([, needles]) => needles.some((needle) => lowered.includes(needle.toLowerCase())))
    .map(([hint]) => hint);
}

function splitItems(verb: CredentialVerb, parsed: unknown): { array: unknown[] | null; container: unknown } {
  const key = verb.output.items;
  if (key === undefined) return { array: null, container: parsed };
  if (key === "$") return Array.isArray(parsed) ? { array: parsed, container: [] } : { array: null, container: parsed ?? null };
  if (isRecord(parsed) && Array.isArray(parsed[key])) return { array: parsed[key] as unknown[], container: { ...parsed, [key]: [] } };
  return { array: null, container: parsed ?? null };
}

function jsonOutput(verb: CredentialVerb, stdout: string, consumed: readonly string[], verbOf: number, notices: Record<string, unknown>[]) {
  const parsed = stdout.trim() ? tolerantJson(stdout) : undefined;
  const { array, container } = splitItems(verb, parsed === undefined ? null : parsed);
  if (array?.some((element) => utf8Length(JSON.stringify(element) ?? "") > CREDENTIAL_LIMITS.outputItemBytes)) return { overflowed: true, json: null, items: 0, parts: 0 };
  array?.forEach((element, index) => notices.push({ verbOf, item: redactJson(element, consumed), index }));
  const json = redactJson(container, consumed);
  const encoded = JSON.stringify(json);
  if (encoded.length <= CREDENTIAL_LIMITS.chunkBytes) return { overflowed: false, json, items: array?.length ?? 0, parts: 0 };
  let parts = 0;
  for (let start = 0; start < encoded.length; start += CREDENTIAL_LIMITS.chunkBytes, parts++) notices.push({ verbOf, part: encoded.slice(start, start + CREDENTIAL_LIMITS.chunkBytes) });
  return { overflowed: false, json: null, items: array?.length ?? 0, parts };
}

export function fakeOutput(verb: CredentialVerb, verbOf: number, outcome: FakeOutcome, consumed: readonly string[], jsonStrings: readonly string[]): FakeOutput {
  const { reply, launched, cancelled } = outcome;
  const timedOut = !cancelled && reply.timedOut === true;
  const status = !launched || cancelled || timedOut ? -1 : (reply.status ?? 0);
  const rawStderr = cancelled ? "" : (reply.stderr ?? "");
  const stdout = cancelled || timedOut ? "" : (reply.stdout ?? "");
  const secrets = redactable(consumed, 3);
  const notices: Record<string, unknown>[] = [];
  let overflowed = utf8Length(stdout) > verb.outputLimitBytes;
  let json: unknown = null;
  let lines: string[] = [];
  let items = 0;
  let parts = 0;
  let lastLine: string | null = null;
  if (!overflowed && launched && !cancelled) {
    const mode = verb.output.mode;
    if (mode === "json") ({ overflowed, json, items, parts } = jsonOutput(verb, stdout, secrets, verbOf, notices));
    else if (mode === "lines") {
      lines = stdout.split("\n").map((line) => redactText(line.replace(/\r$/, ""), secrets));
      if (lines.at(-1) === "") lines.pop();
    } else if (mode === "lastLineSecret") {
      const last = stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      lastLine = /^\S{16,4096}$/.test(last) ? last : null;
    }
  }
  const succeeded = launched && !cancelled && !timedOut && !overflowed && status === 0;
  const stderr = redactText(cleanStderr(rawStderr), redactable([...consumed, ...jsonStrings.filter((text) => text.length >= 6)], 3));
  const hints = matchedHints(verb, rawStderr);
  const body = { verb: "", status, launched, timedOut, cancelled, overflowed, succeeded, stderr, hints, json, parts, lines, items, droppedLines: 0 };
  return { body, notices, lastLine, succeeded, hints };
}
