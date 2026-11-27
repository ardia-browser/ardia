import type { TabConsoleEntry, TabDiagnosticsRead, TabNetworkEntry } from "../../platform/control";
import { minimizedUrl } from "../../lib/urlParts";

export const DIAGNOSTIC_KINDS = ["all", "console", "network"] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

export const DEFAULT_DIAGNOSTICS_LIMIT = 200;
export const MAX_DIAGNOSTICS_LIMIT = 500;
export const MAX_MESSAGE_LENGTH = 1000;
export const REDACTED = "[redacted]";

export type ConsoleKind = "console" | "exception" | "rejection";

export type ConsoleRow = Omit<TabConsoleEntry, "clipped"> & { kind: ConsoleKind; clipped?: true };
export type NetworkRow = Omit<TabNetworkEntry, "failed" | "cached"> & { failed: boolean; cached?: true };

export type DiagnosticsQuery = { since: number; kind: DiagnosticKind; onlyErrors: boolean; limit: number };

export type DiagnosticsReply = { nextSeq: number; console: ConsoleRow[]; network: NetworkRow[]; dropped: number; more: boolean; capacity: { console: number; network: number } };

const SECRET_NAMES = "pass(?:word|wd|phrase)?|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|access[_-]?key|auth(?:orization)?|session(?:[_-]?id)?|sid|cookie|set-cookie|credentials?|client[_-]?secret|private[_-]?key|otp|code[_-]?verifier|signature|sig";
const NAMED_SECRET = new RegExp(String.raw`((?:["'])?\b(?:` + SECRET_NAMES + String.raw`)\b(?:["'])?\s*[:=]\s*)(?:"((?:[^"\\]|\\[\s\S]?)*)(?:"|$)|'((?:[^'\\]|\\[\s\S]?)*)(?:'|$)|((?:[^\s"',;&}\[\]]|\[[^\s"',;&}\[\]]*\]|\[)+))`, "gi");
const AUTH_SCHEMES = /^(?:Bearer|Basic|Token|Digest)$/i;
const ALREADY_REDACTED_QUOTED = /^(?:\[redacted\]|(?:Bearer|Basic|Token|Digest)\s+\[redacted\])$/i;
const COOKIE_PAIR_REDACTED = /^[^=;,\s]+=\[redacted\]$/i;
const SCHEME_TOKEN = /\b(Bearer|Basic|Token|Digest)\s+([A-Za-z0-9._~+/=-]+)/gi;
const AUTH_HEADER = new RegExp(String.raw`\b((?:Proxy-)?Authorization["']?\s*[:=]\s*)(?:"((?:[^"\\]|\\[\s\S]?)*)(?:"|$)|'((?:[^'\\]|\\[\s\S]?)*)(?:'|$)|([^\r\n]*))`, "gi");
const COOKIE_HEADER = /\b(Set-Cookie|Cookie)(\s*:\s*)([^\r\n]*)/gi;
const COOKIE_PAIR = /([^=;,\s]+)\s*=\s*("[^"]*"|[^;]*)/g;
const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const JWT_PART = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const SCHEME_LEAD = /[A-Za-z]/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const URL_STOPS = new Set([" ", "\t", "\n", "\r", "\f", "\v", '"', "'", "<", ">", "`"]);
const TRAILING_PROSE = /[.,;:!?]/;
const OPAQUE = /[A-Za-z0-9_+/=-]{24,}/g;
const USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i;

function decodedBase64(text: string): string | null {
  const body = text.replace(/=+$/, "");
  if (!body || /[^A-Za-z0-9+/]/.test(body) || body.length % 4 === 1) return null;
  let bits = 0;
  let value = 0;
  let out = "";
  for (const digit of body) {
    value = (value << 6) | BASE64_DIGITS.indexOf(digit);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}

function schemeCredential(scheme: string, value: string): boolean {
  const kind = scheme.toLowerCase();
  if (kind === "bearer") return true;
  if (kind === "basic") return (value.length >= 3 && (decodedBase64(value)?.includes(":") ?? false)) || (value.length >= 8 && /[0-9+/=]/.test(value));
  return value.length >= 6 && /[0-9._~+/=-]/.test(value);
}

function hiddenCredential(value: string): string {
  const scheme = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s+\S/.exec(value)?.[1];
  return scheme ? `${scheme} ${REDACTED}` : REDACTED;
}

function stopsUrl(char: string): boolean {
  return URL_STOPS.has(char) || /\s/.test(char);
}

function userInfoEnd(text: string, from: number): number {
  let round = 0;
  let square = 0;
  let at = -1;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (stopsUrl(char) || char === "/" || char === "?" || char === "#") break;
    if (char === "(") round++;
    else if (char === ")") {
      if (round === 0) break;
      round--;
    } else if (char === "[") square++;
    else if (char === "]") {
      if (square === 0) break;
      square--;
    } else if (char === "@" && round === 0 && square === 0) at = i;
  }
  return at < 0 ? from : at + 1;
}

