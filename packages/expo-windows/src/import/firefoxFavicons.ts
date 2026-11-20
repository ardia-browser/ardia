import { fromBase64 } from "./bytes";
import { join, rowsOf, type ImportHost, type Query, type Rows } from "./host";
import { ImportFailure, isWebUrl, type Favicon } from "./model";
import { withSnapshot } from "./sqlite";

const MAXIMUM_PAGES = 1000;
const MAXIMUM_PNG_BYTES = 16 * 1024;
const MAXIMUM_TOTAL_BYTES = 6 * 1024 * 1024;
const LARGEST_SIDE = 64;
const PNG_HEADER_BYTES = 24;
const CANDIDATES_PER_SOURCE = 32;
const RECENT_PAGES_PER_SITE = 8;
const MAXIMUM_ROOT_ICONS = 50_000;
const BOUND_PER_QUERY = 200;
const EXACT_ADDRESSES_PER_PAGE = 16;
const QUERIES_PER_BATCH = 100;
const TABLES = ["moz_icons", "moz_pages_w_icons", "moz_icons_to_pages"];
const PNG_HEAD = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];

type Origin = { scheme: string; host: string; port?: number; site: string; home: string; rootKey: string; reversedHost: string };
type Parts = { origin: Origin; hasUser: boolean; path: string; hasQuery: boolean; hasFragment: boolean };
type Source = { key: string; filter: string; args: number[] };
type Read = (queries: Query[]) => Promise<Rows[]>;
type Icon = { icon: string; png: string };

