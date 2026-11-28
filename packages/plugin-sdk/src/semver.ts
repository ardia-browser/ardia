export type SemVer = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
};

export type Comparator = { readonly op: "<" | "<=" | ">" | ">=" | "="; readonly version: SemVer };

export type Range = { readonly source: string; readonly sets: readonly (readonly Comparator[])[] };

export type RangeOptions = { bareExact?: boolean };

export type SatisfyOptions = { includePrerelease?: boolean } & RangeOptions;

const NUMERIC = "0|[1-9]\\d{0,8}";
const IDENT = "(?:0|[1-9]\\d{0,8}|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const STRICT = new RegExp(`^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${IDENT}(?:\\.${IDENT})*))?$`);
const PART = "(?:0|[1-9]\\d{0,8}|[xX*])";
const PARTIAL = new RegExp(`^v?(${PART})(?:\\.(${PART})(?:\\.(${PART})(?:-(${IDENT}(?:\\.${IDENT})*))?)?)?$`);
const MAX_LENGTH = 256;
export const MAX_VERSION_PART = 999_999_999;

const toPart = (text: string): number | null => {
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= MAX_VERSION_PART ? value : null;
};

const prereleaseOf = (text: string | undefined): (string | number)[] =>
  text ? text.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];

export function parseSemver(text: unknown): SemVer | null {
  if (typeof text !== "string" || text.length > MAX_LENGTH) return null;
  const match = STRICT.exec(text);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map((p) => toPart(p ?? ""));
  if (major === null || minor === null || patch === null || major === undefined || minor === undefined || patch === undefined) return null;
  const prerelease = prereleaseOf(match[4]);
  if (prerelease.some((id) => typeof id === "number" && !Number.isSafeInteger(id))) return null;
  return { major, minor, patch, prerelease };
}

export const isSemver = (text: unknown): text is string => parseSemver(text) !== null;

export function formatSemver(version: SemVer): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const pre = version.prerelease.length ? `-${version.prerelease.join(".")}` : "";
  return core + pre;
}

function compareIds(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIds(left, right);
    if (order) return order;
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Can't compare ${a} and ${b}: both must be semver versions.`);
  return compareSemver(left, right);
}

const version = (major: number, minor: number, patch: number, prerelease: readonly (string | number)[] = []): SemVer => ({ major, minor, patch, prerelease });
const floor = (major: number, minor: number, patch: number) => version(major, minor, patch, [0]);

type Partial = { major: number | null; minor: number | null; patch: number | null; prerelease: (string | number)[] };

function parsePartial(text: string): Partial | null {
  const match = PARTIAL.exec(text);
  if (!match) return null;
  const part = (p: string | undefined) => (p === undefined || /^[xX*]$/.test(p) ? null : toPart(p));
  const major = part(match[1]);
  const minor = part(match[2]);
  const patch = part(match[3]);
  if ((major === null && minor !== null) || (minor === null && patch !== null)) return null;
  if (match[4] && patch === null) return null;
  return { major, minor, patch, prerelease: prereleaseOf(match[4]) };
}

const ANY: Comparator[] = [];
const NOTHING: Comparator[] = [{ op: "<", version: floor(0, 0, 0) }];

function exact(p: Partial): SemVer {
  return version(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.prerelease);
}

function caret(p: Partial): Comparator[] {
  if (p.major === null) return ANY;
  const low: Comparator = { op: ">=", version: exact(p) };
  if (p.minor === null) return [low, { op: "<", version: floor(p.major + 1, 0, 0) }];
  if (p.major > 0) return [low, { op: "<", version: floor(p.major + 1, 0, 0) }];
  if (p.patch === null || p.minor > 0) return [low, { op: "<", version: floor(0, p.minor + 1, 0) }];
  return [low, { op: "<", version: floor(0, 0, p.patch + 1) }];
}

function tilde(p: Partial): Comparator[] {
  if (p.major === null) return ANY;
  const low: Comparator = { op: ">=", version: exact(p) };
  if (p.minor === null) return [low, { op: "<", version: floor(p.major + 1, 0, 0) }];
  return [low, { op: "<", version: floor(p.major, p.minor + 1, 0) }];
}

function xRange(p: Partial): Comparator[] {
  if (p.major === null) return ANY;
  if (p.minor === null) return [{ op: ">=", version: version(p.major, 0, 0) }, { op: "<", version: floor(p.major + 1, 0, 0) }];
  return [{ op: ">=", version: version(p.major, p.minor, 0) }, { op: "<", version: floor(p.major, p.minor + 1, 0) }];
}

