export const MAX_MAP_BYTES = 10 * 1024 * 1024;
export const MAX_MAPS_PER_CALL = 16;
export const MAX_SOURCE_PATH = 2048;
const MAX_SEGMENTS = 1_000_000;
const MAX_LINES = 200_000;
const MAX_SECTIONS = 64;

type Segment = [number, number, number, number, number];

export type ParsedMap = { sources: string[]; names: string[]; lines: Segment[][]; sections: { line: number; column: number; map: ParsedMap }[] | null };
export type Original = { source: string; line: number; column: number; name: string | null };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...B64].map((c, i) => [c, i]));

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v.slice(0, 4096) : "")) : []);

function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let source = 0, srcLine = 0, srcCol = 0, name = 0, count = 0, lineCount = 0;
  let i = 0;
  while (i < mappings.length) {
    const c = mappings[i]!;
    if (c === ";") {
      if (++lineCount > MAX_LINES) throw new Error("too many lines");
      lines.push(line);
      line = [];
      i++;
      continue;
    }
    if (c === ",") {
      i++;
      continue;
    }
    const fields: number[] = [];
    while (i < mappings.length && mappings[i] !== "," && mappings[i] !== ";") {
      let value = 0, shift = 0, more = true;
      while (more) {
        const digit = DIGIT.get(mappings[i++] ?? "");
        if (digit === undefined || shift > 30) throw new Error("bad mappings");
        more = (digit & 32) !== 0;
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      }
      fields.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    }
    if (++count > MAX_SEGMENTS) throw new Error("too many mappings");
    if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) throw new Error("bad segment");
    const prev = line[line.length - 1];
    const column = (prev ? prev[0] : 0) + fields[0]!;
    if (column < 0) throw new Error("negative column");
    if (fields.length === 1) {
      line.push([column, -1, -1, -1, -1]);
      continue;
    }
    source += fields[1]!;
    srcLine += fields[2]!;
    srcCol += fields[3]!;
    if (fields.length === 5) name += fields[4]!;
    if (source < 0 || srcLine < 0 || srcCol < 0 || name < 0) throw new Error("negative position");
    line.push([column, source, srcLine, srcCol, fields.length === 5 ? name : -1]);
  }
  lines.push(line);
  for (const l of lines) l.sort((a, b) => a[0] - b[0]);
  return lines;
}

export function parseSourceMap(raw: unknown, depth = 0): ParsedMap | null {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  if (!isFields(value) || value.version !== 3) return null;
  if (Array.isArray(value.sections)) {
    if (depth > 0) return null;
    const sections: NonNullable<ParsedMap["sections"]> = [];
    if (value.sections.length > MAX_SECTIONS) return null;
    for (const section of value.sections) {
      const offset = isFields(section) && isFields(section.offset) ? section.offset : null;
      const map = isFields(section) ? parseSourceMap(section.map, depth + 1) : null;
      const line = typeof offset?.line === "number" && Number.isSafeInteger(offset.line) && offset.line >= 0 ? offset.line : null;
      const column = typeof offset?.column === "number" && Number.isSafeInteger(offset.column) && offset.column >= 0 ? offset.column : null;
      if (!map || line === null || column === null) return null;
      sections.push({ line, column, map });
    }
    return { sources: [], names: [], lines: [], sections };
  }
  if (typeof value.mappings !== "string") return null;
  const root = typeof value.sourceRoot === "string" && value.sourceRoot && value.sourceRoot.length <= MAX_SOURCE_PATH ? value.sourceRoot.replace(/\/?$/, "/") : "";
  try {
    return { sources: strings(value.sources).map((s) => (root && !/^[a-z]+:/i.test(s) ? root + s : s).slice(0, MAX_SOURCE_PATH)), names: strings(value.names), lines: decodeMappings(value.mappings), sections: null };
  } catch {
    return null;
  }
}

function safeJson(raw: string): unknown {
  if (raw.length > MAX_MAP_BYTES) return null;
  try {
    return JSON.parse(raw.replace(/^\)\]\}'[^\n]*\n/, ""));
  } catch {
    return null;
  }
}

export function originalPositionFor(map: ParsedMap, line0: number, column0: number): Original | null {
  if (map.sections) {
    let chosen: (typeof map.sections)[number] | null = null;
    for (const section of map.sections) if (section.line < line0 || (section.line === line0 && section.column <= column0)) chosen = section;
    if (!chosen) return null;
    return originalPositionFor(chosen.map, line0 - chosen.line, line0 === chosen.line ? column0 - chosen.column : column0);
  }
  const segments = map.lines[line0];
  if (!segments?.length) return null;
  let lo = 0, hi = segments.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]![0] <= column0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const segment = found >= 0 ? segments[found]! : null;
  if (!segment || segment[1] < 0) return null;
  const source = map.sources[segment[1]];
  if (source === undefined) return null;
  return { source, line: segment[2] + 1, column: segment[3] + 1, name: segment[4] >= 0 ? (map.names[segment[4]] ?? null) : null };
}

const sourceMatches = (source: string, wanted: string) => source === wanted || source.endsWith(`/${wanted.replace(/^\.?\//, "")}`);