function urlEnd(text: string, from: number): number {
  let round = 0;
  let square = 0;
  let i = userInfoEnd(text, from);
  for (; i < text.length; i++) {
    const char = text[i]!;
    if (stopsUrl(char)) break;
    if (char === "(") round++;
    else if (char === ")") {
      if (round === 0) break;
      round--;
    } else if (char === "[") square++;
    else if (char === "]") {
      if (square === 0) break;
      square--;
    }
  }
  while (i > from && TRAILING_PROSE.test(text[i - 1]!)) i--;
  return i;
}

function schemeStart(text: string, sep: number, floor: number): number {
  let i = sep;
  while (i > floor && SCHEME_CHAR.test(text[i - 1]!)) i--;
  while (i < sep && !SCHEME_LEAD.test(text[i]!)) i++;
  if (i === sep) return -1;
  if (i > 0 && WORD_CHAR.test(text[i - 1]!)) return -1;
  return i;
}

function redactUrlsIn(text: string, clipped = false): string {
  let out = "";
  let last = 0;
  let cursor = 0;
  let floor = 0;
  while (cursor < text.length) {
    const sep = text.indexOf("://", cursor);
    if (sep < 0) break;
    const start = schemeStart(text, sep, floor);
    const afterSep = sep + 3;
    floor = afterSep;
    cursor = afterSep;
    if (start < last) continue;
    const end = urlEnd(text, afterSep);
    if (end <= afterSep) continue;
    out += text.slice(last, start) + redactUrl(text.slice(start, end), clipped && end === text.length);
    last = end;
    cursor = end;
    floor = end;
  }
  return out + text.slice(last);
}

function looksSecret(piece: string): boolean {
  if (piece.length >= 32 && /^[0-9a-f]+$/i.test(piece)) return true;
  if (piece.length < 24) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((rule) => rule.test(piece)).length;
  return /[0-9]/.test(piece) && classes >= 2 && !/^[a-z]+(?:[-_][a-z0-9]+)+$/.test(piece);
}

function secretSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return JWT_PART.test(decoded) || decoded.split(/[-_.~]/).some(looksSecret) || looksSecret(decoded);
}

function validPort(port: string): boolean {
  return /^\d{1,5}$/.test(port) && Number(port) <= 65535;
}

export function redactUrl(url: string, clipped = false): string {
  if (typeof url !== "string" || !url) return "";
  const bare = minimizedUrl(url).replace(USER_INFO, "$1");
  const originMatch = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)/i.exec(bare);
  const origin = originMatch?.[0] ?? "";
  const path = bare.slice(origin.length);
  if (originMatch) {
    const scheme = originMatch[1]!;
    const authority = originMatch[2]!;
    if (!authority.startsWith("[")) {
      const colon = authority.indexOf(":");
      if (colon >= 0) {
        const afterColon = authority.slice(colon + 1);
        if (!validPort(afterColon) || (clipped && path === "")) return `${scheme}${REDACTED}`;
      }
    }
  }
  const shown = path
    .split("/")
    .map((segment) => (segment && secretSegment(segment) ? REDACTED : segment))
    .join("/");
  return origin + shown;
}

export function redactText(text: string, clipped = false): string {
  if (typeof text !== "string" || !text) return "";
  let out = text.replace(PRIVATE_KEY, REDACTED);
  out = redactUrlsIn(out, clipped);
  out = out.replace(AUTH_HEADER, (found, lead: string, double?: string, single?: string, bare?: string) => {
    if (double !== undefined) return `${lead}"${hiddenCredential(double)}"`;
    if (single !== undefined) return `${lead}'${hiddenCredential(single)}'`;
    return bare && bare.trim() ? `${lead}${hiddenCredential(bare)}` : found;
  });
  out = out.replace(COOKIE_HEADER, (_found, name: string, gap: string, value: string) => `${name}${gap}${value.replace(COOKIE_PAIR, (_pair, key: string) => `${key}=${REDACTED}`)}`);
  out = out.replace(SCHEME_TOKEN, (found, scheme: string, value: string) => (schemeCredential(scheme, value) ? `${scheme} ${REDACTED}` : found));
  out = out.replace(JWT, REDACTED);
  out = out.replace(NAMED_SECRET, (found, lead: string, double?: string, single?: string, bare?: string) => {
    const quoted = double ?? single;
    if (quoted !== undefined) {
      if (ALREADY_REDACTED_QUOTED.test(quoted.trim())) return found;
      return double !== undefined ? `${lead}"${REDACTED}"` : `${lead}'${REDACTED}'`;
    }
    if (bare === undefined || AUTH_SCHEMES.test(bare) || bare === REDACTED || (/cookie/i.test(lead) && COOKIE_PAIR_REDACTED.test(bare))) return found;
    return `${lead}${REDACTED}`;
  });
  out = out.replace(OPAQUE, (found) => (found.includes(REDACTED) || !looksSecret(found.replace(/[+/=]/g, "")) ? found : REDACTED));
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : out;
}

