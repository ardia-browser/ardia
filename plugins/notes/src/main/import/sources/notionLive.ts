import type { NotionAccount, NotionCrawl, NotionRole, NotionSpace } from "../../../shared/notionLive";
import type { NotionRecords } from "../../../shared/notionRecords";
import { IMPORT_LIMITS, ImportError } from "../limits";

export const NOTION_ORIGINS = ["https://app.notion.com", "https://www.notion.so"] as const;
export const NOTION_FILE_HOSTS = ["file.notion.com", "file.notion.so"] as const;
export const NOTION_LIVE_DIR = "notion-live";

export const NOTION_READ_ENDPOINTS = ["getSpaces", "syncRecordValuesMain", "queryCollection", "getSignedFileUrls", "search"] as const;
export const NOTION_ASSET_HOSTS = ["images.unsplash.com"] as const;
export type NotionReadEndpoint = (typeof NOTION_READ_ENDPOINTS)[number];
export const isReadEndpoint = (endpoint: unknown): endpoint is NotionReadEndpoint => typeof endpoint === "string" && (NOTION_READ_ENDPOINTS as readonly string[]).includes(endpoint);

export function notionReadUrl(origin: string, endpoint: string): string {
  if (!isReadEndpoint(endpoint)) throw new ImportError("Notes only reads from Notion.");
  if (!(NOTION_ORIGINS as readonly string[]).includes(origin)) throw new ImportError("Notes only reads from Notion's own site.");
  return `${origin}/api/v3/${endpoint}`;
}

export const NOTION_LIVE_LIMITS = {
  inFlight: 4,
  minGapMs: 220,
  recordsPerSync: 100,
  urlsPerSign: 40,
  searchLimit: 1000,
  queryFirst: 1000,
  queryMax: IMPORT_LIMITS.rows,
  queryMin: 25,
  attempts: 8,
  backoffMs: 1000,
  backoffMaxMs: 60_000,
  requestTimeoutMs: 60_000,
  budgetMs: 30 * 60 * 1000,
  rounds: 400,
  records: 250_000,
  filesBytes: IMPORT_LIMITS.spoolBytes,
  fileBytes: IMPORT_LIMITS.attachmentBytes,
  statusCacheMs: 3000,
  downloadCheckMs: 1000,
};

export type NotionLiveLimits = typeof NOTION_LIVE_LIMITS;

export type SiteResponse = { status: number; ok: boolean; headers: Record<string, string>; body: string };
export type SiteDownloadProgress = { state: "running" | "done" | "failed" | "cancelled"; received: number; total?: number; size?: number; code?: string; error?: string };
export type SitesApi = {
  fetch(url: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs?: number; session?: string }): Promise<SiteResponse>;
  download(url: string, options: { to: string; maxBytes?: number; session?: string; onProgress?: (p: SiteDownloadProgress) => void }): Promise<{ id: string; done: Promise<{ size: number }>; cancel(): Promise<void> }>;
  session?(): Promise<string>;
  available?(): Promise<boolean>;
};

export type NotionLiveDeps = {
  sites: SitesApi | null;
  removeFile(path: string): Promise<unknown>;
  listFiles?(dir: string): Promise<{ path: string; kind: "file" | "dir" }[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(level: "warn" | "info", text: string): void;
  limits?: Partial<NotionLiveLimits>;
};

export type NotionRecordsHandoff = { records: NotionRecords; release(): Promise<void> };

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").slice(0, max) : "");
const ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
export const isNotionId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isNotionId) : []);

class NotionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class TooLarge extends Error {}

class Stop extends Error {}

const SIGNED_OUT = "Your Notion sign-in ended. Sign in to Notion in Ardia again, then retry.";
const TERMINAL_CODES = new Set(["refused", "no_window", "bad_request", "not_found", "unavailable", "unsupported", "quota", "exists"]);
const UNSUPPORTED_CODES = new Set(["unavailable", "unsupported"]);

