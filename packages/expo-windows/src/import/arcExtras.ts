import type { ArcArchive, ArcArchivedTab, ArcLinkDestination, ArcLinkRule, ArcRouting } from "@ardia/import";
import { ImportFailure, isWebUrl, type Favicon } from "./model";

type Json = Record<string, unknown>;

export const ARC_ROUTING_FILE = "StorableLinkRouting.json";
export const ARC_ARCHIVE_FILE = "StorableArchiveItems.json";
export const ARC_ICON_CACHE = "SidebarItemsFaviconCache";
export const MAXIMUM_ARCHIVED = 1_500;
export const MAXIMUM_RULES = 1_000;
export const ROUTING_BYTES = 4 << 20;
export const ARCHIVE_BYTES = 64 << 20;
const MAXIMUM_ARCHIVE_ITEMS = 50_000;
const MAXIMUM_TEXT = 2_048;
const MAXIMUM_ID = 128;
const MAXIMUM_URL = 8_192;
const MAXIMUM_TITLE = 1_024;
const APPLE_EPOCH_SECONDS = 978_307_200;
const MAXIMUM_PAGES = 1000;
const MAXIMUM_PNG_BYTES = 16 * 1024;
const MAXIMUM_TOTAL_BYTES = 6 * 1024 * 1024;
const PNG_BASE64_PREFIX = "iVBORw0KGgo";

export const THRESHOLD_MINUTES: Readonly<Record<string, number>> = {
  twelveHours: 12 * 60,
  twentyFourHours: 24 * 60,
  sevenDays: 7 * 24 * 60,
  thirtyDays: 30 * 24 * 60,
};

const record = (value: unknown): Json | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined);
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record).filter((v): v is Json => v !== undefined) : []);
const nonEmpty = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

function parsed(raw: string, file: string, what: string): Json {
  let top: unknown;
  try {
    top = JSON.parse(raw);
  } catch {
    top = undefined;
  }
  const root = record(top);
  if (!root) throw new ImportFailure("unreadable", `${file} is not ${what}`);
  return root;
}

function only(value: unknown): [string, unknown] | undefined {
  const d = record(value);
  const keys = d ? Object.keys(d) : [];
  return d && keys.length === 1 ? [keys[0]!, d[keys[0]!]] : undefined;
}

const boundedId = (value: unknown) => (typeof value === "string" && value !== "" && utf8Bytes(value) <= MAXIMUM_ID ? value : undefined);

export function arcDestination(value: unknown, spaces: ReadonlyMap<string, string>): ArcLinkDestination | undefined {
  const outer = only(value);
  if (!outer || (outer[0] !== "space" && outer[0] !== "littleArc")) return undefined;
  const target = only(record(outer[1])?._0);
  if (!target) return undefined;
  const little = outer[0] === "littleArc";
  if (target[0] === "mostRecent") return { kind: little ? "littleArc" : "mostRecent" };
  const id = target[0] === "space" ? boundedId(record(target[1])?._0) : undefined;
  if (!id) return undefined;
  const name = spaces.get(id);
  return { kind: little ? "littleArc" : "space", spaceId: id, ...(name !== undefined ? { spaceName: name } : {}) };
}

function ruleOf(rule: Json, spaces: ReadonlyMap<string, string>): ArcLinkRule | undefined {
  const id = boundedId(rule.id);
  const to = arcDestination(rule.destination, spaces);
  const components = Array.isArray(rule.sourceComponents) ? rule.sourceComponents : [];
  const type = components.length === 1 ? only(record(components[0])?.componentType) : undefined;
  const urlMatch = type?.[0] === "urlMatch" ? record(type[1]) : undefined;
  const style = urlMatch && Object.keys(urlMatch).length === 2 ? only(urlMatch._0) : undefined;
  const raw = urlMatch?._1;
  if (!id || !to || !style || (style[0] !== "contains" && style[0] !== "matches") || typeof raw !== "string" || utf8Bytes(raw) > MAXIMUM_TEXT) return undefined;
  const text = raw.trim();
  return text ? { id, match: style[0] === "matches" ? "equals" : "contains", text, to } : undefined;
}

export function parseArcRouting(raw: string, spaces: ReadonlyMap<string, string>): ArcRouting {
  const root = parsed(raw, ARC_ROUTING_FILE, "Arc's Air Traffic Control file");
  const fallback = arcDestination(root.defaultDestination, spaces);
  const candidates = Array.isArray(root.rules) ? root.rules : [];
  const rules: ArcLinkRule[] = [];
  let skipped = Math.max(0, candidates.length - MAXIMUM_RULES);
  for (const candidate of candidates.slice(0, MAXIMUM_RULES)) {
    const rule = record(candidate) && ruleOf(record(candidate)!, spaces);
    if (rule) rules.push(rule);
    else skipped += 1;
  }
  return { rules, skipped, ...(fallback ? { fallback } : {}) };
}