function primitive(op: Comparator["op"], p: Partial): Comparator[] {
  const complete = p.patch !== null;
  if (complete || op === "=") return complete ? [{ op, version: exact(p) }] : xRange(p);
  if (p.major === null) return op === "<" || op === ">" ? NOTHING : ANY;
  const nextMinor = p.minor === null ? floor(p.major + 1, 0, 0) : floor(p.major, p.minor + 1, 0);
  const base = version(p.major, p.minor ?? 0, 0);
  if (op === ">=") return [{ op: ">=", version: base }];
  if (op === "<") return [{ op: "<", version: version(base.major, base.minor, 0, [0]) }];
  if (op === ">") return [{ op: ">=", version: version(nextMinor.major, nextMinor.minor, 0) }];
  return [{ op: "<", version: nextMinor }];
}

function comparatorsOf(token: string, options: RangeOptions): Comparator[] | null {
  const match = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!match) return null;
  const op = match[1];
  const p = parsePartial(match[2] ?? "");
  if (!p) return null;
  if (op === "^") return caret(p);
  if (op === "~" || op === "~>") return tilde(p);
  if (op === undefined) {
    if (p.major !== null && p.minor !== null && p.patch !== null) return [{ op: options.bareExact ? "=" : ">=", version: exact(p) }];
    if (p.major !== null && match[2]?.split(".").every((part) => !/[xX*]/.test(part))) return [{ op: ">=", version: exact(p) }];
    return xRange(p);
  }
  return primitive(op as Comparator["op"], p);
}

function hyphen(low: string, high: string): Comparator[] | null {
  const from = parsePartial(low);
  const to = parsePartial(high);
  if (!from || !to) return null;
  const lower: Comparator[] = from.major === null ? [] : [{ op: ">=", version: exact(from) }];
  if (to.major === null) return lower;
  if (to.patch !== null) return [...lower, { op: "<=", version: exact(to) }];
  return [...lower, ...primitive("<=", to)];
}

function parseSet(text: string, options: RangeOptions): Comparator[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const hyphenMatch = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphenMatch) return hyphen(hyphenMatch[1] ?? "", hyphenMatch[2] ?? "");
  const tokens = trimmed.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/);
  const out: Comparator[] = [];
  for (const token of tokens) {
    const comparators = comparatorsOf(token, options);
    if (!comparators) return null;
    out.push(...comparators);
  }
  return out;
}

export function parseRange(text: unknown, options: RangeOptions = {}): Range | null {
  if (typeof text !== "string" || text.length > MAX_LENGTH || /[\u0000-\u001f]/.test(text)) return null;
  const sets: Comparator[][] = [];
  for (const part of text.split("||")) {
    const set = parseSet(part, options);
    if (!set) return null;
    sets.push(set);
  }
  return { source: text, sets };
}

export const isRange = (text: unknown): text is string => parseRange(text) !== null;

function test(comparator: Comparator, target: SemVer): boolean {
  const order = compareSemver(target, comparator.version);
  switch (comparator.op) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    default:
      return order === 0;
  }
}

function setAllows(set: readonly Comparator[], target: SemVer, options: SatisfyOptions): boolean {
  if (!set.every((c) => test(c, target))) return false;
  if (!target.prerelease.length || options.includePrerelease) return true;
  return set.some(
    (c) =>
      c.version.prerelease.length > 0 &&
      !(c.version.prerelease.length === 1 && c.version.prerelease[0] === 0 && c.op === "<") &&
      c.version.major === target.major &&
      c.version.minor === target.minor &&
      c.version.patch === target.patch,
  );
}

export function satisfies(target: string | SemVer, range: string | Range, options: SatisfyOptions = {}): boolean {
  const parsedVersion = typeof target === "string" ? parseSemver(target) : target;
  const parsedRange = typeof range === "string" ? parseRange(range, options) : range;
  if (!parsedVersion || !parsedRange) return false;
  return parsedRange.sets.some((set) => setAllows(set, parsedVersion, options));
}

export function maxSatisfying(versions: readonly string[], range: string | Range, options: SatisfyOptions = {}): string | null {
  const parsedRange = typeof range === "string" ? parseRange(range) : range;
  if (!parsedRange) return null;
  let best: { text: string; version: SemVer } | null = null;
  for (const text of versions) {
    const parsed = parseSemver(text);
    if (!parsed || !satisfies(parsed, parsedRange, options)) continue;
    if (!best || compareSemver(parsed, best.version) > 0) best = { text, version: parsed };
  }
  return best?.text ?? null;
}

export function sortVersions(versions: readonly string[], order: "asc" | "desc" = "asc"): string[] {
  const parsed = versions.flatMap((text) => {
    const v = parseSemver(text);
    return v ? [{ text, v }] : [];
  });
  parsed.sort((a, b) => compareSemver(a.v, b.v) * (order === "asc" ? 1 : -1));
  return parsed.map((entry) => entry.text);
}