export function generatedPositionFor(map: ParsedMap, wanted: string, line1: number, column1: number | null): { line: number; column: number } | null {
  if (map.sections) {
    for (const section of map.sections) {
      const inner = generatedPositionFor(section.map, wanted, line1, column1);
      if (inner) return { line: inner.line + section.line, column: inner.line === 0 ? inner.column + section.column : inner.column };
    }
    return null;
  }
  const indexes = new Set(map.sources.flatMap((s, i) => (sourceMatches(s, wanted) ? [i] : [])));
  if (!indexes.size) return null;
  let best: { line: number; column: number; srcCol: number } | null = null;
  for (const [genLine, segments] of map.lines.entries()) {
    for (const segment of segments) {
      if (!indexes.has(segment[1]) || segment[2] !== line1 - 1) continue;
      if (column1 !== null && segment[3] < column1 - 1) continue;
      if (!best || segment[3] < best.srcCol || (segment[3] === best.srcCol && (genLine < best.line || (genLine === best.line && segment[0] < best.column)))) best = { line: genLine, column: segment[0], srcCol: segment[3] };
    }
  }
  return best ? { line: best.line, column: best.column } : null;
}

const MARKER = "sourceMappingURL=";
const DIRECTIVE_LEAD = /(?:\/\/|\/\*)[ \t]{0,16}[#@][ \t]{0,16}$/;
const MAP_REF = /^[^\s'"`]+$/;
const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*)/;

function directiveOf(line: string): string | null {
  const trimmed = line.trimEnd();
  const at = trimmed.lastIndexOf(MARKER);
  if (at < 0 || !DIRECTIVE_LEAD.test(trimmed.slice(Math.max(0, at - 40), at))) return null;
  let ref = trimmed.slice(at + MARKER.length);
  if (ref.endsWith("*/")) ref = ref.slice(0, -2).trimEnd();
  return ref && MAP_REF.test(ref) ? ref : null;
}

export function sourceMapRefOf(script: string): string | null {
  let end = script.length;
  while (end > 0) {
    const start = script.lastIndexOf("\n", end - 1) + 1;
    const line = script.slice(start, end);
    end = start - 1;
    if (!line.trim()) continue;
    const ref = directiveOf(line);
    if (ref) return ref;
    if (!COMMENT_ONLY.test(line) || line.includes("`")) return null;
  }
  return null;
}

export const isDataUrl = (value: string) => /^data:/i.test(value);

const INLINE_MAP = /^data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)$/i;

export function inlineMapText(ref: string): string | null {
  const inline = INLINE_MAP.exec(ref);
  if (!inline || inline[1]!.length > (MAX_MAP_BYTES * 4) / 3) return null;
  try {
    return decodeBase64Utf8(inline[1]!);
  } catch {
    return null;
  }
}

function decodeBase64Utf8(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export type MapFailure = { url: string; reason: "no-map" | "not-inline" | "bad-map" | "limit" };

export type MapSources = { maps?: Readonly<Record<string, unknown>>; scripts?: Readonly<Record<string, unknown>> };

export class SourceMapResolver {
  private maps = new Map<string, ParsedMap | null>();
  private scripts = new Map<string, string>();
  private loads = 0;
  readonly failures: MapFailure[] = [];

  constructor(sources: MapSources = {}) {
    for (const [url, raw] of Object.entries(sources.maps ?? {}).slice(0, MAX_MAPS_PER_CALL)) {
      const text = typeof raw === "string" && isDataUrl(raw) ? inlineMapText(raw) : raw;
      this.maps.set(url, text === null ? null : parseSourceMap(text));
      if (this.maps.get(url) === null) this.failures.push({ url: url.slice(0, 2048), reason: "bad-map" });
    }
    for (const [url, raw] of Object.entries(sources.scripts ?? {}).slice(0, MAX_MAPS_PER_CALL)) if (typeof raw === "string") this.scripts.set(url, raw);
  }

  get resolvedCount() {
    return [...this.maps.values()].filter((m) => m !== null).length;
  }

  private fail(url: string, reason: MapFailure["reason"]) {
    if (!this.failures.some((f) => f.url === url)) this.failures.push({ url: url.slice(0, 2048), reason });
    this.maps.set(url, null);
    return null;
  }

  mapFor(scriptUrl: string, mapRef: string | null = null): ParsedMap | null {
    if (this.maps.has(scriptUrl)) return this.maps.get(scriptUrl)!;
    const script = this.scripts.get(scriptUrl);
    const ref = mapRef ?? (script === undefined ? null : sourceMapRefOf(script));
    if (!ref) return this.fail(scriptUrl, "no-map");
    if (!isDataUrl(ref)) return this.fail(scriptUrl, "not-inline");
    if (++this.loads > MAX_MAPS_PER_CALL) return this.fail(scriptUrl, "limit");
    const text = inlineMapText(ref);
    const parsed = text === null ? null : parseSourceMap(text);
    if (!parsed) return this.fail(scriptUrl, "bad-map");
    this.maps.set(scriptUrl, parsed);
    return parsed;
  }
}