export function consoleKind(entry: Pick<TabConsoleEntry, "level" | "message">): ConsoleKind {
  if (entry.level !== "error") return "console";
  if (entry.message.startsWith("Uncaught (in promise)")) return "rejection";
  if (entry.message.startsWith("Uncaught ")) return "exception";
  return "console";
}

const finite = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function consoleRow(entry: TabConsoleEntry): ConsoleRow {
  const message = typeof entry.message === "string" ? entry.message : "";
  const level = (["debug", "info", "warning", "error"] as const).includes(entry.level) ? entry.level : "info";
  return {
    seq: finite(entry.seq),
    time: finite(entry.time),
    level,
    kind: consoleKind({ level, message }),
    message: redactText(message, entry.clipped === true),
    source: redactUrl(entry.source),
    line: finite(entry.line),
    frame: entry.frame === "sub" ? "sub" : "main",
    ...(entry.clipped ? { clipped: true as const } : {}),
  };
}

function networkRow(entry: TabNetworkEntry): NetworkRow {
  return {
    seq: finite(entry.seq),
    time: finite(entry.time),
    method: typeof entry.method === "string" ? entry.method.slice(0, 16) : "GET",
    url: redactUrl(entry.url),
    status: finite(entry.status),
    type: typeof entry.type === "string" ? entry.type.slice(0, 32) : "other",
    frame: entry.frame === "sub" ? "sub" : "main",
    ...(typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) ? { durationMs: entry.durationMs } : {}),
    ...(typeof entry.error === "string" ? { error: entry.error.slice(0, 64) } : {}),
    failed: !!entry.failed,
    ...(entry.cached ? { cached: true as const } : {}),
  };
}

const isProblem = (row: ConsoleRow | NetworkRow) => ("level" in row ? row.level === "warning" || row.level === "error" : row.failed);

export function droppedSince(read: Pick<TabDiagnosticsRead, "console" | "network" | "nextSeq" | "clearedBefore">, since: number, until = finite(read.nextSeq, 1)): number {
  const from = Math.max(since, finite(read.clearedBefore, 1), 1);
  const end = Math.min(until, finite(read.nextSeq, 1));
  const inRange = (e: { seq: number }) => e.seq >= from && e.seq < end;
  const kept = read.console.filter(inRange).length + read.network.filter(inRange).length;
  return Math.max(0, end - from - kept);
}

export function shapeDiagnostics(read: TabDiagnosticsRead, query: DiagnosticsQuery, fits: <T>(rows: readonly T[]) => T[] = (rows) => [...rows]): DiagnosticsReply {
  const since = Math.max(0, Math.floor(query.since));
  const wantsConsole = query.kind !== "network";
  const wantsNetwork = query.kind !== "console";
  const rows: (ConsoleRow | NetworkRow)[] = [
    ...(wantsConsole ? read.console.filter((e) => e.seq >= since).map(consoleRow) : []),
    ...(wantsNetwork ? read.network.filter((e) => e.seq >= since).map(networkRow) : []),
  ]
    .filter((row) => !query.onlyErrors || isProblem(row))
    .sort((a, b) => a.seq - b.seq);
  const limit = Math.min(Math.max(1, Math.floor(query.limit)), MAX_DIAGNOSTICS_LIMIT);
  const shown = fits(rows.slice(0, limit));
  const more = shown.length < rows.length;
  const nextSeq = more && shown.length ? shown[shown.length - 1]!.seq + 1 : more ? since : Math.max(since, finite(read.nextSeq, 1));
  return {
    nextSeq,
    console: shown.filter((row): row is ConsoleRow => "level" in row),
    network: shown.filter((row): row is NetworkRow => !("level" in row)),
    dropped: droppedSince(read, since, nextSeq),
    more,
    capacity: { console: finite(read.capacity?.console), network: finite(read.capacity?.network) },
  };
}