export function retryAfterMs(value: string | undefined, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export function unwrapRecord(record: unknown): Json | null {
  if (!isObject(record)) return null;
  const outer = record.value;
  const value = isObject(outer) && isObject(outer.value) ? outer.value : isObject(outer) ? outer : null;
  if (!value || !isNotionId(value.id)) return null;
  return value;
}

function recordRole(record: unknown): string {
  if (!isObject(record)) return "";
  const outer = record.value;
  if (isObject(outer) && typeof outer.role === "string") return outer.role;
  return typeof record.role === "string" ? record.role : "";
}

function looseValue(record: unknown): Json | null {
  if (!isObject(record)) return null;
  const outer = record.value;
  if (isObject(outer) && isObject(outer.value)) return outer.value;
  if (isObject(outer)) return outer;
  return null;
}

function roleOf(membership: string, permissionRole: string, recordRoleName: string): NotionRole {
  if (membership === "owner") return "owner";
  if (membership === "membership_admin") return "admin";
  if (membership === "member" || membership === "restricted_member") return "member";
  if (membership === "page_guest") return "guest";
  if (permissionRole === "editor" || permissionRole === "read_and_write" || recordRoleName === "editor") return "member";
  return "unknown";
}

function recordMaps(answer: unknown): Json[] {
  if (!isObject(answer)) return [];
  if (isObject(answer.recordMap)) return [answer.recordMap];
  return Object.values(answer).filter(isObject);
}

export function spacesFrom(answer: unknown): { user: { id: string; name: string; email: string }; spaces: NotionSpace[] } | null {
  const maps = recordMaps(answer);
  if (!maps.length) return null;
  let user: { id: string; name: string; email: string } | null = null;
  const spaces = new Map<string, NotionSpace>();
  for (const map of maps) {
    const users = isObject(map.notion_user) ? map.notion_user : {};
    for (const [id, rec] of Object.entries(users)) {
      const v = looseValue(rec);
      if (!v || user) continue;
      user = { id: text(v.id) || id, name: text(v.name) || [text(v.given_name), text(v.family_name)].filter(Boolean).join(" "), email: text(v.email, 320) };
    }
    const spaceUsers = isObject(map.space_user) ? map.space_user : {};
    const rawSpaces = isObject(map.space) ? map.space : {};
    for (const [id, rec] of Object.entries(rawSpaces)) {
      const v = looseValue(rec);
      const spaceId = v ? text(v.id) || id : "";
      if (!v || !ID.test(spaceId) || spaces.has(spaceId)) continue;
      const userId = user?.id ?? "";
      const membership = Object.entries(spaceUsers)
        .map(([key, r]) => ({ key, v: looseValue(r) }))
        .find((e) => e.v && (e.key === `${userId}|${spaceId}` || (text(e.v.space_id) === spaceId && (!userId || text(e.v.user_id) === userId))));
      const membershipType = membership?.v ? text(membership.v.membership_type) : "";
      const permissions = Array.isArray(v.permissions) ? v.permissions : [];
      const mine = permissions.find((p) => isObject(p) && (!userId || p.user_id === userId));
      const role = roleOf(membershipType, isObject(mine) ? text(mine.role) : "", recordRole(rec));
      const locked = v.disable_export === true || (isObject(v.settings) && v.settings.disable_export === true);
      const icon = text(v.icon, 400);
      spaces.set(spaceId, {
        id: spaceId,
        name: text(v.name) || "Untitled workspace",
        icon: /^https:\/\//.test(icon) ? "" : icon.slice(0, 16),
        role,
        canImport: !locked && role !== "guest",
        ...(locked ? { reason: "This workspace's admins don't allow copying its pages out of Notion." } : role === "guest" ? { reason: "You're a guest in this workspace, so Notes can't bring all of it in." } : {}),
      });
    }
  }
  if (!user && !spaces.size) return null;
  return { user: user ?? { id: "", name: "", email: "" }, spaces: [...spaces.values()].sort((a, b) => Number(b.canImport) - Number(a.canImport) || a.name.localeCompare(b.name)) };
}

export type NotionRoots = { pages: string[]; seeds: string[]; teamIds: string[]; teams: Record<string, string[]> };

const teamPagesOf = (team: Json): string[] => [...ids(team.team_pages), ...ids(team.pages)];

export function rootsFrom(answer: unknown, spaceId: string): NotionRoots {
  const spacePages: string[] = [];
  const privatePages: string[] = [];
  const seeds: string[] = [];
  const teamIds = new Set<string>();
  const teams: Record<string, string[]> = {};
  for (const map of recordMaps(answer)) {
    for (const rec of Object.values(isObject(map.space) ? map.space : {})) {
      const v = looseValue(rec);
      if (v && text(v.id) === spaceId) spacePages.push(...ids(v.pages));
    }
    for (const rec of Object.values(isObject(map.space_view) ? map.space_view : {})) {
      const v = looseValue(rec);
      if (!v || text(v.space_id) !== spaceId) continue;
      privatePages.push(...ids(v.private_pages));
      seeds.push(...ids(v.bookmarked_pages), ...ids(v.shared_pages));
      for (const id of ids(v.joined_teams)) teamIds.add(id);
    }
    for (const rec of Object.values(isObject(map.team) ? map.team : {})) {
      const v = unwrapRecord(rec);
      if (!v || text(v.space_id) !== spaceId) continue;
      const id = v.id as string;
      teamIds.add(id);
      teams[id] = teamPagesOf(v);
    }
  }
  const privateSet = new Set(privatePages);
  const pages = [...spacePages.filter((id) => !privateSet.has(id)), ...privatePages];
  const listed = new Set(pages);
  return { pages: [...listed], seeds: [...new Set(seeds)].filter((id) => !listed.has(id)), teamIds: [...teamIds], teams };
}

const PAGE_TYPES = new Set(["page", "collection_view_page", "personal_home_page"]);
const FILE_BLOCKS = new Set(["image", "file", "pdf", "video", "audio"]);
const SECURE_S3 = /^https:\/\/(prod-files-secure\.s3[a-z0-9.-]*\.amazonaws\.com|s3[a-z0-9.-]*\.amazonaws\.com\/secure\.notion-static\.com)\//i;

export function needsSigning(source: unknown): source is string {
  if (typeof source !== "string" || source.length > 4096) return false;
  if (/^attachment:[0-9a-f-]{36}:[^\u0000-\u001f]+$/i.test(source)) return true;
  if (SECURE_S3.test(source)) return true;
  return fileHost(source) !== null;
}

export function fileHost(url: string): string | null {
  const found = /^https:\/\/([a-z0-9.-]+)(\/[^\s#]*)?$/i.exec(url);
  const host = found?.[1]?.toLowerCase() ?? "";
  return (NOTION_FILE_HOSTS as readonly string[]).includes(host) ? host : null;
}

export function fileName(source: string, fallback: string): string {
  let raw = "";
  const attachment = /^attachment:[0-9a-f-]{36}:(.+)$/i.exec(source);
  if (attachment) raw = attachment[1]!;
  else {
    const path = (source.startsWith("/") ? /^([^?#]*)/.exec(source)?.[1] : /^https:\/\/[^/?#]+(\/[^?#]*)?/i.exec(source)?.[1]) ?? "";
    const last = path.split("/").filter(Boolean).pop() ?? "";
    try {
      raw = decodeURIComponent(last);
    } catch {
      raw = last;
    }
  }
  const clean = (raw || fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    .replace(/[\/\\:]/g, "-")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return clean || "file";
}

type FileRef = { source: string; table: "block" | "collection" | "collection_view"; recordId: string; name: string; version: string };

const BUILT_IN_PATH = /^\/(icons|images)\/[A-Za-z0-9._~%+-]+(\/[A-Za-z0-9._~%+-]+)*$/;

const BUILT_IN_ASSET = /^\/(icons|images)\/[A-Za-z0-9._~%+-]+(\/[A-Za-z0-9._~%+-]+)*(\?[A-Za-z0-9=&._~%+-]*)?$/;

const ENCODED_SEPARATOR = /%(2e|2f|5c)/i;
const HTTPS_URL = /^https:\/\/([a-z0-9.-]+)(\/[^?#\s\\@]*)?(\?[^#\s]*)?$/i;

type HttpsUrl = { origin: string; host: string; path: string };

function parseHttps(raw: string): HttpsUrl | null {
  const found = HTTPS_URL.exec(raw);
  if (!found) return null;
  const path = found[2] ?? "/";
  if (ENCODED_SEPARATOR.test(path) || path.split("/").some((part) => part === "." || part === "..")) return null;
  const host = found[1]!.toLowerCase();
  return { origin: `https://${host}`, host, path };
}

export function assetUrl(source: unknown, origin: string): string | null {
  if (typeof source !== "string" || source.length > 2048) return null;
  if (BUILT_IN_ASSET.test(source)) {
    const home = parseHttps(origin);
    const url = home ? parseHttps(`${home.origin}${source}`) : null;
    return home && url && BUILT_IN_PATH.test(url.path) ? `${home.origin}${source}` : null;
  }
  const url = parseHttps(source);
  return url && (NOTION_ASSET_HOSTS as readonly string[]).includes(url.host) ? source : null;
}

export function downloadable(raw: string, origin: string): boolean {
  const url = parseHttps(raw);
  if (!url) return false;
  if (url.origin === parseHttps(origin)?.origin) return BUILT_IN_PATH.test(url.path);
  return fileHost(raw) !== null || (NOTION_ASSET_HOSTS as readonly string[]).includes(url.host);
}

const wantsFile = (source: unknown): source is string => needsSigning(source) || assetUrl(source, "https://app.notion.com") !== null;

function segmentsOf(value: unknown): unknown[][] {
  return Array.isArray(value) ? (value.filter(Array.isArray) as unknown[][]) : [];
}

function annotationsOf(segment: unknown[]): unknown[][] {
  return Array.isArray(segment[1]) ? (segment[1].filter(Array.isArray) as unknown[][]) : [];
}

export function fileRefsOf(record: Json, table: FileRef["table"] = "block"): FileRef[] {
  const out: FileRef[] = [];
  const id = record.id as string;
  const format = isObject(record.format) ? record.format : {};
  const stamps = [record.version, record.last_edited_time].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const version = stamps.length ? `${table}:${id}:${stamps.join(":")}` : "";
  const add = (source: unknown, name: string) => {
    if (wantsFile(source)) out.push({ source, table, recordId: id, name: fileName(source, name), version });
  };
  if (table === "collection") {
    add(record.icon, "icon");
    add(record.cover, "cover");
    return out;
  }
  if (table === "collection_view") {
    add(format.collection_view_icon, "icon");
    return out;
  }
  const properties = isObject(record.properties) ? record.properties : {};
  const title = text(segmentsOf(properties.title)[0]?.[0], 120);
  if (FILE_BLOCKS.has(text(record.type))) {
    const source = segmentsOf(properties.source)[0]?.[0];
    if (needsSigning(source)) add(source, title);
    if (format.display_source !== source && needsSigning(format.display_source)) add(format.display_source, title);
  }
  add(format.page_cover, "cover");
  add(format.page_icon, "icon");
  if (record.parent_table === "collection") {
    for (const [key, value] of Object.entries(properties)) {
      if (key === "title") continue;
      for (const segment of segmentsOf(value)) for (const a of annotationsOf(segment)) if (a[0] === "a" && needsSigning(a[1])) add(a[1], text(segment[0], 120));
    }
  }
  return out;
}

type Binding = { origin: string; userId: string; session: string };

type Tables = { blocks: Record<string, Json>; collections: Record<string, Json>; views: Record<string, Json>; users: Record<string, Json>; teams: Record<string, Json> };

const TABLE_KEYS: Record<string, keyof Tables> = { block: "blocks", collection: "collections", collection_view: "views", notion_user: "users", team: "teams" };

type RecordTable = "block" | "collection" | "collection_view" | "notion_user" | "team";

class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private next = 0;

  constructor(
    private readonly max: number,
    private readonly gapMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async run<T>(check: () => void, work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      check();
      const now = this.now();
      const slot = Math.max(now, this.next);
      this.next = slot + this.gapMs;
      if (slot > now) await this.sleep(slot - now);
      check();
      return await work();
    } finally {
      this.release();
    }
  }
}

class Crawl {
  readonly tables: Tables = { blocks: {}, collections: {}, views: {}, users: {}, teams: {} };
  readonly rows: Record<string, string[]> = {};
  readonly unread = { collections: new Set<string>(), blocks: new Set<string>() };
  readonly files: NotionRecords["files"] = {};
  readonly made: string[] = [];
  readonly dir: string;
  private readonly tried: Record<RecordTable, Set<string>> = { block: new Set(), collection: new Set(), collection_view: new Set(), notion_user: new Set(), team: new Set() };
  private readonly wanted = { blocks: new Set<string>(), collections: new Set<string>(), views: new Set<string>(), users: new Set<string>() };
  private readonly queries = new Map<string, string[]>();
  private readonly queried = new Set<string>();
  private fresh: string[] = [];
  private recordCount = 0;
  private readonly gate: Gate;
  private readonly deadline: number;
  stopped = false;
  download: { cancel(): Promise<void> } | null = null;
  private stopNow: () => void = () => {};
  readonly halted: Promise<void>;

  constructor(
    private readonly deps: NotionLiveDeps,
    private readonly limits: NotionLiveLimits,
    private readonly sites: SitesApi,
    private readonly bound: Binding,
    readonly job: NotionCrawl,
  ) {
    this.gate = new Gate(limits.inFlight, limits.minGapMs, deps.now, deps.sleep);
    this.deadline = job.startedAt + limits.budgetMs;
    this.dir = `${NOTION_LIVE_DIR}/${job.spaceId.replace(/[^0-9a-f-]/gi, "")}-${job.startedAt}`;
    this.halted = new Promise<void>((resolve) => (this.stopNow = resolve));
  }

  stop() {
    this.stopped = true;
    this.stopNow();
  }

  check() {
    if (this.stopped) throw new Stop();
    if (this.deps.now() > this.deadline) throw this.overBudget();
  }

  private overBudget() {
    const minutes = Math.max(1, Math.round(this.limits.budgetMs / 60_000));
    return new ImportError(`Reading the workspace took more than ${minutes} minute${minutes === 1 ? "" : "s"}, so Notes stopped. Try again later, or choose a file instead.`);
  }

  private untilStopped<T>(work: Promise<T>): Promise<T> {
    this.check();
    return Promise.race([work, this.halted.then(() => Promise.reject(new Stop()))]).then((value) => {
      this.check();
      return value;
    });
  }

  private async pause(ms: number) {
    if (this.deps.now() + ms > this.deadline) throw this.overBudget();
    await Promise.race([this.deps.sleep(ms), this.halted]);
    this.check();
  }

  async read(endpoint: NotionReadEndpoint, body: unknown): Promise<Json> {
    const url = notionReadUrl(this.bound.origin, endpoint);
    const init = {
      method: "POST" as const,
      headers: { "content-type": "application/json", accept: "application/json", ...(this.bound.userId ? { "x-notion-active-user-header": this.bound.userId } : {}) },
      body: JSON.stringify(body),
      timeoutMs: this.limits.requestTimeoutMs,
      session: this.bound.session,
    };
    let backoff = this.limits.backoffMs;
    for (let attempt = 1; ; attempt++) {
      let delay = backoff;
      let res: SiteResponse | null = null;
      try {
        res = await this.untilStopped(this.gate.run(() => this.check(), () => this.sites.fetch(url, init)));
      } catch (error) {
        if (error instanceof Stop || error instanceof ImportError) throw error;
        const code = String((error as { code?: unknown })?.code ?? "");
        const message = error instanceof Error ? error.message : String(error);
        if (code === "too_large") throw new TooLarge(message);
        if (code === "refused" && /too many/i.test(message)) delay = Math.max(delay, 1000);
        else if (TERMINAL_CODES.has(code)) throw new ImportError(message);
      }
      if (res) {
        if (res.ok) {
          try {
            const parsed = JSON.parse(res.body) as unknown;
            if (isObject(parsed)) return parsed;
          } catch {}
          throw new NotionHttpError(res.status, "Notion's answer wasn't readable.");
        }
        if (res.status === 401 || res.status === 403) throw new ImportError(SIGNED_OUT);
        if (res.status !== 429 && res.status < 500) {
          let message = "";
          try {
            const parsed = JSON.parse(res.body) as Json;
            message = text(parsed.message, 300) || text(parsed.debugMessage, 300);
          } catch {}
          throw new NotionHttpError(res.status, message || `Notion answered ${res.status}.`);
        }
        delay = Math.max(delay, retryAfterMs(res.headers["retry-after"], Date.now()));
      }
      if (attempt >= this.limits.attempts) throw new ImportError(res ? `Notion kept answering ${res.status}, so Notes stopped. Try again in a few minutes.` : "Notion stopped answering, so Notes stopped. Check your connection and try again.");
      await this.pause(delay);
      backoff = Math.min(backoff * 2, this.limits.backoffMaxMs);
    }
  }

  absorb(recordMap: unknown) {
    if (!isObject(recordMap)) return;
    for (const [table, key] of Object.entries(TABLE_KEYS)) {
      const records = recordMap[table];
      if (!isObject(records)) continue;
      const dst = this.tables[key];
      for (const [id, rec] of Object.entries(records)) {
        const v = unwrapRecord(rec);
        if (!v || v.id !== id) continue;
        const old = dst[id];
        if (!old) {
          if (++this.recordCount > this.limits.records) throw new ImportError(`The workspace has more than ${this.limits.records.toLocaleString("en-US")} records, more than Notes brings in at once.`);
        } else if ((Number(v.version) || 0) < (Number(old.version) || 0)) continue;
        dst[id] = v;
        if (key === "blocks" || key === "collections") this.fresh.push(`${key}:${id}`);
      }
    }
  }

  private wantBlock(id: unknown) {
    if (isNotionId(id) && !this.tables.blocks[id]) this.wanted.blocks.add(id);
  }

  private wantUser(id: unknown) {
    if (isNotionId(id) && !this.tables.users[id]) this.wanted.users.add(id);
  }

  private scanBlock(b: Json) {
    if (b.alive === false || b.type === "personal_home_page") return;
    if (b.space_id !== undefined && b.space_id !== this.job.spaceId) return;
    for (const id of ids(b.content)) this.wantBlock(id);
    const format = isObject(b.format) ? b.format : {};
    for (const pointer of [format.transclusion_reference_pointer, format.alias_pointer]) if (isObject(pointer) && (pointer.table === undefined || pointer.table === "block")) this.wantBlock(pointer.id);
    this.wantUser(b.created_by_id);
    this.wantUser(b.last_edited_by_id);
    for (const value of Object.values(isObject(b.properties) ? b.properties : {})) {
      for (const segment of segmentsOf(value))
        for (const a of annotationsOf(segment)) {
          if (a[0] === "p") this.wantBlock(a[1]);
          else if (a[0] === "u") this.wantUser(a[1]);
        }
    }
    if (b.type === "collection_view" || b.type === "collection_view_page") {
      const pointer = isObject(format.collection_pointer) ? format.collection_pointer : {};
      const collection = isNotionId(b.collection_id) ? b.collection_id : isNotionId(pointer.id) ? pointer.id : null;
      const views = ids(b.view_ids);
      for (const v of views) if (!this.tables.views[v]) this.wanted.views.add(v);
      if (collection) {
        if (!this.tables.collections[collection]) this.wanted.collections.add(collection);
        const known = this.queries.get(collection) ?? [];
        this.queries.set(collection, [...new Set([...known, ...views])]);
      }
    }
  }

  private scan() {
    const fresh = this.fresh;
    this.fresh = [];
    for (const key of fresh) {
      const cut = key.indexOf(":");
      const table = key.slice(0, cut);
      const id = key.slice(cut + 1);
      if (table === "blocks") {
        const b = this.tables.blocks[id];
        if (b) this.scanBlock(b);
      } else {
        const c = this.tables.collections[id];
        if (c && c.alive !== false) for (const t of ids(c.template_pages)) this.wantBlock(t);
      }
    }
  }

  private untried(table: RecordTable, wanted: Set<string>, have: Record<string, Json>): string[] {
    const out: string[] = [];
    for (const id of wanted) {
      if (have[id] || this.tried[table].has(id)) continue;
      this.tried[table].add(id);
      out.push(id);
    }
    wanted.clear();
    return out;
  }

  async sync(table: RecordTable, list: string[]) {
    const chunks: string[][] = [];
    for (let i = 0; i < list.length; i += this.limits.recordsPerSync) chunks.push(list.slice(i, i + this.limits.recordsPerSync));
    await Promise.all(chunks.map((chunk) => this.syncChunk(table, chunk)));
  }

  private async syncChunk(table: RecordTable, chunk: string[]): Promise<void> {
    try {
      const answer = await this.read("syncRecordValuesMain", { requests: chunk.map((id) => ({ pointer: { table, id, spaceId: this.job.spaceId }, version: -1 })) });
      this.absorb(answer.recordMap);
    } catch (error) {
      if (error instanceof TooLarge && chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2);
        await Promise.all([this.syncChunk(table, chunk.slice(0, half)), this.syncChunk(table, chunk.slice(half))]);
        return;
      }
      if (error instanceof TooLarge || error instanceof NotionHttpError) {
        if (table === "block") for (const id of chunk) this.unread.blocks.add(id);
        if (table === "collection") for (const id of chunk) this.unread.collections.add(id);
        this.job.skipped += chunk.length;
        this.deps.log("warn", `notion live: ${table} ×${chunk.length} skipped: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  private async queryOnce(collection: string, view: string, limit: number): Promise<{ ids: string[]; more: boolean }> {
    const loader = { type: "reducer", reducers: { collection_group_results: { type: "results", limit } }, sort: [], searchQuery: "", userTimeZone: "UTC" };
    const spaceId = this.job.spaceId;
    let answer: Json;
    try {
      answer = await this.read("queryCollection", { source: { type: "collection", id: collection, spaceId }, collectionView: { id: view, spaceId }, loader });
    } catch (error) {
      if (!(error instanceof NotionHttpError)) throw error;
      answer = await this.read("queryCollection", { collection: { id: collection, spaceId }, collectionView: { id: view, spaceId }, loader });
    }
    this.absorb(answer.recordMap);
    const result = isObject(answer.result) ? answer.result : {};
    const reducers = isObject(result.reducerResults) ? result.reducerResults : {};
    const group = isObject(reducers.collection_group_results) ? reducers.collection_group_results : result;
    const found = ids(group.blockIds);
    return { ids: found, more: group.hasMore === true || (group.hasMore !== false && found.length >= limit) };
  }

  private async queryRows(collection: string, views: string[]) {
    const view = views.find((v) => this.tables.views[v]) ?? views[0];
    if (!view) return;
    let limit = this.limits.queryFirst;
    let got: string[] | null = null;
    let complete = false;
    for (;;) {
      let page: { ids: string[]; more: boolean };
      try {
        page = await this.queryOnce(collection, view, limit);
      } catch (error) {
        if (error instanceof TooLarge) {
          if (got) break;
          limit = Math.floor(limit / 2);
          if (limit >= this.limits.queryMin) continue;
        }
        if (error instanceof TooLarge || error instanceof NotionHttpError) {
          this.unread.collections.add(collection);
          this.job.skipped++;
          this.deps.log("warn", `notion live: rows of a database skipped: ${error.message}`);
          return;
        }
        throw error;
      }
      got = page.ids;
      if (!page.more) {
        complete = true;
        break;
      }
      if (limit >= this.limits.queryMax) break;
      limit = Math.min(limit * 4, this.limits.queryMax);
    }
    const rows = [...new Set(got ?? [])];
    this.rows[collection] = rows;
    for (const id of rows) this.wantBlock(id);
    if (!complete) {
      this.unread.collections.add(collection);
      this.job.note = `Some databases have more rows than Notes read; it brought in the first ${rows.length.toLocaleString("en-US")} of each.`;
      this.deps.log("warn", `notion live: a database stopped at ${rows.length} rows`);
    }
  }

  tally() {
    const blocks = this.tables.blocks;
    let pagesFound = 0;
    let pagesRead = 0;
    for (const b of Object.values(blocks)) {
      if (b.alive === false || !PAGE_TYPES.has(text(b.type)) || b.type === "personal_home_page") continue;
      pagesFound++;
      if (ids(b.content).every((c) => blocks[c] || this.tried.block.has(c))) pagesRead++;
    }
    for (const id of this.wanted.blocks) if (!blocks[id]) pagesFound++;
    this.job.pagesFound = pagesFound;
    this.job.pagesRead = Math.min(pagesRead, pagesFound);
    this.job.blocks = Object.keys(blocks).length;
    this.job.databases = Object.keys(this.tables.collections).length;
    this.job.rows = Object.values(this.rows).reduce((n, r) => n + r.length, 0);
  }

  async crawl(roots: NotionRoots): Promise<string[]> {
    const missingTeams = roots.teamIds.filter((id) => !roots.teams[id]);
    if (missingTeams.length) await this.sync("team", missingTeams);
    const rootIds = [...roots.pages];
    for (const id of roots.teamIds) {
      const team = this.tables.teams[id];
      rootIds.push(...(roots.teams[id] ?? (team && team.archived_by === undefined ? teamPagesOf(team) : [])));
    }
    const unique = [...new Set(rootIds)];
    for (const id of [...unique, ...roots.seeds]) this.wantBlock(id);
    await this.seedFromSearch();
    if (!this.wanted.blocks.size) throw new ImportError("Notion didn't list any pages in that workspace for you.");
    this.tally();
    for (let round = 0; ; round++) {
      this.check();
      if (round >= this.limits.rounds) throw new ImportError("The workspace's pages nest deeper than Notes follows.");
      const collections = this.untried("collection", this.wanted.collections, this.tables.collections);
      const views = this.untried("collection_view", this.wanted.views, this.tables.views);
      if (collections.length || views.length) await Promise.all([this.sync("collection", collections), this.sync("collection_view", views)]);
      const todo = [...this.queries].filter(([c]) => !this.queried.has(c) && this.tables.collections[c]);
      for (const [c] of todo) this.queried.add(c);
      if (todo.length) await Promise.all(todo.map(([c, v]) => this.queryRows(c, v)));
      this.scan();
      const blocks = this.untried("block", this.wanted.blocks, this.tables.blocks);
      if (blocks.length) await this.sync("block", blocks);
      this.scan();
      this.tally();
      const pending = this.wanted.blocks.size || this.wanted.collections.size || this.wanted.views.size || [...this.queries.keys()].some((c) => !this.queried.has(c) && this.tables.collections[c]);
      if (!blocks.length && !collections.length && !views.length && !todo.length && !pending) break;
    }
    const users = this.untried("notion_user", this.wanted.users, this.tables.users);
    if (users.length) await this.sync("notion_user", users);
    await this.fetchAncestors();
    this.tally();
    return this.rootIds(unique);
  }

  private async seedFromSearch() {
    try {
      const answer = await this.read("search", {
        type: "BlocksInSpace",
        query: "",
        spaceId: this.job.spaceId,
        limit: this.limits.searchLimit,
        filters: { isDeletedOnly: false, excludeTemplates: false, navigableBlockContentOnly: false, requireEditPermissions: false, includePublicPagesWithoutExplicitAccess: false, ancestors: [], createdBy: [], editedBy: [], lastEditedTime: {}, createdTime: {}, inTeams: [] },
        sort: { field: "relevance" },
        source: "quick_find",
      });
      this.absorb(answer.recordMap);
      for (const r of Array.isArray(answer.results) ? answer.results : []) if (isObject(r)) this.wantBlock(r.id);
      this.scan();
    } catch (error) {
      if (!(error instanceof NotionHttpError || error instanceof TooLarge)) throw error;
      this.deps.log("warn", `notion live: search skipped: ${error.message}`);
    }
  }

  private parentOf(rec: Json | undefined): { table: "block" | "collection"; id: string } | null {
    if (!rec) return null;
    const id = text(rec.parent_id, 64);
    if (!isNotionId(id)) return null;
    return rec.parent_table === "block" ? { table: "block", id } : rec.parent_table === "collection" ? { table: "collection", id } : null;
  }

  private recordOf(at: { table: "block" | "collection"; id: string }): Json | undefined {
    return at.table === "block" ? this.tables.blocks[at.id] : this.tables.collections[at.id];
  }

  trashed(id: string): boolean {
    let at: { table: "block" | "collection"; id: string } | null = { table: "block", id };
    for (let depth = 0; at && depth < 64; depth++) {
      const rec = this.recordOf(at);
      if (!rec) return false;
      if (rec.alive === false) return true;
      at = this.parentOf(rec);
    }
    return false;
  }

  private async fetchAncestors() {
    for (let round = 0; round < 16; round++) {
      this.check();
      const blocks = new Set<string>();
      const collections = new Set<string>();
      for (const b of Object.values(this.tables.blocks)) {
        if (b.alive === false || !PAGE_TYPES.has(text(b.type))) continue;
        let at = this.parentOf(b);
        for (let depth = 0; at && depth < 64; depth++) {
          const rec = this.recordOf(at);
          if (!rec) {
            if (!this.tried[at.table].has(at.id)) (at.table === "block" ? blocks : collections).add(at.id);
            break;
          }
          if (rec.alive === false) break;
          at = this.parentOf(rec);
        }
      }
      if (!blocks.size && !collections.size) return;
      for (const id of blocks) this.tried.block.add(id);
      for (const id of collections) this.tried.collection.add(id);
      await Promise.all([blocks.size ? this.sync("block", [...blocks]) : undefined, collections.size ? this.sync("collection", [...collections]) : undefined]);
    }
  }

  rootIds(listed: string[]): string[] {
    const blocks = this.tables.blocks;
    const usable = (b: Json | undefined): b is Json => !!b && b.alive !== false && PAGE_TYPES.has(text(b.type)) && b.type !== "personal_home_page" && (b.space_id === undefined || b.space_id === this.job.spaceId);
    const homes = new Set(Object.values(blocks).filter((b) => b.type === "personal_home_page").map((b) => b.id as string));
    const roots: string[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      roots.push(id);
    };
    for (const id of listed) if (usable(blocks[id]) && !this.trashed(id)) add(id);
    for (const b of Object.values(blocks)) {
      if (!usable(b) || this.trashed(b.id as string)) continue;
      const parent = text(b.parent_id, 64);
      if (homes.has(parent)) continue;
      const table = b.parent_table;
      const orphan = table === "block" ? !blocks[parent] : table === "collection" ? !this.tables.collections[parent] : table === "space" || table === "team";
      if (orphan) add(b.id as string);
    }
    return roots;
  }

  private async sign(refs: FileRef[]): Promise<(string | null)[]> {
    const out: (string | null)[] = [];
    for (let i = 0; i < refs.length; i += this.limits.urlsPerSign) {
      const part = refs.slice(i, i + this.limits.urlsPerSign);
      let signed: unknown[] = [];
      try {
        const answer = await this.read("getSignedFileUrls", { urls: part.map((r) => ({ url: r.source, permissionRecord: { table: r.table, id: r.recordId, spaceId: this.job.spaceId } })) });
        signed = Array.isArray(answer.signedUrls) ? answer.signedUrls : [];
      } catch (error) {
        if (!(error instanceof NotionHttpError || error instanceof TooLarge)) throw error;
        this.deps.log("warn", `notion live: signing ${part.length} files failed: ${error.message}`);
      }
      for (let k = 0; k < part.length; k++) out.push(typeof signed[k] === "string" ? (signed[k] as string) : null);
    }
    return out;
  }

  fileRefs(): FileRef[] {
    const refs = new Map<string, FileRef>();
    const take = (list: FileRef[]) => {
      for (const ref of list) if (!refs.has(ref.source)) refs.set(ref.source, ref);
    };
    for (const b of Object.values(this.tables.blocks)) if (b.alive !== false) take(fileRefsOf(b, "block"));
    for (const c of Object.values(this.tables.collections)) if (c.alive !== false) take(fileRefsOf(c, "collection"));
    for (const v of Object.values(this.tables.views)) if (v.alive !== false) take(fileRefsOf(v, "collection_view"));
    return [...refs.values()];
  }

  async fetchFiles() {
    const list = this.fileRefs();
    this.job.filesFound = list.length;
    if (!list.length) return;
    this.job.stage = "downloading";
    const direct = list.map((ref) => (needsSigning(ref.source) ? null : assetUrl(ref.source, this.bound.origin)));
    const toSign = list.filter((_, i) => direct[i] === null);
    const signedList = toSign.length ? await this.sign(toSign) : [];
    const signed = new Map(toSign.map((ref, i) => [ref.source, signedList[i] ?? null]));
    let room = this.limits.filesBytes;
    for (let i = 0; i < list.length; i++) {
      this.check();
      const ref = list[i]!;
      const url = direct[i] ?? signed.get(ref.source) ?? null;
      if (!url || !(direct[i] || fileHost(url)) || room <= 0) {
        this.job.filesSkipped++;
        continue;
      }
      const path = `${this.dir}/files/${i}-${ref.name}`;
      try {
        const size = await this.downloadOne(url, path, Math.min(this.limits.fileBytes, room));
        room -= size;
        this.files[ref.source] = { path, name: ref.name, size, ...(ref.version ? { version: ref.version } : {}) };
        this.job.filesDone++;
      } catch (error) {
        if (error instanceof Stop || error instanceof ImportError) throw error;
        const code = String((error as { code?: unknown })?.code ?? "");
        this.job.filesSkipped++;
        this.deps.log("warn", `notion live: a file was skipped (${code || "failed"})`);
        if (code === "quota") {
          this.job.filesSkipped += list.length - i - 1;
          this.job.note = "Notes' files are full, so some attachments stayed in Notion.";
          return;
        }
      }
    }
  }

  private async downloadOne(url: string, path: string, maxBytes: number): Promise<number> {
    if (!downloadable(url, this.bound.origin)) throw Object.assign(new Error("That file's address isn't one Notes downloads from."), { code: "refused" });
    const started = await this.untilStopped(this.gate.run(() => this.check(), () => this.sites.download(url, { to: path, maxBytes, session: this.bound.session })));
    this.made.push(path);
    this.download = started;
    try {
      if (this.stopped) await started.cancel().catch(() => undefined);
      let settled: { size: number } | null = null;
      let failure: unknown = null;
      const done = started.done.then(
        (value) => (settled = value),
        (error: unknown) => {
          failure = error ?? new Error("The download failed.");
        },
      );
      while (!settled && !failure) {
        await Promise.race([done, this.deps.sleep(this.limits.downloadCheckMs), this.halted]);
        if (settled || failure) break;
        try {
          this.check();
        } catch (error) {
          await started.cancel().catch(() => undefined);
          throw error;
        }
      }
      if (failure) {
        if ((failure as { code?: unknown }).code === "cancelled" && this.stopped) throw new Stop();
        throw failure;
      }
      return (settled as { size: number } | null)?.size ?? 0;
    } finally {
      this.download = null;
    }
  }

  records(rootIds: string[]): NotionRecords {
    const incomplete = this.unread.collections.size || this.unread.blocks.size ? { incomplete: { collections: [...this.unread.collections], blocks: [...this.unread.blocks] } } : {};
    return { spaceId: this.job.spaceId, rootIds, blocks: this.tables.blocks, collections: this.tables.collections, views: this.tables.views, users: this.tables.users, rows: this.rows, files: this.files, ...incomplete };
  }
}

export class NotionLive {
  private job: NotionCrawl | null = null;
  private current: Crawl | null = null;
  private starting = false;
  private ready: { records: NotionRecords; crawl: Crawl } | null = null;
  private cached: { at: number; account: NotionAccount } | null = null;
  private readonly limits: NotionLiveLimits;

  constructor(private readonly deps: NotionLiveDeps) {
    this.limits = { ...NOTION_LIVE_LIMITS, ...deps.limits };
  }

  private async getSpaces(origin: string, session?: string): Promise<unknown> {
    const sites = this.deps.sites;
    if (!sites) throw new ImportError("This version of Ardia can't use your Notion sign-in yet.");
    const res = await sites.fetch(notionReadUrl(origin, "getSpaces"), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}", timeoutMs: this.limits.requestTimeoutMs, ...(session ? { session } : {}) });
    if (!res.ok) throw new NotionHttpError(res.status, `Notion answered ${res.status}.`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new NotionHttpError(res.status, "Notion's answer wasn't readable.");
    }
  }

  private async supported(): Promise<boolean> {
    const sites = this.deps.sites;
    if (!sites?.session) return false;
    if (!sites.available) return true;
    return sites.available().catch(() => false);
  }

  async account(fresh = false): Promise<NotionAccount> {
    const now = this.deps.now();
    if (!fresh && this.cached && now - this.cached.at < this.limits.statusCacheMs) return this.cached.account;
    const account = (await this.supported()) ? (await this.lookup()).account : ({ state: "unsupported" } as const);
    this.cached = { at: this.deps.now(), account };
    return account;
  }

  private async lookup(session?: string): Promise<{ account: NotionAccount; origin: string | null; answer: unknown }> {
    let signedOut = false;
    let lastError = "";
    for (const origin of NOTION_ORIGINS) {
      try {
        const answer = await this.getSpaces(origin, session);
        const found = spacesFrom(answer);
        if (!found) {
          lastError = "Notion's answer didn't list any workspaces.";
          continue;
        }
        return { account: { state: "signedIn", user: found.user, spaces: found.spaces }, origin, answer };
      } catch (error) {
        if (error instanceof NotionHttpError) {
          if (error.status === 401 || error.status === 403) signedOut = true;
          else lastError = error.message;
          continue;
        }
        lastError = error instanceof Error ? error.message : String(error);
        const code = String((error as { code?: unknown })?.code ?? "");
        if (TERMINAL_CODES.has(code)) return { account: UNSUPPORTED_CODES.has(code) ? { state: "unsupported" } : { state: "unavailable", reason: lastError }, origin: null, answer: null };
      }
    }
    return { account: signedOut ? { state: "signedOut" } : { state: "unavailable", reason: lastError || "Notion didn't answer." }, origin: null, answer: null };
  }

  status(): NotionCrawl | null {
    return this.job ? { ...this.job } : null;
  }

  busy(): boolean {
    return this.starting || this.job?.stage === "reading" || this.job?.stage === "downloading" || this.job?.stage === "cancelling";
  }

  async start(spaceId: string): Promise<NotionCrawl> {
    if (this.busy()) throw new ImportError("Notes is already reading a Notion workspace.");
    const job: NotionCrawl = { stage: "reading", spaceId, spaceName: "", pagesFound: 0, pagesRead: 0, blocks: 0, databases: 0, rows: 0, filesFound: 0, filesDone: 0, filesSkipped: 0, skipped: 0, startedAt: this.deps.now() };
    this.job = job;
    this.starting = true;
    let cancelledEarly = false;
    const early = { cancel: () => void (cancelledEarly = true) };
    this.pendingCancel = early;
    try {
      const sites = this.deps.sites;
      if (!sites?.session || !(await this.supported())) throw new ImportError("This version of Ardia can't use your Notion sign-in. Choose a file instead.");
      const session = await sites.session();
      if (cancelledEarly) throw new Stop();
      const found = await this.lookup(session);
      if (cancelledEarly) throw new Stop();
      this.cached = { at: this.deps.now(), account: found.account };
      const account = found.account;
      if (account.state !== "signedIn" || !found.origin) throw new ImportError(account.state === "signedOut" ? "Sign in to Notion in Ardia first." : account.state === "unavailable" ? account.reason : "This version of Ardia can't use your Notion sign-in. Choose a file instead.");
      const space = account.spaces.find((s) => s.id === spaceId);
      if (!space) throw new ImportError("That workspace isn't one your Notion account can see.");
      if (!space.canImport) throw new ImportError(space.reason ?? "Notes can't bring in that workspace.");
      await this.discard();
      await this.sweep();
      job.spaceName = space.name;
      const crawl = new Crawl(this.deps, this.limits, sites, { origin: found.origin, userId: account.user.id, session }, job);
      this.current = crawl;
      const roots = rootsFrom(found.answer, spaceId);
      void this.run(crawl, roots).catch((error) => this.deps.log("warn", `notion live: ${String(error)}`));
      return { ...job };
    } catch (error) {
      if (error instanceof Stop) job.stage = "cancelled";
      else {
        job.stage = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
      if (error instanceof Stop) return { ...job };
      throw error;
    } finally {
      this.starting = false;
      this.pendingCancel = null;
    }
  }

  private pendingCancel: { cancel(): void } | null = null;

  async cancel(): Promise<void> {
    if (!this.busy() || !this.job) return;
    this.pendingCancel?.cancel();
    this.job.stage = "cancelling";
    const crawl = this.current;
    if (!crawl) return;
    crawl.stop();
    await crawl.download?.cancel().catch(() => undefined);
  }

  takeRecords(): NotionRecordsHandoff | null {
    const ready = this.ready;
    if (!ready) return null;
    this.ready = null;
    if (this.job?.stage === "ready") this.job = { ...this.job, stage: "idle" };
    return { records: ready.records, release: () => this.cleanup(ready.crawl) };
  }

  async discard() {
    const ready = this.ready;
    this.ready = null;
    if (ready) await this.cleanup(ready.crawl);
  }

  private async cleanup(crawl: Crawl) {
    for (const path of crawl.made.splice(0)) await this.deps.removeFile(path).catch(() => undefined);
    await this.deps.removeFile(`${crawl.dir}/files`).catch(() => undefined);
    await this.deps.removeFile(crawl.dir).catch(() => undefined);
  }

  private async sweep() {
    if (!this.deps.listFiles) return;
    const entries = await this.deps.listFiles(NOTION_LIVE_DIR).catch(() => []);
    const files = entries.filter((e) => e.kind === "file").map((e) => e.path);
    const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.path).sort((a, b) => b.length - a.length);
    for (const path of [...files, ...dirs]) await this.deps.removeFile(path.startsWith(`${NOTION_LIVE_DIR}/`) ? path : `${NOTION_LIVE_DIR}/${path}`).catch(() => undefined);
  }

  private async run(crawl: Crawl, roots: NotionRoots) {
    const { job } = crawl;
    try {
      const rootIds = await crawl.crawl(roots);
      await crawl.fetchFiles();
      crawl.check();
      crawl.tally();
      this.ready = { records: crawl.records(rootIds), crawl };
      job.stage = "ready";
    } catch (error) {
      crawl.stop();
      await crawl.download?.cancel().catch(() => undefined);
      await this.cleanup(crawl);
      if (error instanceof Stop) job.stage = "cancelled";
      else {
        job.stage = "failed";
        job.error = error instanceof ImportError ? error.message : `Reading Notion stopped: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
      }
    } finally {
      if (this.current === crawl) this.current = null;
    }
  }
}