export const faviconKey = (page: string) => page.replace(/#.*$/, "");

export function urlParts(url: string): Parts | undefined {
  const separator = url.indexOf("://");
  if (separator < 0) return undefined;
  const scheme = url.slice(0, separator).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return undefined;
  const rest = url.slice(separator + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  let host: string;
  let rawPort: string | undefined;
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    if (close < 0 || !/^[0-9A-Fa-f:.]+$/.test(hostAndPort.slice(1, close))) return undefined;
    host = hostAndPort.slice(0, close + 1);
    const after = hostAndPort.slice(close + 1);
    if (after && !after.startsWith(":")) return undefined;
    rawPort = after ? after.slice(1) : undefined;
  } else {
    const colon = hostAndPort.lastIndexOf(":");
    host = colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
    rawPort = colon < 0 ? undefined : hostAndPort.slice(colon + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(host)) return undefined;
  }
  let port: number | undefined;
  if (rawPort !== undefined) {
    if (!/^[0-9]{1,5}$/.test(rawPort)) return undefined;
    const number = Number(rawPort);
    if (number < 1 || number > 65535) return undefined;
    port = number === (scheme === "https" ? 443 : 80) ? undefined : number;
  }
  host = host.toLowerCase();
  const tail = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  const pathEnd = tail.search(/[?#]/);
  const site = `${scheme}://${host}${port === undefined ? "" : `:${port}`}`;
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  const unbracketed = host.startsWith("[") ? host.slice(1, -1) : host;
  return {
    origin: { scheme, host, port, site, home: `${site}/`, rootKey: `${bare}${port === undefined ? "" : `:${port}`}`, reversedHost: `${[...unbracketed].reverse().join("")}.` },
    hasUser: authority.includes("@"),
    path: pathEnd < 0 ? tail : tail.slice(0, pathEnd),
    hasQuery: pathEnd >= 0 && tail[pathEnd] === "?",
    hasFragment: tail.includes("#"),
  };
}

export function rootIconKey(url: string): string | undefined {
  const parts = urlParts(url);
  return parts && !parts.hasUser && parts.path === "/favicon.ico" && !parts.hasQuery && !parts.hasFragment ? parts.origin.rootKey : undefined;
}

const word = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const chunkType = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);

export function headerSize(head: Uint8Array): { width: number; height: number } | undefined {
  if (head.length < PNG_HEADER_BYTES || !PNG_HEAD.every((b, i) => head[i] === b)) return undefined;
  const width = word(head, 16);
  const height = word(head, 20);
  return width >= 1 && width <= LARGEST_SIDE && height >= 1 && height <= LARGEST_SIDE ? { width, height } : undefined;
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const size = headerSize(bytes);
  if (!size) return undefined;
  let at = 8;
  let sawData = false;
  while (at + 12 <= bytes.length) {
    const length = word(bytes, at);
    if (length > bytes.length - at - 12) return undefined;
    const type = chunkType(bytes, at);
    const end = at + 12 + length;
    if (at === 8) {
      if (type !== "IHDR" || length !== 13) return undefined;
    } else if (type === "IHDR") {
      return undefined;
    } else if (type === "IDAT") {
      sawData = sawData || length > 0;
    } else if (type === "IEND") {
      return length === 0 && end === bytes.length && sawData ? size : undefined;
    }
    at = end;
  }
  return undefined;
}

export function sessionIcons(icons: Favicon[], pages: string[]): Favicon[] {
  const wanted = new Set(pages.map(faviconKey));
  const seen = new Set<string>();
  const unique = icons.filter((icon) => {
    const key = faviconKey(icon.page);
    if (!wanted.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out: Favicon[] = [];
  let total = 0;
  for (const icon of unique) {
    if (out.length >= MAXIMUM_PAGES) break;
    if (total + icon.png.length > MAXIMUM_TOTAL_BYTES) continue;
    total += icon.png.length;
    out.push(icon);
  }
  return out;
}

const decodedBytes = (base64: string) => Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");
const chunks = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

async function batched(read: Read, queries: Query[], cancelled: () => boolean): Promise<Rows[]> {
  const out: Rows[] = [];
  for (const batch of chunks(queries, QUERIES_PER_BATCH)) {
    if (cancelled()) throw new ImportFailure("cancelled", "Import cancelled");
    out.push(...(await read(batch)));
  }
  return out;
}

async function lookUp(read: Read, urls: string[], cancelled: () => boolean): Promise<Map<string, number>> {
  const queries = chunks(urls, BOUND_PER_QUERY).map((list): Query => ({ sql: `SELECT id, page_url FROM moz_pages_w_icons WHERE page_url IN (${placeholders(list.length)})`, args: list }));
  const ids = new Map<string, number>();
  for (const r of (await batched(read, queries, cancelled)).flatMap(rowsOf)) {
    const url = r.text("page_url");
    if (url !== undefined) ids.set(url, r.int("id") ?? 0);
  }
  return ids;
}

const pageSource = (id: number): Source => ({ key: `page ${id}`, filter: "id IN (SELECT icon_id FROM moz_icons_to_pages WHERE page_id = ?)", args: [id] });

async function choose(read: Read, sources: Source[], chosen: Map<string, Icon | null>, verified: Map<number, Icon | null>, cancelled: () => boolean) {
  const asking = [...new Map(sources.filter((s) => !chosen.has(s.key)).map((s) => [s.key, s])).values()];
  const replies = await batched(
    read,
    asking.map((s): Query => ({
      sql: `SELECT id, substr(data, 1, ${PNG_HEADER_BYTES}) AS head FROM moz_icons
        WHERE ${s.filter} AND typeof(data) = 'blob' AND length(data) BETWEEN ${PNG_HEADER_BYTES} AND ${MAXIMUM_PNG_BYTES}
        ORDER BY id LIMIT ${CANDIDATES_PER_SOURCE}`,
      args: s.args,
      limit: CANDIDATES_PER_SOURCE,
    })),
    cancelled,
  );
  const ranked = new Map<string, number[]>();
  asking.forEach((s, i) => {
    const candidates = rowsOf(replies[i]).flatMap((row) => {
      const head = row.blob("head");
      const size = head ? headerSize(fromBase64(head)) : undefined;
      return size ? [{ id: row.int("id") ?? 0, ...size }] : [];
    });
    candidates.sort((a, b) => b.width - a.width || b.height - a.height || a.id - b.id);
    ranked.set(s.key, candidates.map((c) => c.id));
  });
  let pending = asking;
  while (pending.length) {
    const ids = [...new Set(pending.flatMap((s) => ranked.get(s.key)!.slice(0, 1)))].filter((id) => !verified.has(id));
    const fetched = await batched(
      read,
      chunks(ids, BOUND_PER_QUERY).map((list): Query => ({
        sql: `SELECT id, icon_url AS icon, data AS png FROM moz_icons WHERE id IN (${placeholders(list.length)}) AND typeof(data) = 'blob' AND length(data) <= ${MAXIMUM_PNG_BYTES}`,
        args: list,
      })),
      cancelled,
    );
    for (const id of ids) verified.set(id, null);
    for (const r of fetched.flatMap(rowsOf)) {
      const icon = r.text("icon");
      const png = r.blob("png");
      if (icon !== undefined && png && decodedBytes(png) <= MAXIMUM_PNG_BYTES && pngSize(fromBase64(png))) verified.set(r.int("id") ?? 0, { icon, png });
    }
    const next: Source[] = [];
    for (const s of pending) {
      const list = ranked.get(s.key)!;
      const icon = list.length ? verified.get(list[0]!) : null;
      if (icon) chosen.set(s.key, icon);
      else if (list.length > 1) {
        list.shift();
        next.push(s);
      } else chosen.set(s.key, null);
    }
    pending = next;
  }
}

function firstChosen(sources: Source[], chosen: Map<string, Icon | null>): Icon | undefined {
  for (const source of sources) {
    const icon = chosen.get(source.key);
    if (icon) return icon;
  }
  return undefined;
}

async function recentPages(host: ImportHost, profile: string, origins: Origin[], cancelled: () => boolean): Promise<Map<string, string[]>> {
  const recent = new Map<string, string[]>();
  if (!origins.length) return recent;
  await withSnapshot(host, join(profile, "places.sqlite"), "Firefox", async (read) => {
    const [tables] = await read([{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='moz_places'" }]);
    if (!rowsOf(tables).length) return;
    const replies = await batched(
      read,
      origins.map((o): Query => ({
        sql: `SELECT url FROM moz_places WHERE rev_host = ? AND last_visit_date IS NOT NULL AND url >= ? AND url < ? AND url <> ?
          ORDER BY last_visit_date DESC LIMIT ${RECENT_PAGES_PER_SITE}`,
        args: [o.reversedHost, o.home, `${o.site}0`, o.home],
        limit: RECENT_PAGES_PER_SITE,
      })),
      cancelled,
    );
    origins.forEach((o, i) => recent.set(o.site, rowsOf(replies[i]).flatMap((r) => r.text("url") ?? [])));
  }).catch((error: unknown) => {
    if (error instanceof ImportFailure && error.code === "cancelled") throw error;
  });
  return recent;
}

export async function mergeFirefoxFavicons(host: ImportHost, profile: string, pages: string[], known: Favicon[], cancelled: () => boolean = () => false): Promise<Favicon[]> {
  const out: Favicon[] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const icon of known) {
    const key = faviconKey(icon.page);
    if (keys.size >= MAXIMUM_PAGES || keys.has(key) || total + icon.png.length > MAXIMUM_TOTAL_BYTES) continue;
    keys.add(key);
    total += icon.png.length;
    out.push(icon);
  }
  const wanted: { key: string; pages: string[]; origin?: Origin }[] = [];
  const groupAt = new Map<string, number>();
  for (const page of pages) {
    const key = faviconKey(page);
    if (!isWebUrl(page) || keys.has(key)) continue;
    const at = groupAt.get(key);
    if (at !== undefined) {
      const group = wanted[at]!;
      if (group.pages.length < EXACT_ADDRESSES_PER_PAGE && !group.pages.includes(page)) group.pages.push(page);
      continue;
    }
    if (keys.size + wanted.length >= MAXIMUM_PAGES) continue;
    groupAt.set(key, wanted.length);
    wanted.push({ key, pages: [page], origin: urlParts(page)?.origin });
  }
  if (!wanted.length || total >= MAXIMUM_TOTAL_BYTES) return out;
  const added = await withSnapshot(host, join(profile, "favicons.sqlite"), "Firefox", async (read) => {
    const [tables] = await read([{ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map((t) => `'${t}'`).join(", ")})` }]);
    if (rowsOf(tables).length !== TABLES.length) return [];
    const rootKeys = new Set(wanted.flatMap((w) => (w.origin ? [w.origin.rootKey] : [])));
    const homes = wanted.flatMap((w) => (w.origin ? [w.origin.home] : []));
    const pageIds = await lookUp(read, [...new Set([...wanted.flatMap((w) => [...w.pages, w.key]), ...homes])], cancelled);
    const roots = new Map<string, number[]>();
    if (rootKeys.size) {
      const [rootRows] = await read([{ sql: `SELECT id, icon_url FROM moz_icons WHERE root = 1 ORDER BY id LIMIT ${MAXIMUM_ROOT_ICONS}`, limit: MAXIMUM_ROOT_ICONS }]);
      for (const r of rowsOf(rootRows)) {
        const key = rootIconKey(r.text("icon_url") ?? "");
        if (key && rootKeys.has(key)) roots.set(key, [...(roots.get(key) ?? []), r.int("id") ?? 0]);
      }
    }
    const chosen = new Map<string, Icon | null>();
    const verified = new Map<number, Icon | null>();
    const found = new Map<string, Icon>();
    const firstSources = new Map(
      wanted.map((w) => {
        const ids = [...new Set([...w.pages, w.key].flatMap((url) => (pageIds.has(url) ? [pageIds.get(url)!] : [])))];
        const sources: Source[] = ids.map(pageSource);
        if (w.origin) {
          const rootIds = roots.get(w.origin.rootKey);
          if (rootIds?.length) sources.push({ key: `root ${w.origin.rootKey}`, filter: `id IN (${placeholders(rootIds.length)})`, args: rootIds });
          const home = pageIds.get(w.origin.home);
          if (home !== undefined && !ids.includes(home)) sources.push(pageSource(home));
        }
        return [w.key, sources] as const;
      }),
    );
    await choose(read, [...firstSources.values()].flat(), chosen, verified, cancelled);
    for (const w of wanted) {
      const icon = firstChosen(firstSources.get(w.key)!, chosen);
      if (icon) found.set(w.key, icon);
    }
    const missing = wanted.flatMap((w) => (!found.has(w.key) && w.origin ? [{ key: w.key, origin: w.origin }] : []));
    const origins = [...new Map(missing.map((w) => [w.origin.site, w.origin])).values()];
    const recent = await recentPages(host, profile, origins, cancelled);
    const recentIds = await lookUp(read, [...new Set([...recent.values()].flat())], cancelled);
    const laterSources = new Map(missing.map((w) => [w.key, (recent.get(w.origin.site) ?? []).flatMap((url) => (recentIds.has(url) ? [pageSource(recentIds.get(url)!)] : []))] as const));
    await choose(read, [...laterSources.values()].flat(), chosen, verified, cancelled);
    for (const w of missing) {
      const icon = firstChosen(laterSources.get(w.key)!, chosen);
      if (icon) found.set(w.key, icon);
    }
    const picked: Favicon[] = [];
    for (const w of wanted) {
      const icon = found.get(w.key);
      if (!icon) continue;
      total += icon.png.length;
      if (total > MAXIMUM_TOTAL_BYTES) break;
      picked.push({ page: w.pages[0]!, icon: icon.icon, png: icon.png });
    }
    return picked;
  }).catch((error: unknown) => {
    if (error instanceof ImportFailure && error.code === "cancelled") throw error;
    return [];
  });
  return [...out, ...added];
}