export const changesFallback = (routing: ArcRouting) => !!routing.fallback && (routing.fallback.kind !== "littleArc" || !!routing.fallback.spaceId);

function archived(entry: Json, spaces: ReadonlyMap<string, string>): ArcArchivedTab | undefined {
  const item = record(entry.sidebarItem);
  const tab = record(record(item?.data)?.tab);
  const url = nonEmpty(tab?.savedURL);
  if (!item || !tab || !url || url.length > MAXIMUM_URL || !isWebUrl(url) || typeof entry.archivedAt !== "number") return undefined;
  const source = nonEmpty(record(record(entry.source)?.space)?._0);
  const id = source && spaces.has(source) ? source : undefined;
  const custom = nonEmpty(item.title)?.slice(0, MAXIMUM_TITLE);
  return {
    url,
    title: typeof tab.savedTitle === "string" ? tab.savedTitle.slice(0, MAXIMUM_TITLE) : "",
    ...(custom !== undefined ? { customTitle: custom } : {}),
    archivedAt: (entry.archivedAt + APPLE_EPOCH_SECONDS) * 1000,
    ...(id ? { spaceId: id, spaceName: spaces.get(id)! } : {}),
    auto: entry.reason === "auto",
  };
}

export function parseArcArchive(raw: string | null, threshold: string | null, spaces: ReadonlyMap<string, string>): ArcArchive {
  const minutes = threshold ? THRESHOLD_MINUTES[threshold] : undefined;
  const out: ArcArchive = { tabs: [], ...(minutes !== undefined ? { cleanUpAfterMinutes: minutes } : {}) };
  if (raw === null) return out;
  const root = parsed(raw, ARC_ARCHIVE_FILE, "Arc's archive");
  const entries = objects(root.items);
  const tabs = entries
    .slice(0, MAXIMUM_ARCHIVE_ITEMS)
    .flatMap((e) => archived(e, spaces) ?? [])
    .sort((a, b) => b.archivedAt - a.archivedAt);
  out.tabs = tabs.slice(0, MAXIMUM_ARCHIVED);
  out.dropped = Math.max(0, entries.length - MAXIMUM_ARCHIVE_ITEMS) + tabs.length - out.tabs.length;
  return out;
}

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let block = 0; block < padded.length; block += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(block + i * 4, true));
    let [a, b, c, d] = state as [number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const shift = SHIFTS[round * 4 + (i % 4)]!;
      const sum = (a + f + SINES[i]! + words[g]!) >>> 0;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
  }
  return state.map((word) => Array.from({ length: 4 }, (_, i) => ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

const originOf = (page: string) => {
  const m = /^(https?):\/\/([^/?#:]+)(:\d+)?/i.exec(page);
  return m ? `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3] ?? ""}` : undefined;
};

export async function cachedArcFavicons(
  read: (fileName: string, largest: number) => Promise<string | null>,
  items: Readonly<Record<string, string>>,
  pages: string[],
  known: Favicon[],
): Promise<Favicon[]> {
  const icons = new Map<string, string>();
  for (const f of known) if (!icons.has(f.page)) icons.set(f.page, f.icon);
  const seen = new Set<string>();
  const out: Favicon[] = [];
  let total = 0;
  for (const page of pages) {
    if (!isWebUrl(page) || seen.has(page)) continue;
    seen.add(page);
    if (seen.size > MAXIMUM_PAGES || total >= MAXIMUM_TOTAL_BYTES) break;
    const id = Object.prototype.hasOwnProperty.call(items, page) ? items[page] : undefined;
    const origin = originOf(page);
    const icon = icons.get(page) ?? (origin ? `${origin}/favicon.ico` : undefined);
    if (!id || !icon) continue;
    const png = await read(md5Hex(id), MAXIMUM_PNG_BYTES).catch(() => null);
    if (!png?.startsWith(PNG_BASE64_PREFIX)) continue;
    total += png.length;
    if (total > MAXIMUM_TOTAL_BYTES) break;
    out.push({ page, icon, png });
  }
  return out;
}

export function preferringCached(cached: Favicon[], known: Favicon[]): Favicon[] {
  const taken = new Set(cached.map((f) => f.page));
  let total = cached.reduce((n, f) => n + f.png.length, 0);
  return [
    ...cached,
    ...known.filter((f) => {
      if (taken.has(f.page) || total + f.png.length > MAXIMUM_TOTAL_BYTES) return false;
      total += f.png.length;
      return true;
    }),
  ];
}
