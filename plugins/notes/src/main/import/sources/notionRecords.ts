import * as Y from "yjs";
import type { NotionRecords } from "../../../shared/notionRecords";
import {
  addOption,
  addProperty,
  addView,
  compileFormula,
  isError,
  propEntry,
  readSchema,
  rememberPerson,
  renameProperty,
  setCalc,
  setGroupState,
  setViewProp,
  settingsOf,
  schemaOf,
  viewsOf,
  updateSettings,
  NONE,
  TITLE,
  type CalcFn,
  type Color,
  type FilterCond,
  type FilterGroup,
  type FilterRule,
  type NumberFormat,
  type PropType,
  type Property,
  type RelativeRange,
  type RollupFn,
  type StatusGroup,
  type ViewType,
} from "../../../shared/database";
import { blocksOf, childrenOf, orderBetween, pagesOf, slug } from "../../../shared/model";
import { buildGroup, emptyParagraph, safeHref, type Block, type Inline, type Styles, type TableContent } from "../../tools/blocks";
import { IMPORT_LIMITS, ImportCancelled } from "../limits";
import { readImports, type Sink, type WriteProgress } from "../write";
import { Sha256 } from "../../sha256";
import { READ_AHEAD_COUNT, ReadAhead } from "../readAhead";
import { isNotionUuid, knownPageIds, notionPageFamilies, pickPageId, recordsOnlyFamily } from "../notionIds";
import { bodyPrint, EMPTY_BODY, printOf, Rebase, seedBody } from "../rebase";

type Rec = Record<string, any>;
type Seg = [string, any[]?];

export const notionRecordId = (spaceId: string) => `notion-${(spaceId || "workspace").replace(/[^0-9a-z-]/gi, "").slice(0, 48)}`;

export type RecordsReader = { read(path: string): Promise<Uint8Array>; size?(path: string): number };

export type RecordsResult = { roots: string[]; pageIds: string[]; archived: number; pages: number; databases: number; attachments: number; skipped: number; conflicts: number; ids: Map<string, string>; files: Record<string, string> };

export type RecordsOptions = { workspace?: string; progress?: (p: WriteProgress) => void; cancelled?: () => boolean; now?: number; onRoots?: (roots: string[]) => void; files?: Record<string, string> };

const yieldNow = () => new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

export function unwrapRecord(raw: unknown): Rec | null {
  let v: any = raw;
  for (let i = 0; i < 4 && v && typeof v === "object" && !("id" in v) && v.value && typeof v.value === "object"; i++) v = v.value;
  return v && typeof v === "object" && typeof v.id === "string" ? v : null;
}

function unwrapTable(table: Record<string, any> | undefined, dead?: Map<string, Rec>): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const [key, raw] of Object.entries(table ?? {})) {
    const rec = unwrapRecord(raw);
    if (!rec) continue;
    if (rec.alive !== false) out.set(rec.id || key, rec);
    else dead?.set(rec.id || key, rec);
  }
  return out;
}

const PAGE_TYPES = new Set(["page", "collection_view_page", "personal_home_page"]);
const DB_TYPES = new Set(["collection_view", "collection_view_page"]);

const NOTION_COLORS: Record<string, Color> = { default: "default", gray: "gray", brown: "brown", orange: "orange", yellow: "yellow", green: "green", teal: "green", blue: "blue", purple: "purple", pink: "pink", red: "red" };

export function notionColor(raw: unknown): { textColor?: Color; backgroundColor?: Color } {
  if (typeof raw !== "string" || !raw) return {};
  const background = raw.endsWith("_background");
  const color = NOTION_COLORS[background ? raw.slice(0, -"_background".length) : raw];
  if (!color || color === "default") return {};
  return background ? { backgroundColor: color } : { textColor: color };
}

const optionColor = (raw: unknown): Color => NOTION_COLORS[String(raw ?? "default")] ?? "default";

const ICON_EMOJI: Record<string, string> = {
  checkmark: "✅",
  "checkmark-square": "☑️",
  checklist: "📋",
  "user-circle": "👤",
  user: "👤",
  users: "👥",
  groups: "👥",
  friends: "🧑‍🤝‍🧑",
  "chart-pie": "📊",
  chart: "📈",
  gem: "💎",
  network: "🕸️",
  atm: "🏧",
  package: "📦",
  activity: "📈",
  "construction-crane": "🏗️",
  target: "🎯",
  "light-bulb": "💡",
  rocket: "🚀",
  "arrow-northeast": "↗️",
  "arrow-right": "➡️",
  wall: "🧱",
  star: "⭐",
  username: "📧",
  document: "📄",
  book: "📕",
  calendar: "📅",
  clock: "🕒",
  home: "🏠",
  heart: "❤️",
  flag: "🚩",
  folder: "📁",
  globe: "🌐",
  lock: "🔒",
  pin: "📌",
  tag: "🏷️",
  bug: "🐛",
  code: "💻",
  gear: "⚙️",
  "task-db-icon": "✅",
  "collection-table": "🗂️",
};

export function notionIconEmoji(raw: string): string {
  const base = raw.split("?")[0]!.split("/").pop() ?? "";
  const name = base.replace(/\.[0-9a-f]{6,}(?=\.)/, "").replace(/\.(svg|png|jpe?g)$/i, "").replace(/_(gray|lightgray|brown|orange|yellow|green|blue|purple|pink|red)$/, "");
  return ICON_EMOJI[name] ?? "📄";
}

const COVER_COLORS: Record<string, number> = { red: 0, orange: 1, yellow: 2, green: 3, blue: 4, purple: 5, pink: 6, gray: 7, black: 8, beige: 9 };

export function notionCoverFallback(raw: string): string {
  const name = raw.split("?")[0]!.split("/").pop() ?? "";
  const solid = /^solid_([a-z]+)\./.exec(name);
  if (solid && COVER_COLORS[solid[1]!] !== undefined) return `color:${COVER_COLORS[solid[1]!]}`;
  const gradient = /^gradients?_(\d+)\./.exec(name);
  if (gradient) return `gradient:${(Number(gradient[1]) - 1 + 12) % 12}`;
  return "";
}

const LANGUAGES: Record<string, string> = { "plain text": "text", "c++": "cpp", "c#": "csharp", "f#": "fsharp", shell: "shell", "objective-c": "objective-c", "vb.net": "vb", "java/c/c++/c#": "java", "markup": "html", "docker": "dockerfile", "llvm ir": "llvm" };

export function codeLanguage(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!name) return "text";
  return (LANGUAGES[name] ?? name.replace(/\s+/g, "")).slice(0, 40);
}

const NUMBER_FORMATS: Record<string, NumberFormat> = {
  number: "number",
  number_with_commas: "commas",
  percent: "percent",
  dollar: "dollar",
  euro: "euro",
  pound: "pound",
  yen: "yen",
  rupee: "rupee",
  won: "won",
  yuan: "yuan",
  franc: "franc",
  real: "real",
  ruble: "ruble",
};

const AGGREGATORS: Record<string, Exclude<CalcFn, "none">> = {
  count: "count",
  count_all: "count",
  count_values: "count_values",
  unique: "unique",
  count_unique_values: "unique",
  empty: "empty",
  count_empty: "empty",
  not_empty: "not_empty",
  count_not_empty: "not_empty",
  percent_empty: "percent_empty",
  percent_not_empty: "percent_not_empty",
  checked: "checked",
  unchecked: "unchecked",
  percent_checked: "percent_checked",
  percent_unchecked: "percent_unchecked",
  sum: "sum",
  average: "avg",
  median: "median",
  min: "min",
  max: "max",
  range: "range",
  earliest_date: "earliest",
  latest_date: "latest",
  date_range: "date_range",
};

const RELATIVE: Record<string, RelativeRange> = {
  today: "today",
  tomorrow: "tomorrow",
  yesterday: "yesterday",
  one_week_ago: "past_week",
  one_week_from_now: "next_week",
  one_month_ago: "past_month",
  one_month_from_now: "next_month",
  one_year_ago: "past_year",
  one_year_from_now: "next_year",
  this_week: "this_week",
  this_month: "this_month",
  this_year: "this_year",
  past_week: "past_week",
  past_month: "past_month",
  past_year: "past_year",
  next_week: "next_week",
  next_month: "next_month",
  next_year: "next_year",
};

const VIEW_TYPES: Record<string, ViewType> = { table: "table", board: "board", list: "list", gallery: "gallery", calendar: "calendar", timeline: "timeline", chart: "chart", form_editor: "form", form: "form", feed: "list", map: "table", dashboard: "table" };

const PERSON_COLORS = ["#c1575c", "#d87249", "#e3ac38", "#3eb489", "#4691c3", "#7873af", "#c07a98", "#8e8e93"];

export const personId = (notionUser: string) => `n${notionUser.replace(/[^0-9a-f]/gi, "").toLowerCase()}`.slice(0, 33);

function hashColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

const NOTION_ID = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i;

export function notionIdIn(raw: string): string | null {
  const m = NOTION_ID.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase() : null;
}

function dateOf(d: Rec | undefined): { start: string; end?: string } | null {
  if (!d || typeof d.start_date !== "string") return null;
  const at = (date: string, time?: string) => (time && /^\d{2}:\d{2}/.test(time) ? `${date}T${time.slice(0, 5)}` : date);
  const start = at(d.start_date, d.start_time);
  const end = typeof d.end_date === "string" ? at(d.end_date, d.end_time) : undefined;
  return end && end !== start ? { start, end } : { start };
}

const segsOf = (v: unknown): Seg[] => (Array.isArray(v) ? (v.filter((s) => Array.isArray(s) && typeof s[0] === "string") as Seg[]) : []);

type Asset = { url: string; name: string } | null;

type Collection = { id: string; rec: Rec; owner: string; defaults: Map<string, string>; props: Map<string, string>; names: Map<string, string>; types: Map<string, string>; options: Map<string, Map<string, string>>; groups: Map<string, Map<string, string[]>> };

type Node = { notion: string; id: string; parent: string; kind: "page" | "database"; order: string; title: string; collection?: string; linked?: string; views?: string[]; inline?: boolean; row?: boolean; template?: boolean };

export class NotionRecordsImport {
  private readonly blocks: Map<string, Rec>;
  private readonly collections: Map<string, Rec>;
  private readonly views: Map<string, Rec>;
  private readonly users: Map<string, Rec>;
  private readonly nodes = new Map<string, Node>();
  private readonly dbOf = new Map<string, string>();
  private readonly extraDbs = new Map<string, string[]>();
  private readonly colls = new Map<string, Collection>();
  private readonly lastOrder = new Map<string, string>();
  private readonly assets = new Map<string, Asset>();
  private readonly fileMarks: Record<string, string> = {};
  private readonly ahead = new ReadAhead<string>((path) => this.reader.read(path), (path) => this.reader.size?.(path) ?? this.fileSizes.get(path) ?? 0);
  private readonly fileSizes = new Map<string, number>();
  private predicted: string[] = [];
  private predictedAt = new Map<string, number>();
  private readonly counts = { pages: 0, databases: 0, attachments: 0, skipped: 0 };
  private readonly workspace: string;
  private readonly me: string;
  private now: number;

  constructor(
    private readonly records: NotionRecords,
    private readonly sink: Sink,
    private readonly reader: RecordsReader,
    private readonly options: RecordsOptions = {},
  ) {
    this.blocks = unwrapTable(records.blocks, this.deadBlocks);
    this.collections = unwrapTable(records.collections, this.deadCollections);
    this.views = unwrapTable(records.views);
    this.users = unwrapTable(records.users);
    this.workspace = options.workspace ?? "";
    this.now = options.now ?? Date.now();
    const first = records.rootIds.map((id) => this.blocks.get(id)).find(Boolean);
    this.me = String(first?.created_by_id ?? [...this.users.keys()][0] ?? "");
  }

  private nextOrder(parent: string): string {
    const order = orderBetween(this.lastOrder.get(parent) ?? null, null);
    this.lastOrder.set(parent, order);
    return order;
  }

  private titleOf(rec: Rec | undefined): string {
    if (!rec) return "";
    return segsOf(rec.properties?.title)
      .map((s) => this.plainSeg(s))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  private userName(id: string): string {
    return String(this.users.get(id)?.name ?? "Someone");
  }

  private plainSeg([text, anns]: Seg): string {
    for (const a of anns ?? []) {
      if (!Array.isArray(a)) continue;
      if (a[0] === "p") {
        const target = this.blocks.get(a[1]);
        return target ? this.titleOf(target) || "Untitled" : "Untitled";
      }
      if (a[0] === "u") return `@${this.userName(a[1])}`;
      if (a[0] === "d") return dateOf(a[1])?.start ?? text;
      if (a[0] === "e") return String(a[1] ?? "");
      if (a[0] === "lm") return String(a[1]?.title || a[1]?.href || text);
      if (a[0] === "eoi") return this.eoiTitle(a[1]) || text;
    }
    return text;
  }

  plain(v: unknown): string {
    return segsOf(v)
      .map((s) => this.plainSeg(s))
      .join("");
  }

  private eoiUrl(id: string): string {
    const rec = this.blocks.get(id);
    return String(rec?.format?.original_url ?? rec?.format?.uri ?? "");
  }

  private eoiTitle(id: string): string {
    const rec = this.blocks.get(id);
    const title = this.titleOf(rec);
    if (title) return title;
    const url = this.eoiUrl(id);
    if (!url) return "";
    const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
    if (!m) return url;
    const tail = m[2]!.split("/").filter(Boolean).slice(-2).join("/");
    return `${m[1]}${tail ? ` › ${tail}` : ""}`;
  }

  private hrefFor(raw: string): string | null {
    const value = raw.trim();
    const internal = /^\/[0-9a-f]{32}/i.test(value) || /^https?:\/\/(www\.)?notion\.(so|site|com)\//i.test(value) || /^https?:\/\/app\.notion\.com\//i.test(value);
    if (internal) {
      const id = notionIdIn(value.split("#")[0]!.split("?")[0]!.split("/").pop() ?? "") ?? notionIdIn(value);
      const node = id ? this.nodes.get(id) : undefined;
      if (node) return `ardia://notes/${slug(node.title)}-${node.id}`;
      if (value.startsWith("/")) return `https://www.notion.so${value}`;
    }
    return safeHref(value) ? value : null;
  }

  inline(v: unknown): Inline[] {
    const out: Inline[] = [];
    for (const seg of segsOf(v)) {
      const [text, anns] = seg;
      const styles: Styles = {};
      let href: string | null = null;
      let special: Inline[] | null = null;
      for (const a of anns ?? []) {
        if (!Array.isArray(a)) continue;
        switch (a[0]) {
          case "b":
            styles.bold = true;
            break;
          case "i":
            styles.italic = true;
            break;
          case "s":
            styles.strike = true;
            break;
          case "c":
            styles.code = true;
            break;
          case "_":
            styles.underline = true;
            break;
          case "h":
            Object.assign(styles, notionColor(a[1]));
            break;
          case "a":
            href = typeof a[1] === "string" ? this.hrefFor(a[1]) : null;
            break;
          case "p": {
            const node = this.nodes.get(a[1]);
            if (node) special = [{ type: "mention", props: { kind: "page", pageId: node.id } }];
            else {
              const title = this.titleOf(this.blocks.get(a[1])) || "Notion page";
              special = [{ type: "link", href: `https://www.notion.so/${String(a[1]).replace(/-/g, "")}`, content: [{ type: "text", text: title, styles: { ...styles } }] }];
            }
            break;
          }
          case "u": {
            const name = this.userName(a[1]);
            special = [{ type: "mention", props: { kind: "user", name, color: hashColor(personId(a[1])) } }];
            break;
          }
          case "d": {
            const d = dateOf(a[1]);
            if (d) {
              special = [{ type: "mention", props: { kind: "date", date: d.start } }];
              if (d.end) special.push({ type: "text", text: ` → ${d.end}`, styles: {} });
            }
            break;
          }
          case "e":
            special = [{ type: "inlineEquation", content: String(a[1] ?? "") }];
            break;
          case "lm": {
            const url = typeof a[1]?.href === "string" ? this.hrefFor(a[1].href) : null;
            const title = String(a[1]?.title || a[1]?.href || text);
            special = url ? [{ type: "link", href: url, content: [{ type: "text", text: title, styles: { ...styles } }] }] : [{ type: "text", text: title, styles: { ...styles } }];
            break;
          }
          case "eoi": {
            const url = this.hrefFor(this.eoiUrl(a[1]));
            const title = this.eoiTitle(a[1]) || text;
            special = url ? [{ type: "link", href: url, content: [{ type: "text", text: title, styles: { ...styles } }] }] : [{ type: "text", text: title, styles: { ...styles } }];
            break;
          }
        }
      }
      if (special) out.push(...special);
      else if (!text) continue;
      else if (href) out.push({ type: "link", href, content: [{ type: "text", text, styles }] });
      else out.push({ type: "text", text, styles });
    }
    return out;
  }

  private collectionFor(block: Rec): string | null {
    const id = block.collection_id ?? block.format?.collection_pointer?.id;
    if (id && this.collections.has(id)) return id;
    for (const v of block.view_ids ?? []) {
      const pointer = this.views.get(v)?.format?.collection_pointer?.id;
      if (pointer && this.collections.has(pointer)) return pointer;
    }
    return null;
  }

  private readonly byId = new Map<string, Node>();
  private viewScope = "";

  stableId(key: string): string {
    const bytes = new TextEncoder().encode(`notion:${this.workspace}:${key}`);
    return Array.from(new Sha256().update(bytes).digest().subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private pageId(notion: string): string {
    const families = isNotionUuid(notion) ? notionPageFamilies(this.workspace, notion) : recordsOnlyFamily(this.workspace, notion);
    return pickPageId(pagesOf(this.sink.tree), (id) => this.byId.has(id), families) ?? newHex();
  }

  private addNode(notion: string, parent: string, kind: "page" | "database", title: string, extra: Partial<Node> = {}): Node {
    const node: Node = { notion, id: this.pageId(notion), parent, kind, order: this.nextOrder(parent), title, ...extra };
    this.nodes.set(notion, node);
    this.byId.set(node.id, node);
    return node;
  }

  private readonly deadBlocks = new Map<string, Rec>();
  private readonly deadCollections = new Map<string, Rec>();
  private readonly trashCache = new Map<string, boolean>();

  trashed(id: string): boolean {
    const known = this.trashCache.get(id);
    if (known !== undefined) return known;
    let rec: Rec | undefined = this.blocks.get(id) ?? this.deadBlocks.get(id);
    let result = false;
    for (let depth = 0; rec && depth < 64; depth++) {
      if (rec.alive === false) {
        result = true;
        break;
      }
      const parent = String(rec.parent_id ?? "");
      if (rec.parent_table === "block") rec = this.blocks.get(parent) ?? this.deadBlocks.get(parent);
      else if (rec.parent_table === "collection") rec = this.collections.get(parent) ?? this.deadCollections.get(parent);
      else break;
    }
    this.trashCache.set(id, result);
    return result;
  }

  private visitPage(id: string, parent: string, row = false, template = false) {
    if (this.nodes.has(id) || this.nodes.size >= IMPORT_LIMITS.pages) return;
    const rec = this.blocks.get(id);
    if (!rec || this.trashed(id)) return;
    if (DB_TYPES.has(rec.type)) return this.visitDb(id, parent, rec.type === "collection_view");
    const node = this.addNode(id, parent, "page", this.titleOf(rec), { row, template });
    this.scan(rec.content ?? [], node.id, new Set([id]));
  }

  private scan(ids: string[], parent: string, seen: Set<string>) {
    for (const child of ids) {
      if (seen.has(child)) continue;
      seen.add(child);
      const rec = this.blocks.get(child);
      if (!rec) continue;
      if (rec.type === "page" || rec.type === "collection_view_page") this.visitPage(child, parent);
      else if (rec.type === "collection_view") this.visitDb(child, parent, true);
      else if (rec.type === "transclusion_reference") {
        const source = rec.format?.transclusion_reference_pointer?.id;
        const target = source ? this.blocks.get(source) : null;
        if (target) this.scan(target.content ?? [], parent, seen);
      } else if (Array.isArray(rec.content)) this.scan(rec.content, parent, seen);
    }
  }

  private visitDb(id: string, parent: string, inline: boolean) {
    if (this.nodes.has(id) || this.trashed(id)) return;
    const rec = this.blocks.get(id)!;
    const collection = this.collectionFor(rec);
    const coll = collection ? this.collections.get(collection) : undefined;
    const title = this.titleOf(rec) || this.plain(coll?.name) || "";
    const viewIds: string[] = (rec.view_ids ?? []).filter((v: string) => this.views.has(v));
    const byCollection = new Map<string, string[]>();
    for (const v of viewIds) {
      const pointer = this.views.get(v)?.format?.collection_pointer?.id;
      const key = pointer && this.collections.has(pointer) ? pointer : (collection ?? "");
      (byCollection.get(key) ?? byCollection.set(key, []).get(key)!).push(v);
    }
    const mainViews = byCollection.get(collection ?? "") ?? (viewIds.length ? [] : []);
    const node = this.addNode(id, parent, "database", title, { ...(collection ? { collection } : {}), views: mainViews, inline });
    if (collection) this.claim(collection, id);
    this.dbOf.set(id, node.id);
    const extras: string[] = [];
    for (const [key, views] of byCollection) {
      if (key === (collection ?? "") || !key) continue;
      const extraKey = `${id}:${key}`;
      const extra = this.addNode(extraKey, inline ? parent : node.id, "database", this.plain(this.collections.get(key)?.name) || title, { collection: key, views, inline: true });
      this.claim(key, extraKey);
      extras.push(extraKey);
    }
    if (extras.length) this.extraDbs.set(id, extras);
  }

  private owners = new Map<string, string>();

  private claim(collection: string, block: string) {
    const coll = this.collections.get(collection)!;
    const current = this.owners.get(collection);
    if (!current || coll.parent_id === block.split(":")[0]) this.owners.set(collection, block);
  }

  private plan() {
    for (const root of this.records.rootIds) this.visitPage(root, "");
    for (let pass = 0; pass < 8; pass++) {
      let added = 0;
      for (const [id, rec] of this.blocks) {
        if (this.nodes.has(id) || !(rec.type === "page" || rec.type === "collection_view_page")) continue;
        if (rec.parent_table !== "block") continue;
        const parent = this.nodes.get(rec.parent_id);
        if (!parent || parent.kind !== "page") continue;
        this.visitPage(id, parent.id);
        added++;
      }
      if (!added) break;
    }
    const pending = [...this.owners];
    for (let i = 0; i < pending.length; i++) {
      const [collection, owner] = pending[i]!;
      const node = this.nodes.get(owner)!;
      node.linked = undefined;
      const rows = this.records.rows[collection] ?? [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row)) continue;
        seen.add(row);
        this.visitPage(row, node.id, true);
      }
      const coll = this.collections.get(collection);
      for (const t of coll?.template_pages ?? []) this.visitPage(t, node.id, true, true);
      for (const [id, rec] of this.blocks) if (!this.nodes.has(id) && rec.parent_table === "collection" && rec.parent_id === collection && rec.type === "page") this.visitPage(id, node.id, true, rec.is_template === true);
      for (const [collectionB, ownerB] of this.owners) if (!pending.some(([c]) => c === collectionB)) pending.push([collectionB, ownerB]);
    }
    for (const node of this.nodes.values()) {
      if (node.kind !== "database" || !node.collection) continue;
      const owner = this.owners.get(node.collection);
      if (owner && owner !== node.notion) node.linked = this.nodes.get(owner)!.id;
    }
  }

  private async asset(raw: string | undefined, nameHint = ""): Promise<Asset> {
    if (!raw) return null;
    if (this.assets.has(raw)) return this.assets.get(raw)!;
    const done = (value: Asset) => {
      this.assets.set(raw, value);
      return value;
    };
    const entry = this.fileEntry(raw);
    if (entry) {
      this.readAheadFrom(raw);
      try {
        if (entry.size > IMPORT_LIMITS.attachmentBytes) throw new Error("too big");
        const name = (entry.name || nameHint || entry.path.split("/").pop() || "file").slice(0, 255);
        const mark = this.fileMark(raw, entry);
        const known = mark ? this.options.files?.[mark] : undefined;
        if (mark && known && /^[0-9a-f]{64}$/.test(known) && this.sink.hasFile && (await this.sink.hasFile(known, entry.size))) {
          this.fileMarks[mark] = known;
          this.counts.attachments++;
          return done({ url: `file:${known}`, name });
        }
        const bytes = await this.ahead.take(entry.path);
        const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? sniffExt(bytes) ?? /\.([a-z0-9]{1,8})(?:$|\?)/i.exec(raw)?.[1] ?? /[?&]fm=([a-z0-9]{2,5})/i.exec(raw)?.[1] ?? "bin").toLowerCase();
        const sha = await this.sink.putFile(bytes, ext);
        if (mark && bytes.length === entry.size) this.fileMarks[mark] = sha;
        this.counts.attachments++;
        return done({ url: `file:${sha}`, name });
      } catch (error) {
        if (error instanceof ImportCancelled) throw error;
        this.counts.skipped++;
      }
    }
    const data = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
    if (data) {
      try {
        const bytes = Uint8Array.from(atob(data[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
        const ext = (data[1]!.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace("svg+xml", "svg");
        const sha = await this.sink.putFile(bytes, ext);
        this.counts.attachments++;
        return done({ url: `file:${sha}`, name: nameHint || `image.${ext}` });
      } catch {
        this.counts.skipped++;
        return done(null);
      }
    }
    const absolute = raw.startsWith("/") ? `https://www.notion.so${raw}` : raw;
    if (/^https:\/\//i.test(absolute) && safeHref(absolute, true)) return done({ url: absolute, name: nameHint || absolute.split("?")[0]!.split("/").pop() || "" });
    if (raw.startsWith("attachment:")) this.counts.skipped++;
    return done(null);
  }

  private fileEntry(raw: string) {
    return this.records.files[raw] ?? this.records.files[raw.split("?")[0]!] ?? this.fileBySuffix(raw);
  }

  private fileMark(raw: string, entry: { size: number; version?: unknown }): string | null {
    const version = typeof entry.version === "string" && entry.version ? entry.version.slice(0, 200) : null;
    return version ? this.stableId(`file:${raw.split("?")[0]}:${entry.size}:${version}`) : null;
  }

  private readAheadFrom(raw: string) {
    const at = this.predictedAt.get(raw);
    if (at === undefined) return;
    const paths: string[] = [];
    for (let i = at; i < this.predicted.length && paths.length < READ_AHEAD_COUNT; i++) {
      const next = this.predicted[i]!;
      if (i > at && this.assets.has(next)) continue;
      const entry = this.fileEntry(next);
      if (!entry || entry.size > IMPORT_LIMITS.attachmentBytes) continue;
      const mark = this.fileMark(next, entry);
      if (mark && this.options.files?.[mark]) continue;
      this.fileSizes.set(entry.path, entry.size);
      if (!paths.includes(entry.path)) paths.push(entry.path);
    }
    this.ahead.keep(paths);
  }

  private predictAssets(nodes: Node[]) {
    const out: string[] = [];
    const add = (raw: unknown) => {
      if (typeof raw === "string" && raw && this.fileEntry(raw)) out.push(raw);
    };
    for (const n of nodes) {
      const rec = this.blocks.get(n.notion.split(":")[0]!);
      const coll = n.collection ? this.collections.get(n.collection) : undefined;
      add(rec?.format?.page_icon ?? (n.kind === "database" && !n.notion.includes(":") ? coll?.icon : undefined));
      add(n.row || n.kind === "page" ? rec?.format?.page_cover : (rec?.format?.page_cover ?? coll?.cover));
    }
    for (const n of nodes) for (const v of n.kind === "database" ? (n.views ?? []) : []) add(this.views.get(v)?.format?.collection_view_icon);
    const walk = (ids: unknown, depth: number, seen: Set<string>) => {
      if (!Array.isArray(ids) || depth > IMPORT_LIMITS.depth) return;
      for (const id of ids) {
        if (typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);
        const rec = this.blocks.get(id);
        if (!rec || rec.type === "page" || rec.type === "collection_view_page" || rec.type === "collection_view") continue;
        if (rec.type === "callout") add(rec.format?.page_icon);
        if (["image", "video", "audio", "pdf", "file"].includes(String(rec.type))) add(segsOf(rec.properties?.source)[0]?.[0] ?? rec.format?.display_source);
        walk(rec.content, depth + 1, seen);
      }
    };
    for (const n of nodes) {
      if (n.kind !== "page") continue;
      const rec = this.blocks.get(n.notion);
      if (!rec) continue;
      for (const raw of Object.values(rec.properties ?? {}))
        for (const [name, anns] of segsOf(raw)) {
          const href = (anns ?? []).find((a) => Array.isArray(a) && a[0] === "a")?.[1];
          add(typeof href === "string" ? href : name);
        }
      walk(rec.content, 0, new Set([rec.id]));
    }
    this.predicted = out;
    for (let i = out.length - 1; i >= 0; i--) this.predictedAt.set(out[i]!, i);
  }

  private fileBySuffix(raw: string) {
    const id = /^attachment:([0-9a-f-]{36})/i.exec(raw)?.[1];
    if (!id) return undefined;
    for (const [key, entry] of Object.entries(this.records.files)) if (key.includes(id)) return entry;
    return undefined;
  }

  private async icon(raw: unknown): Promise<string> {
    if (typeof raw !== "string" || !raw) return "";
    if (!/^(\/|https?:|attachment:|data:)/.test(raw)) return [...raw].slice(0, 8).join("");
    const found = this.records.files[raw] || raw.startsWith("data:") || raw.startsWith("attachment:") || /^https?:/.test(raw) ? await this.asset(raw) : null;
    if (found?.url.startsWith("file:")) return found.url;
    return notionIconEmoji(raw);
  }

  private async cover(raw: unknown): Promise<string> {
    if (typeof raw !== "string" || !raw) return "";
    const found = this.records.files[raw] || raw.startsWith("attachment:") || /^https?:/.test(raw) ? await this.asset(raw) : null;
    if (found?.url.startsWith("file:")) return found.url;
    return notionCoverFallback(raw);
  }

  private async media(rec: Rec): Promise<Asset> {
    const source = segsOf(rec.properties?.source)[0]?.[0] ?? rec.format?.display_source;
    const name = this.plain(rec.properties?.title);
    return this.asset(source, name);
  }

  private async convertList(ids: string[], depth: number, seen: Set<string>): Promise<Block[]> {
    const out: Block[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const rec = this.blocks.get(id);
      if (!rec) {
        this.counts.skipped++;
        continue;
      }
      out.push(...(await this.convert(rec, depth, seen)));
    }
    return out;
  }

  private async children(rec: Rec, depth: number, seen: Set<string>): Promise<Block[]> {
    if (depth >= IMPORT_LIMITS.depth || !Array.isArray(rec.content)) return [];
    return this.convertList(rec.content, depth + 1, seen);
  }

  private async convert(rec: Rec, depth: number, seen: Set<string>): Promise<Block[]> {
    const f: Rec = rec.format ?? {};
    const color = notionColor(f.block_color);
    const block = (type: string, props: Record<string, unknown> = {}, content?: Block["content"], children: Block[] = []): Block => ({ id: blockIdOf(rec.id), type, props, ...(content !== undefined ? { content } : {}), children });
    const text = () => this.inline(rec.properties?.title);
    switch (rec.type) {
      case "text":
        return [block("paragraph", color, text(), await this.children(rec, depth, seen))];
      case "header":
      case "sub_header":
      case "sub_sub_header":
      case "header_4": {
        const level = rec.type === "header" ? 1 : rec.type === "sub_header" ? 2 : rec.type === "sub_sub_header" ? 3 : 4;
        return [block("heading", { ...color, level, ...(f.toggleable ? { isToggleable: true } : {}) }, text(), await this.children(rec, depth, seen))];
      }
      case "bulleted_list":
        return [block("bulletListItem", color, text(), await this.children(rec, depth, seen))];
      case "numbered_list":
        return [block("numberedListItem", { ...color, ...(Number.isFinite(Number(f.list_start_index)) && f.list_start_index !== undefined ? { start: Number(f.list_start_index) } : {}) }, text(), await this.children(rec, depth, seen))];
      case "to_do":
        return [block("checkListItem", { ...color, checked: this.plain(rec.properties?.checked) === "Yes" }, text(), await this.children(rec, depth, seen))];
      case "toggle":
        return [block("toggleListItem", color, text(), await this.children(rec, depth, seen))];
      case "quote":
        return [block("quote", color, text(), await this.children(rec, depth, seen))];
      case "callout":
        return [block("callout", { ...color, icon: (await this.icon(f.page_icon)) || "💡" }, text(), await this.children(rec, depth, seen))];
      case "code": {
        const language = codeLanguage(this.plain(rec.properties?.language));
        return [block("codeBlock", { language, ...(f.code_wrap ? { wrap: true } : {}), ...(language === "mermaid" ? { view: "split" } : {}) }, [{ type: "text", text: this.plain(rec.properties?.title), styles: {} }])];
      }
      case "equation":
        return [block("equation", {}, [{ type: "text", text: this.plain(rec.properties?.title), styles: {} }])];
      case "divider":
        return [block("divider")];
      case "image":
      case "video":
      case "audio": {
        const asset = await this.media(rec);
        const caption = this.plain(rec.properties?.caption);
        const width = Number(f.block_width);
        const sized = rec.type !== "audio" && Number.isFinite(width) && width >= 16 && !f.block_full_width && !f.block_page_width;
        return [block(rec.type, { url: asset?.url ?? "", name: asset?.name ?? this.plain(rec.properties?.title), ...(caption ? { caption } : {}), ...(sized ? { previewWidth: Math.min(4000, Math.round(width)) } : {}) })];
      }
      case "pdf":
      case "file": {
        const asset = await this.media(rec);
        const caption = this.plain(rec.properties?.caption);
        return [block("file", { url: asset?.url ?? "", name: asset?.name ?? this.plain(rec.properties?.title), ...(caption ? { caption } : {}) })];
      }
      case "bookmark": {
        const url = this.plain(rec.properties?.link);
        return [block("bookmark", { url: safeHref(url, true) ? url : "" })];
      }
      case "external_object_instance": {
        const url = String(f.original_url ?? f.uri ?? "");
        return [block("bookmark", { url: safeHref(url, true) ? url : "" })];
      }
      case "table":
        return [this.table(rec, block)];
      case "table_row":
        return [];
      case "column_list": {
        const columns: Block[] = [];
        const ids: string[] = (rec.content ?? []).filter((c: string) => this.blocks.get(c)?.type === "column");
        for (const c of ids) {
          if (seen.has(c)) continue;
          seen.add(c);
          const col = this.blocks.get(c)!;
          const kids = await this.children(col, depth, seen);
          const ratio = Number(col.format?.column_ratio);
          columns.push({ id: blockIdOf(col.id), type: "column", props: { width: Number.isFinite(ratio) && ratio > 0 ? Math.max(0.05, Math.min(20, Math.round(ratio * ids.length * 1000) / 1000)) : 1 }, children: kids.filter((k) => k.type !== "columnList").length ? kids.flatMap((k) => (k.type === "columnList" ? k.children.flatMap((cc) => cc.children) : [k])) : [{ ...emptyParagraph(), id: blockIdOf(`${col.id}-empty`) }] });
        }
        if (columns.length >= 2) return [block("columnList", {}, undefined, columns)];
        return columns.flatMap((c) => c.children);
      }
      case "column":
        return this.children(rec, depth, seen);
      case "page":
      case "collection_view_page": {
        const node = this.nodes.get(rec.id);
        return node ? [block("subpage", { pageId: node.id })] : [];
      }
      case "collection_view": {
        const out: Block[] = [];
        const node = this.nodes.get(rec.id);
        if (node) out.push(block("database", { workspace: this.workspace, database: node.id, view: "" }));
        for (const extra of this.extraDbs.get(rec.id) ?? []) {
          const x = this.nodes.get(extra);
          if (x) out.push({ id: blockIdOf(`${rec.id}${extra}`), type: "database", props: { workspace: this.workspace, database: x.id, view: "" }, children: [] });
        }
        return out;
      }
      case "alias":
      case "link_to_page": {
        const target = f.alias_pointer?.id ?? rec.properties?.page_id;
        const node = typeof target === "string" ? this.nodes.get(target) : undefined;
        if (node) return [block("linkToPage", { pageId: node.id })];
        return [block("paragraph", {}, [{ type: "link", href: `https://www.notion.so/${String(target ?? "").replace(/-/g, "")}`, content: [{ type: "text", text: this.titleOf(this.blocks.get(target)) || "Linked Notion page", styles: {} }] }])];
      }
      case "transclusion_container":
        return this.children(rec, depth - 1, seen);
      case "transclusion_reference": {
        const source = f.transclusion_reference_pointer?.id;
        const target = source ? this.blocks.get(source) : undefined;
        return target ? this.convertList(target.content ?? [], depth, new Set(seen)) : [];
      }
      case "table_of_contents":
        return [block("toc", color)];
      case "breadcrumb":
        return [block("breadcrumb")];
      case "ai_block": {
        const label = String(f.ai_prompt_key ?? "").replace(/_/g, " ");
        return [block("callout", { icon: "✨", backgroundColor: "purple" }, [{ type: "text", text: label ? `AI block (${label})` : "AI block", styles: { italic: true } }], await this.children(rec, depth, seen))];
      }
      case "button":
        return [block("paragraph", color, [{ type: "text", text: this.plain(rec.properties?.title) || "Button", styles: { bold: true } }])];
      case "embed":
      case "drive":
      case "figma":
      case "gist":
      case "maps":
      case "tweet":
      case "codepen":
      case "typeform":
      case "miro":
      case "loom":
      case "excalidraw":
      case "framer":
      case "whimsical":
      case "replit":
      case "sketch":
      case "invision":
      case "abstract":
      case "pitch":
      case "hex":
      case "deepnote":
      case "github_gist": {
        const source = segsOf(rec.properties?.source)[0]?.[0] ?? f.display_source ?? "";
        const url = typeof source === "string" && safeHref(source, true) ? source : "";
        if (!url && rec.type === "drive" && typeof f.drive_properties?.url === "string") return [block("bookmark", { url: f.drive_properties.url })];
        return [block("embed", { url })];
      }
      default: {
        const label = this.plain(rec.properties?.title);
        const source = segsOf(rec.properties?.source)[0]?.[0] ?? f.display_source;
        if (typeof source === "string" && safeHref(source, true) && source) return [block("embed", { url: source })];
        return [block("paragraph", color, [{ type: "text", text: `[${rec.type.replace(/_/g, " ")}]${label ? " " : ""}`, styles: { italic: true, textColor: "gray" } }, ...this.inline(rec.properties?.title)], await this.children(rec, depth, seen))];
      }
    }
  }

  private table(rec: Rec, block: (type: string, props?: Record<string, unknown>, content?: Block["content"], children?: Block[]) => Block): Block {
    const f: Rec = rec.format ?? {};
    const rowIds: string[] = (rec.content ?? []).filter((id: string) => this.blocks.get(id)?.type === "table_row");
    const order: string[] = Array.isArray(f.table_block_column_order) ? f.table_block_column_order : [...new Set(rowIds.flatMap((id) => Object.keys(this.blocks.get(id)?.properties ?? {})))];
    const columnFormat: Rec = f.table_block_column_format ?? {};
    const rows = rowIds.map((id) => {
      const row = this.blocks.get(id)!;
      const rowColor = notionColor(row.format?.block_color);
      return {
        cells: order.map((col) => {
          const colColor = notionColor(columnFormat[col]?.color);
          return { type: "tableCell" as const, props: { ...colColor, ...rowColor }, content: this.inline(row.properties?.[col]) };
        }),
      };
    });
    const content: TableContent = {
      type: "tableContent",
      columnWidths: order.map((col) => (typeof columnFormat[col]?.width === "number" ? Math.round(columnFormat[col].width) : null)),
      headerRows: f.table_block_column_header ? 1 : 0,
      headerCols: f.table_block_row_header ? 1 : 0,
      rows: rows.length ? rows : [{ cells: [{ type: "tableCell", props: {}, content: [] }] }],
    };
    return block("table", notionColor(f.block_color).textColor ? { textColor: notionColor(f.block_color).textColor } : {}, content);
  }

  private resolveProp(coll: Rec, raw: string): string {
    const map: Rec = coll.format?.app_uri_map ?? {};
    return typeof map[raw] === "string" ? map[raw] : raw;
  }

  private buildSchema(collection: string, dbId: string, doc: Y.Doc) {
    const rec = this.collections.get(collection)!;
    const schema: Rec = rec.schema ?? {};
    const c: Collection = { id: collection, rec, owner: dbId, defaults: new Map(), props: new Map(), names: new Map(), types: new Map(), options: new Map(), groups: new Map() };
    this.colls.set(collection, c);
    const firstTable = (this.nodes.get(this.owners.get(collection)!)?.views ?? []).map((v) => this.views.get(v)).find((v) => v?.type === "table");
    const ordered = [...new Set(["title", ...((rec.format?.collection_page_properties ?? []) as Rec[]).map((p) => String(p.property)), ...(firstTable?.format?.table_properties ?? []).map((p: Rec) => this.resolveProp(rec, p.property)), ...Object.keys(schema)])].filter((k) => schema[k]);
    for (const key of ordered) {
      const p: Rec = schema[key];
      c.names.set(key, String(p.name ?? ""));
      c.types.set(key, String(p.type ?? "text"));
      c.props.set(key, key === "title" || p.type === "title" ? TITLE : this.stableId(`prop:${collection}:${key}`));
    }
    doc.transact(() => {
      settingsOf(doc).set("initialized", true);
      propEntry(doc, TITLE);
      for (const key of ordered) {
        const p: Rec = schema[key];
        const id = c.props.get(key)!;
        if (id === TITLE) {
          renameProperty(doc, TITLE, String(p.name ?? "Name").slice(0, 200));
          continue;
        }
        this.addSchemaProperty(doc, c, key, p, id);
      }
      const desc = this.plain(rec.description);
      if (desc) updateSettings(doc, { description: desc.slice(0, 20_000), showDescription: true });
    });
    const props = readSchema(doc);
    for (const [key, id] of c.props) {
      const p = props.find((x) => x.id === id);
      if (!p?.options.length) continue;
      c.options.set(key, new Map(p.options.map((o) => [o.name, o.id])));
      if (p.type === "status") {
        const named = typeof schema[key]?.defaultOption === "string" ? p.options.find((o) => o.name === schema[key].defaultOption) : undefined;
        const fallback = named ?? p.options.find((o) => o.group === "todo") ?? p.options[0];
        if (fallback) c.defaults.set(key, fallback.id);
      }
    }
  }

  private addSchemaProperty(doc: Y.Doc, c: Collection, key: string, p: Rec, id: string) {
    const name = String(p.name ?? "").slice(0, 200) || "Property";
    const description = typeof p.description === "string" ? p.description.slice(0, 2000) : "";
    const base = { name, ...(description ? { description } : {}) };
    const options = (list: Rec[] | undefined, groupOf?: (option: Rec) => StatusGroup) =>
      (list ?? []).filter((o) => typeof o?.value === "string").map((o) => ({ name: String(o.value).slice(0, 200), color: optionColor(o.color), ...(groupOf ? { group: groupOf(o) } : {}) }));
    const type = String(p.type);
    switch (type) {
      case "text":
      case "url":
      case "email":
      case "checkbox":
      case "person":
      case "created_time":
      case "created_by":
        addProperty(doc, { ...base, type: type as PropType }, { id });
        return;
      case "phone_number":
        addProperty(doc, { ...base, type: "phone" }, { id });
        return;
      case "file":
        addProperty(doc, { ...base, type: "files" }, { id });
        return;
      case "last_edited_time":
        addProperty(doc, { ...base, type: "edited_time" }, { id });
        return;
      case "last_edited_by":
        addProperty(doc, { ...base, type: "edited_by" }, { id });
        return;
      case "number":
        addProperty(doc, { ...base, type: "number", format: NUMBER_FORMATS[String(p.number_format ?? "number")] ?? "number" }, { id });
        return;
      case "date":
        addProperty(doc, { ...base, type: "date", ...(p.date_format === "relative" ? { dateFormat: "relative" as const } : p.date_format === "MM/DD/YYYY" ? { dateFormat: "short" as const } : p.date_format === "DD/MM/YYYY" ? { dateFormat: "dmy" as const } : p.date_format === "YYYY/MM/DD" ? { dateFormat: "ymd" as const } : {}), ...(p.time_format === "H:mm" ? { timeFormat: "24" as const } : {}) }, { id });
        return;
      case "select":
      case "multi_select":
        addProperty(doc, { ...base, type, options: options(p.options) }, { id });
        return;
      case "status": {
        const groups: Rec[] = Array.isArray(p.groups) ? p.groups : [];
        const groupMap = new Map<string, string[]>();
        const groupOf = (option: Rec): StatusGroup => {
          const g = groups.find((x) => (x.optionIds ?? []).includes(option.id));
          const label = String(g?.name ?? "").toLowerCase();
          return /complete|done/.test(label) ? "done" : /progress|doing/.test(label) ? "doing" : "todo";
        };
        for (const g of groups) groupMap.set(String(g.name ?? ""), ((g.optionIds ?? []) as string[]).map((oid) => String((p.options ?? []).find((o: Rec) => o.id === oid)?.value ?? "")).filter(Boolean));
        c.groups.set(key, groupMap);
        addProperty(doc, { ...base, type: "status", options: options(p.options, groupOf) }, { id });
        return;
      }
      case "formula":
        addProperty(doc, { ...base, type: "formula", expression: this.formula(c, p) }, { id });
        return;
      case "relation": {
        const target = typeof p.collection_id === "string" ? p.collection_id : "";
        addProperty(doc, { ...base, type: "relation", relation: "", twoWay: false }, { id });
        this.pendingRelations.push({ doc, collection: c.id, key, prop: id, target, back: typeof p.property === "string" ? p.property : "" });
        return;
      }
      case "rollup":
        if (typeof p.relation_property === "string" && c.rec.schema?.[p.relation_property]?.type === "relation") {
          addProperty(doc, { ...base, type: "rollup", rollupFn: rollupFn(p.aggregation) }, { id });
          this.pendingRollups.push({ doc, collection: c.id, prop: id, relation: p.relation_property, target: String(p.target_property ?? "") });
        } else {
          const stored: PropType = p.target_property_type === "email" ? "email" : p.target_property_type === "url" ? "url" : p.target_property_type === "phone_number" ? "phone" : p.target_property_type === "number" ? "number" : "text";
          c.types.set(key, `stored:${stored}`);
          addProperty(doc, { ...base, type: stored, ...(description ? {} : { description: "Rolled up in Notion; imported with its values." }) }, { id });
        }
        return;
      case "auto_increment_id":
      case "unique_id":
        addProperty(doc, { ...base, type: "id", prefix: String(p.prefix ?? "").slice(0, 20) }, { id });
        return;
      default:
        c.types.set(key, "stored:text");
        addProperty(doc, { ...base, type: "text" }, { id });
    }
  }

  private readonly viewIcons = new Map<string, string>();

  private pendingRelations: { doc: Y.Doc; collection: string; key: string; prop: string; target: string; back: string }[] = [];
  private pendingRollups: { doc: Y.Doc; collection: string; prop: string; relation: string; target: string }[] = [];

  private linkRelations() {
    for (const r of this.pendingRelations) {
      const target = this.colls.get(r.target);
      const entry = propEntry(r.doc, r.prop);
      r.doc.transact(() => {
        if (target) entry.set("relation", target.owner);
        const back = target && r.back ? target.props.get(r.back) : undefined;
        if (back) {
          entry.set("twoWay", true);
          entry.set("backProp", back);
        }
      });
    }
    for (const r of this.pendingRollups) {
      const c = this.colls.get(r.collection)!;
      const relationKey = r.relation;
      const relationProp = c.props.get(relationKey);
      const targetColl = this.colls.get(String(c.rec.schema?.[relationKey]?.collection_id ?? ""));
      const target = targetColl?.props.get(r.target) ?? (r.target === "title" ? TITLE : "");
      const entry = propEntry(r.doc, r.prop);
      r.doc.transact(() => {
        if (relationProp) entry.set("rollupRelation", relationProp);
        if (target) entry.set("rollupTarget", target);
      });
    }
  }

  formula(c: Collection, p: Rec): string {
    const propRef = (key: string, fallback: string) => {
      const name = c.names.get(key) ?? c.names.get(this.resolveProp(c.rec, key)) ?? fallback;
      return `prop(${JSON.stringify(name)})`;
    };
    if (p.formula2 && Array.isArray(p.formula2.code)) {
      return (p.formula2.code as Seg[])
        .map(([text, anns]) => {
          const fpp = (anns ?? []).find((a) => Array.isArray(a) && a[0] === "fpp");
          if (fpp) return propRef(String(fpp[1]?.property ?? ""), String(fpp[1]?.name ?? ""));
          return text;
        })
        .join("")
        .slice(0, 4000);
    }
    if (p.formula && typeof p.formula === "object") return formulaV1(p.formula, propRef).slice(0, 4000);
    return "";
  }

  private rowValue(c: Collection, key: string, raw: unknown, doc: Y.Doc): unknown {
    const type = c.types.get(key) ?? "text";
    const segs = segsOf(raw);
    const text = this.plain(raw);
    switch (type) {
      case "text":
      case "url":
      case "email":
      case "phone_number":
      case "stored:text":
      case "stored:email":
      case "stored:url":
      case "stored:phone":
        return text ? text.slice(0, 20_000) : undefined;
      case "number":
      case "stored:number": {
        const n = Number(text.replace(/[,\s]/g, ""));
        return text && Number.isFinite(n) ? n : undefined;
      }
      case "checkbox":
        return text === "Yes" ? true : undefined;
      case "select":
      case "status": {
        const id = c.options.get(key)?.get(text.slice(0, 200));
        return id ?? undefined;
      }
      case "multi_select": {
        const map = c.options.get(key);
        const ids = text
          .split(",")
          .map((s) => map?.get(s.trim().slice(0, 200)))
          .filter((x): x is string => !!x);
        return ids.length ? [...new Set(ids)] : undefined;
      }
      case "date": {
        const d = segs.flatMap(([, anns]) => anns ?? []).find((a) => Array.isArray(a) && a[0] === "d");
        return d ? (dateOf(d[1]) ?? undefined) : undefined;
      }
      case "person": {
        const ids: string[] = [];
        for (const [, anns] of segs)
          for (const a of anns ?? [])
            if (Array.isArray(a) && a[0] === "u" && typeof a[1] === "string") {
              const pid = personId(a[1]);
              rememberPerson(doc, { id: pid, name: this.userName(a[1]), color: hashColor(pid) });
              ids.push(pid);
            }
        return ids.length ? ids : undefined;
      }
      case "relation": {
        const ids: string[] = [];
        for (const [, anns] of segs) for (const a of anns ?? []) if (Array.isArray(a) && a[0] === "p" && this.nodes.get(a[1])) ids.push(this.nodes.get(a[1])!.id);
        return ids.length ? ids : undefined;
      }
      case "file":
        return segs.length ? segs : undefined;
      default:
        return undefined;
    }
  }

  private async fileValues(segs: Seg[]) {
    const out: { ref: string; name: string; type: string }[] = [];
    for (const [name, anns] of segs) {
      if (name === ",") continue;
      const href = (anns ?? []).find((a) => Array.isArray(a) && a[0] === "a")?.[1];
      const asset = await this.asset(typeof href === "string" ? href : name, name);
      if (asset) out.push({ ref: asset.url, name: (name || asset.name).slice(0, 255), type: /\.(png|jpe?g|gif|webp|svg|avif|heic)$/i.test(name || asset.name) ? "image" : "" });
    }
    return out;
  }

  private filterValue(c: Collection, key: string, value: unknown, operator: string): unknown {
    const type = c.types.get(key) ?? "text";
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const one = (v: Rec | undefined): unknown[] => {
      if (!v || typeof v !== "object") return [];
      if (v.type === "relative") {
        if (v.value === "me") return [personId(this.me)];
        const r = RELATIVE[String(v.value)];
        return r ? [{ relative: r }] : [];
      }
      if (v.type === "is_group") return [...(c.groups.get(key)?.get(String(v.value)) ?? [])].map((name) => c.options.get(key)?.get(name)).filter(Boolean);
      const raw = v.value;
      if (raw && typeof raw === "object" && typeof raw.start_date === "string") return [raw.start_date];
      if (raw === undefined || raw === null) return [];
      if (type === "select" || type === "status" || type === "multi_select") {
        const name = typeof raw === "object" && raw?.option ? String(raw.option) : String(raw);
        const id = c.options.get(key)?.get(name);
        return id ? [id] : [];
      }
      if (type === "person" && typeof raw === "string") return [personId(raw)];
      if (type === "relation" && typeof raw === "string") return this.nodes.get(raw) ? [this.nodes.get(raw)!.id] : [];
      return [raw];
    };
    const values = list.flatMap((v) => one(v as Rec));
    if (operator.startsWith("checkbox")) return undefined;
    if (type === "select" || type === "status" || type === "multi_select" || type === "person" || type === "relation") return values.length ? values : undefined;
    return values[0];
  }

  private filterRule(c: Collection, f: Rec): FilterRule | FilterGroup | null {
    if (Array.isArray(f.filters)) {
      const rules = f.filters.map((x: Rec) => this.filterRule(c, x)).filter((x: FilterRule | FilterGroup | null): x is FilterRule | FilterGroup => !!x);
      return { kind: "group", id: newHex(), op: f.operator === "or" ? "or" : "and", rules };
    }
    const key = this.resolveProp(c.rec, String(f.property ?? ""));
    const prop = c.props.get(key);
    if (!prop) return null;
    const operator = String(f.filter?.operator ?? "");
    const raw = f.filter?.value;
    const exact = Array.isArray(raw) ? raw[0] : raw;
    let cond: FilterCond;
    switch (operator) {
      case "enum_is":
      case "status_is":
      case "string_is":
      case "date_is":
        cond = "is";
        break;
      case "enum_is_not":
      case "status_is_not":
      case "string_is_not":
        cond = "is_not";
        break;
      case "enum_contains":
      case "person_contains":
      case "relation_contains":
      case "string_contains":
        cond = "contains";
        break;
      case "enum_does_not_contain":
      case "person_does_not_contain":
      case "relation_does_not_contain":
      case "string_does_not_contain":
        cond = "not_contains";
        break;
      case "string_starts_with":
        cond = "starts";
        break;
      case "string_ends_with":
        cond = "ends";
        break;
      case "is_empty":
        cond = "empty";
        break;
      case "is_not_empty":
        cond = "not_empty";
        break;
      case "checkbox_is":
        cond = exact?.value === true ? "checked" : "unchecked";
        break;
      case "checkbox_is_not":
        cond = exact?.value === true ? "unchecked" : "checked";
        break;
      case "number_equals":
        cond = "eq";
        break;
      case "number_does_not_equal":
        cond = "neq";
        break;
      case "number_greater_than":
        cond = "gt";
        break;
      case "number_less_than":
        cond = "lt";
        break;
      case "number_greater_than_or_equal_to":
        cond = "gte";
        break;
      case "number_less_than_or_equal_to":
        cond = "lte";
        break;
      case "date_is_before":
        cond = "before";
        break;
      case "date_is_after":
        cond = "after";
        break;
      case "date_is_on_or_before":
        cond = "on_or_before";
        break;
      case "date_is_on_or_after":
        cond = "on_or_after";
        break;
      case "date_is_within":
        cond = "relative";
        break;
      default:
        cond = "is";
    }
    if (operator === "status_is" && (c.types.get(key) === "status" || c.types.get(key) === "select") && (Array.isArray(raw) ? raw.length > 1 : false)) cond = "is";
    const value = this.filterValue(c, key, raw, operator);
    const rule: FilterRule = { kind: "rule", id: f.id && typeof f.id === "string" ? f.id.replace(/[^0-9a-z]/gi, "").slice(0, 12) || newHex() : newHex(), prop, cond };
    if (value !== undefined) rule.value = value;
    return rule;
  }

  private viewFilter(c: Collection, v: Rec): FilterGroup {
    const root: FilterGroup = { kind: "group", id: "root", op: "and", rules: [] };
    const main = v.query2?.filter;
    if (main) {
      const converted = this.filterRule(c, main);
      if (converted?.kind === "group") {
        if (converted.op === "and") root.rules.push(...converted.rules);
        else if (converted.rules.length) root.rules.push(converted);
      } else if (converted) root.rules.push(converted);
    }
    for (const pf of v.format?.property_filters ?? []) {
      const rule = pf?.filter ? this.filterRule(c, pf.filter) : null;
      if (rule) root.rules.push(rule);
    }
    return root;
  }

  private groupKey(c: Collection, key: string, value: Rec | undefined, byGroup: boolean): string {
    const v = value?.value;
    if (v === undefined || v === null) return NONE;
    const type = c.types.get(key);
    if (typeof v === "object" && v.type === "by_option") return c.options.get(key)?.get(String(v.option)) ?? NONE;
    if (typeof v === "object" && v.type === "by_group") return groupIdOf(String(v.group ?? ""));
    if (byGroup && typeof v === "string") return groupIdOf(v);
    if (type === "select" || type === "status" || type === "multi_select") return c.options.get(key)?.get(String(v)) ?? NONE;
    if (type === "checkbox") return v === true || v === "true" || v === "Yes" ? "true" : "false";
    if (type === "person" && typeof v === "string") return personId(v);
    return String(v);
  }

  private writeViews(doc: Y.Doc, c: Collection, views: string[], dbLocked: boolean) {
    let peek: "side" | "center" | "full" | null = null;
    for (const viewId of views) {
      const v = this.views.get(viewId);
      if (!v) continue;
      const type = VIEW_TYPES[String(v.type)] ?? "table";
      const f: Rec = v.format ?? {};
      const q: Rec = v.query2 ?? {};
      const prop = (raw: unknown) => (typeof raw === "string" ? c.props.get(this.resolveProp(c.rec, raw)) : undefined);
      const init: Record<string, unknown> = { filter: this.viewFilter(c, v) };
      const sorts = (Array.isArray(q.sort) ? q.sort : []).map((s: Rec) => ({ id: newHex(), prop: prop(s.property), dir: s.direction === "descending" ? "desc" : "asc" })).filter((s: { prop?: string }) => !!s.prop);
      init.sorts = sorts;
      const by: Rec | undefined = type === "board" ? (f.board_columns_by ?? f.collection_group_by) : f.collection_group_by;
      const byKey = by ? this.resolveProp(c.rec, String(by.property ?? "")) : "";
      const byProp = by ? c.props.get(byKey) : undefined;
      if (byProp) init.groupBy = { prop: byProp, date: by!.groupBy === "week" || by!.groupBy === "month" || by!.groupBy === "year" || by!.groupBy === "day" ? by!.groupBy : "relative", text: by!.groupBy === "alphabet_prefix" ? "alpha" : "exact", status: by!.groupBy === "group" ? "group" : "option", step: 10, sort: by!.sort?.type === "ascending" ? "asc" : by!.sort?.type === "descending" ? "desc" : "manual", hideEmpty: by!.hideEmptyGroups === true };
      if (by?.disableBoardColorColumns === true) init.colorColumns = false;
      if (typeof f.table_wrap === "boolean") init.wrap = f.table_wrap;
      if (Number.isFinite(f.table_frozen_column_index)) init.frozen = Math.max(0, Number(f.table_frozen_column_index) + 1);
      if (typeof f.show_page_icon === "boolean") init.showIcons = f.show_page_icon;
      const cover: Rec | undefined = f.gallery_cover ?? f.board_cover ?? f.list_cover;
      if (!cover && type === "gallery") init.cardPreview = "none";
      if (cover) init.cardPreview = cover.type === "page_cover" ? "cover" : cover.type === "page_content" || cover.type === "page_content_first" ? "content" : cover.type === "property" ? (prop(cover.property) ?? "none") : "none";
      const size = f.gallery_cover_size ?? f.board_cover_size;
      if (size === "small" || size === "medium" || size === "large") init.cardSize = size;
      if ((f.gallery_cover_aspect ?? f.board_cover_aspect) === "contain") init.fitImage = true;
      const dateProp = prop(q.calendar_by ?? q.timeline_by);
      if (dateProp) init.dateProp = dateProp;
      const endProp = prop(q.timeline_by_end);
      if (endProp) init.endProp = endProp;
      const zoom = f.timeline_preference?.zoomLevel;
      if (["day", "week", "month", "quarter", "year"].includes(zoom)) init.zoom = zoom;
      if (typeof f.timeline_show_table === "boolean") init.showTable = f.timeline_show_table;
      const limit = f.inline_collection_first_load_limit?.limit;
      if (Number.isFinite(limit)) init.limit = Number(limit);
      const viewIcon = this.viewIcons.get(viewId);
      if (viewIcon) init.icon = viewIcon;
      if (type === "chart") {
        const cfg: Rec = f.chart_config ?? {};
        init.chartType = cfg.type === "line" ? "line" : cfg.type === "donut" || cfg.type === "pie" ? "donut" : "bar";
        const chartBy = prop(cfg.dataConfig?.groupBy?.property);
        if (chartBy) init.chartBy = chartBy;
        const agg = cfg.dataConfig?.aggregationConfig?.aggregation;
        init.chartAgg = agg?.aggregator === "sum" ? "sum" : agg?.aggregator === "average" ? "avg" : "count";
        const value = prop(agg?.property);
        if (value) init.chartValue = value;
      }
      if (type === "form") init.formFields = this.formFields(c, f);
      if (f.collection_peek_mode && !peek) peek = f.collection_peek_mode === "center_peek" ? "center" : f.collection_peek_mode === "full_page" ? "full" : "side";
      const id = addView(doc, type, { id: this.stableId(`view:${this.viewScope}:${viewId}`), name: String(v.name ?? "").slice(0, 200) || (type[0]!.toUpperCase() + type.slice(1)), init });
      const list: Rec[] = f[`${String(v.type)}_properties`] ?? (type === "timeline" ? f.timeline_table_properties : undefined) ?? f.table_properties ?? [];
      let order: string | null = null;
      for (const p of list) {
        const pid = prop(p.property);
        if (!pid) continue;
        order = orderBetween(order, null);
        const keepsTitle = pid === TITLE && type !== "table" && type !== "list" && type !== "timeline";
        setViewProp(doc, id, pid, { visible: keepsTitle || p.visible !== false, order, ...(Number.isFinite(p.width) ? { width: Math.round(p.width) } : {}) });
      }
      if (type === "timeline" && Array.isArray(f.timeline_properties))
        for (const p of f.timeline_properties as Rec[]) {
          const pid = prop(p.property);
          if (pid && p.visible) setViewProp(doc, id, pid, { visible: true });
        }
      const columns: Rec[] = f.board_columns ?? f.board_groups2 ?? f.collection_groups ?? [];
      if (byProp && columns.length) {
        let gOrder: string | null = null;
        for (const col of columns) {
          if (col.property && this.resolveProp(c.rec, col.property) !== byKey) continue;
          gOrder = orderBetween(gOrder, null);
          setGroupState(doc, id, this.groupKey(c, byKey, col.value, by?.groupBy === "group"), { hidden: col.hidden === true || col.emptyHidden === true ? true : false, order: gOrder });
        }
      }
      for (const a of Array.isArray(q.aggregations) ? q.aggregations : []) {
        const pid = prop(a.property);
        const fn = AGGREGATORS[String(a.aggregator)];
        if (pid && fn) setCalc(doc, id, pid, fn);
      }
    }
    if (peek) updateSettings(doc, { openAs: peek });
    if (dbLocked) updateSettings(doc, { locked: true });
  }

  private formFields(c: Collection, f: Rec): { prop: string; required: boolean }[] {
    const form = typeof f.form_block_pointer?.id === "string" ? this.blocks.get(f.form_block_pointer.id) : undefined;
    const out: { prop: string; required: boolean }[] = [];
    for (const qid of form?.content ?? []) {
      const q = this.blocks.get(qid);
      const key = q?.format?.property ?? q?.properties?.property;
      const pid = typeof key === "string" ? c.props.get(key) : undefined;
      if (pid) out.push({ prop: pid, required: q?.format?.required === true });
    }
    if (!out.length) for (const [key, pid] of c.props) if (!["formula", "rollup", "created_time", "last_edited_time", "created_by", "last_edited_by"].includes(c.types.get(key) ?? "")) out.push({ prop: pid, required: pid === TITLE });
    return out;
  }

  private progress(current: string, done: number, total: number) {
    this.options.progress?.({ ...this.counts, current, done, total });
  }

  private check() {
    if (this.options.cancelled?.() || !this.sink.alive()) throw new ImportCancelled();
  }

  async run(): Promise<RecordsResult> {
    this.plan();
    const tree = this.sink.tree;
    const nodes = [...this.nodes.values()];
    const total = nodes.length;
    const roots: string[] = nodes.filter((n) => !n.parent).map((n) => n.id);
    const existingRoots = roots.map((id) => pagesOf(tree).get(id)).filter((e): e is Y.Map<unknown> => !!e && e.get("deleted") !== true && e.get("parent") === "");
    const reused = existingRoots.map((e) => String(e.get("order") ?? "")).sort();
    const others = childrenOf(tree, "").filter((p) => !roots.includes(p.id));
    let topOrder = [...others.map((p) => p.order), ...reused].sort().at(-1) ?? null;
    for (const n of nodes) {
      if (n.parent) continue;
      if (reused.length && pagesOf(tree).get(n.id)?.get("parent") === "") n.order = reused.shift()!;
      else {
        topOrder = orderBetween(topOrder, null);
        n.order = topOrder;
      }
    }
    this.predictAssets(nodes);
    const meta = new Map<string, { icon: string; cover: string }>();
    for (const n of nodes) {
      const rec = this.blocks.get(n.notion.split(":")[0]!);
      const coll = n.collection ? this.collections.get(n.collection) : undefined;
      const isRow = n.row;
      const icon = await this.icon(rec?.format?.page_icon ?? (n.kind === "database" && !n.notion.includes(":") ? coll?.icon : undefined));
      const cover = isRow || n.kind === "page" ? await this.cover(rec?.format?.page_cover) : await this.cover(rec?.format?.page_cover ?? coll?.cover);
      meta.set(n.notion, { icon, cover });
    }
    const existed = new Set<string>();
    const rebase = this.rebase;
    for (let at = 0; at < nodes.length; at += 250) {
      this.check();
      tree.transact(() => {
        for (const n of nodes.slice(at, at + 250)) {
          const rec = this.blocks.get(n.notion.split(":")[0]!);
          const f: Rec = rec?.format ?? {};
          const m = meta.get(n.notion)!;
          const old = pagesOf(tree).get(n.id);
          const created = Number(rec?.created_time) || this.now;
          const edited = Number(rec?.last_edited_time) || created;
          const fields: Record<string, unknown> = {
            title: n.title.slice(0, 2000),
            icon: m.icon,
            cover: m.cover,
            parent: n.parent,
            order: n.order,
            kind: n.kind,
            createdAt: created,
            createdBy: n.row && rec?.created_by_id ? personId(String(rec.created_by_id)) : this.sink.by,
            updatedAt: edited,
            updatedBy: n.row && rec?.last_edited_by_id ? personId(String(rec.last_edited_by_id)) : this.sink.by,
            archivedAt: 0,
            fullWidth: f.page_full_width === true,
            smallText: f.page_small_text === true,
            font: f.page_font === "serif" || f.page_font === "mono" ? f.page_font : "default",
            locked: n.kind === "page" && f.block_locked === true,
            isTemplate: n.template === true,
          };
          if (m.cover && Number.isFinite(Number(f.page_cover_position))) fields.coverY = Math.max(0, Math.min(100, Math.round((1 - Number(f.page_cover_position)) * 100)));
          const dbProps: Record<string, unknown> = n.kind === "database" ? { importedFrom: "notion", ...(n.inline ? { inline: true } : {}), ...(n.linked ? { linkedSource: n.linked } : {}) } : {};
          if (old) {
            for (const [k, v] of Object.entries(fields)) {
              if (k === "parent" || k === "order") continue;
              if (!MERGED_FIELDS.has(k)) {
                if (old.get(k) !== v) old.set(k, v);
                continue;
              }
              rebase.field(n.id, old, k, old.get(k) ?? null, v, () => old.set(k, v));
            }
            rebase.field(n.id, old, "place", [old.get("parent") ?? "", old.get("order") ?? ""], [n.parent, n.order], () => {
              if (old.get("parent") !== n.parent) old.set("parent", n.parent);
              if (old.get("order") !== n.order) old.set("order", n.order);
            });
            let props = old.get("props");
            if (!(props instanceof Y.Map)) {
              props = new Y.Map<unknown>();
              old.set("props", props);
            }
            if (n.kind === "database") {
              const map = props as Y.Map<unknown>;
              for (const k of ["inline", "linkedSource"]) if (!(k in dbProps) && map.has(k)) map.delete(k);
              for (const [k, v] of Object.entries(dbProps)) if (map.get(k) !== v) map.set(k, v);
            }
            existed.add(n.id);
          } else {
            const entry = new Y.Map<unknown>();
            for (const [k, v] of Object.entries(fields)) entry.set(k, v);
            const props = new Y.Map<unknown>();
            for (const [k, v] of Object.entries(dbProps)) props.set(k, v);
            entry.set("props", props);
            pagesOf(tree).set(n.id, entry);
            for (const k of MERGED_FIELDS) rebase.remember(entry, k, fields[k] ?? null);
            rebase.remember(entry, "place", [n.parent, n.order]);
          }
        }
      });
      await yieldNow();
    }
    this.options.onRoots?.(roots.filter((id) => !existed.has(id)));
    const docFor = async (id: string): Promise<Y.Doc> => (existed.has(id) && this.sink.doc ? await this.sink.doc(id) : this.sink.newDoc(id));
    let done = 0;
    const docs = new Map<string, Y.Doc>();
    const dbNodes = nodes.filter((n) => n.kind === "database");
    for (const n of dbNodes)
      for (const v of n.views ?? []) {
        const raw = this.views.get(v)?.format?.collection_view_icon;
        if (typeof raw === "string" && raw) this.viewIcons.set(v, await this.icon(raw));
      }
    for (const n of dbNodes) {
      this.check();
      const doc = await docFor(n.id);
      if (existed.has(n.id)) doc.transact(() => {
        schemaOf(doc).clear();
        viewsOf(doc).delete(0, viewsOf(doc).length);
        settingsOf(doc).clear();
      });
      docs.set(n.id, doc);
      if (n.collection && !n.linked) this.buildSchema(n.collection, n.id, doc);
    }
    this.linkRelations();
    for (const n of dbNodes) {
      const doc = docs.get(n.id)!;
      const c = n.collection ? this.colls.get(n.collection) : undefined;
      const rec = this.blocks.get(n.notion.split(":")[0]!);
      this.viewScope = n.notion;
      if (n.linked) doc.transact(() => {
        settingsOf(doc).set("initialized", true);
        settingsOf(doc).set("source", n.linked!);
      });
      if (c) doc.transact(() => this.writeViews(doc, c, n.views ?? [], rec?.format?.block_locked === true));
      if (!(n.views ?? []).length) doc.transact(() => {
        settingsOf(doc).set("initialized", true);
        addView(doc, "table", { id: this.stableId(`view:${n.notion}:default`), name: "Table" });
      });
      this.counts.databases++;
      this.progress(n.title, ++done, total);
    }
    for (const n of nodes) {
      if (n.kind !== "page") continue;
      this.check();
      this.progress(n.title, ++done, total);
      const rec = this.blocks.get(n.notion);
      const parent = this.byId.get(n.parent);
      if (n.row && parent?.collection) {
        const c = this.colls.get(parent.collection);
        const dbDoc = docs.get(c?.owner ?? "") ?? docs.get(parent.id);
        if (c && dbDoc) await this.writeRow(n, rec!, c, dbDoc);
      }
      const doc = await docFor(n.id);
      usedBlockIds = new Set();
      const blocks = rec ? await this.convertList(rec.content ?? [], 0, new Set([rec.id])) : [];
      const limited = capBlocks(blocks, IMPORT_LIMITS.blocksPerPage);
      this.writeBody(n.id, doc, limited, existed.has(n.id));
      this.counts.pages++;
      if (done % 25 === 0) await yieldNow();
    }
    const kept = new Set(nodes.map((n) => n.id));
    const previous = readImports(tree).find((r) => r.id === notionRecordId(this.records.spaceId));
    const missing = (previous?.pages ?? []).filter((id) => !kept.has(id));
    const gone = this.provablyGone(missing, nodes);
    const goneSet = new Set(gone);
    const still = missing.filter((id) => !goneSet.has(id));
    if (gone.length) tree.transact(() => {
      for (const id of gone) {
        const entry = pagesOf(tree).get(id);
        if (!entry || entry.get("deleted") === true || Number(entry.get("archivedAt") ?? 0) > 0) continue;
        entry.set("archivedAt", this.now);
        entry.set("updatedBy", this.sink.by);
        rebase.remember(entry, "archivedAt", this.now);
      }
    });
    this.ahead.drop();
    this.progress("", done, total);
    await this.sink.flush();
    return { roots, pageIds: [...kept, ...still], archived: gone.length, ...this.counts, conflicts: rebase.conflicts.size, ids: new Map(nodes.map((n) => [n.notion, n.id])), files: { ...this.fileMarks } };
  }

  private readonly rebase = new Rebase();

  private writeBody(page: string, doc: Y.Doc, blocks: Block[], existed: boolean) {
    const fresh = new Y.Doc();
    if (blocks.length) blocksOf(fresh).insert(0, [buildGroup(blocks)]);
    const incoming = bodyPrint(blocksOf(fresh));
    const exact = printOf(blocksOf(fresh).toString());
    fresh.destroy();
    const fragment = blocksOf(doc);
    const current = fragment.length ? bodyPrint(fragment) : EMPTY_BODY;
    const entry = pagesOf(this.sink.tree).get(page);
    let write = false;
    this.sink.tree.transact(() => (write = this.rebase.body(page, entry, current, incoming, existed)));
    if (!write) return;
    if (!fragment.length) {
      if (blocks.length) seedBody(doc, page, exact, (scratch) => blocksOf(scratch).insert(0, [buildGroup(blocks)]));
      return;
    }
    doc.transact(() => {
      fragment.delete(0, fragment.length);
      if (blocks.length) fragment.insert(0, [buildGroup(blocks)]);
    });
  }

  private provablyGone(candidates: string[], nodes: Node[]): string[] {
    if (!candidates.length) return candidates;
    if (this.nodes.size >= IMPORT_LIMITS.pages) return [];
    const partial = this.records.incomplete;
    const unreadCollections = new Set(partial?.collections ?? []);
    const unreadBlocks = partial?.blocks ?? [];
    if (!unreadCollections.size && !unreadBlocks.length) return candidates;
    const shielded = new Set<string>();
    for (const id of unreadBlocks) for (const page of knownPageIds(this.workspace, id)) shielded.add(page);
    const partialDbs = new Set<string>();
    for (const n of nodes) {
      if (n.kind !== "database") continue;
      const rec = this.blocks.get(n.notion.split(":")[0]!);
      const collection = n.collection ?? rec?.collection_id ?? rec?.format?.collection_pointer?.id;
      if (collection && unreadCollections.has(collection)) partialDbs.add(n.id);
    }
    const tree = this.sink.tree;
    const isShielded = (id: string) => {
      const seen = new Set<string>();
      for (let at: string = id, depth = 0; at && !seen.has(at) && depth < 64; depth++) {
        if (shielded.has(at)) return true;
        seen.add(at);
        const parent = String(pagesOf(tree).get(at)?.get("parent") ?? "");
        if (at === id && partialDbs.has(parent)) return true;
        at = parent;
      }
      return false;
    };
    return candidates.filter((id) => !isShielded(id));
  }

  private async writeRow(n: Node, rec: Rec, c: Collection, dbDoc: Y.Doc) {
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(rec.properties ?? {})) {
      const pid = c.props.get(key);
      if (!pid || pid === TITLE) continue;
      let value = this.rowValue(c, key, raw, dbDoc);
      if (c.types.get(key) === "file" && Array.isArray(value)) value = await this.fileValues(value as Seg[]);
      if (value !== undefined && !(Array.isArray(value) && !value.length)) values[pid] = value;
    }
    for (const [key, option] of c.defaults) {
      const pid = c.props.get(key);
      if (pid && values[pid] === undefined && !n.template) values[pid] = option;
    }
    for (const [key, type] of c.types) {
      if (type !== "created_by" && type !== "last_edited_by") continue;
      const user = String(type === "created_by" ? rec.created_by_id : rec.last_edited_by_id);
      if (user) rememberPerson(dbDoc, { id: personId(user), name: this.userName(user), color: hashColor(personId(user)) });
      void key;
    }
    const entry = pagesOf(this.sink.tree).get(n.id);
    const props = entry?.get("props");
    if (props instanceof Y.Map && entry) this.sink.tree.transact(() => {
      for (const pid of c.props.values()) {
        if (pid === TITLE) continue;
        const incoming = pid in values ? values[pid] : null;
        const current = props.has(pid) ? props.get(pid) : null;
        this.rebase.field(n.id, entry, `prop:${pid}`, current, incoming, () => {
          if (incoming === null) props.delete(pid);
          else if (JSON.stringify(current) !== JSON.stringify(incoming)) props.set(pid, incoming);
        });
      }
    });
  }
}

const MERGED_FIELDS = new Set(["title", "icon", "cover", "coverY", "fullWidth", "smallText", "font", "locked", "archivedAt"]);

export function sniffExt(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpg";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "png";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return "gif";
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45) return "webp";
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return "pdf";
  if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) return String.fromCharCode(b(8), b(9), b(10)).startsWith("M4A") ? "m4a" : "mp4";
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

function groupIdOf(name: string): StatusGroup {
  const label = name.toLowerCase();
  return /complete|done/.test(label) ? "done" : /progress|doing/.test(label) ? "doing" : "todo";
}

function rollupFn(raw: unknown): RollupFn {
  const map: Record<string, RollupFn> = { show_original: "show_original", count: "count", count_all: "count", count_values: "count_values", unique: "unique", empty: "empty", not_empty: "not_empty", percent_empty: "percent_empty", percent_not_empty: "percent_not_empty", checked: "checked", unchecked: "unchecked", percent_checked: "percent_checked", percent_unchecked: "percent_unchecked", sum: "sum", average: "avg", median: "median", min: "min", max: "max", range: "range", earliest_date: "earliest", latest_date: "latest", date_range: "date_range" };
  return map[String(raw ?? "show_original")] ?? "show_original";
}

const V1_OPERATORS: Record<string, string> = { add: "+", subtract: "-", multiply: "*", divide: "/", mod: "%", pow: "^", equal: "==", unequal: "!=", larger: ">", largerEq: ">=", smaller: "<", smallerEq: "<=", and: "and", or: "or" };

function formulaV1(node: Rec, propRef: (key: string, name: string) => string): string {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "property":
      return propRef(String(node.id ?? ""), String(node.name ?? ""));
    case "constant":
      return node.value_type === "string" ? JSON.stringify(String(node.value ?? "")) : String(node.value ?? "");
    case "symbol":
      return node.name === "e" ? "e()" : node.name === "pi" ? "pi()" : String(node.name ?? "");
    case "operator":
    case "function": {
      const args: string[] = (node.args ?? []).map((a: Rec) => formulaV1(a, propRef));
      const op = V1_OPERATORS[String(node.name)];
      if (op && args.length === 2) return `(${args[0]} ${op} ${args[1]})`;
      if (node.name === "not" && args.length === 1) return `not ${args[0]}`;
      if (node.name === "unaryMinus" && args.length === 1) return `-${args[0]}`;
      if (node.name === "if" && args.length === 3) return `if(${args.join(", ")})`;
      return `${String(node.name ?? "")}(${args.join(", ")})`;
    }
    default:
      return "";
  }
}

function capBlocks(blocks: Block[], max: number): Block[] {
  let n = 0;
  const walk = (list: Block[]): Block[] => {
    const out: Block[] = [];
    for (const b of list) {
      if (n >= max) break;
      n++;
      out.push({ ...b, children: walk(b.children) });
    }
    return out;
  };
  const out = walk(blocks);
  if (n >= max) out.push({ id: blockIdOf(`cut-${max}`), type: "paragraph", props: {}, content: [{ type: "text", text: "This page was cut short on import: it had more blocks than Notes takes on one page.", styles: { italic: true } }], children: [] });
  return out;
}

let usedBlockIds = new Set<string>();

function blockIdOf(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 56) || "block";
  for (let n = 0; ; n++) {
    const id = n ? `${clean}-${n}` : clean;
    if (usedBlockIds.has(id)) continue;
    usedBlockIds.add(id);
    return id;
  }
}

function newHex(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function formulaCompiles(expression: string): boolean {
  return !isError(compileFormula(expression));
}

export type { Property };

export async function importNotionRecords(records: NotionRecords, sink: Sink, reader: RecordsReader, options: RecordsOptions = {}): Promise<RecordsResult> {
  return new NotionRecordsImport(records, sink, reader, options).run();
}

export function readRecordsJson(text: string): NotionRecords {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rootIds) || typeof raw.blocks !== "object") throw new Error("That isn't a Notion records file: it needs rootIds and blocks.");
  return {
    spaceId: String(raw.spaceId ?? ""),
    rootIds: (raw.rootIds as unknown[]).filter((x): x is string => typeof x === "string"),
    blocks: (raw.blocks ?? {}) as Record<string, any>,
    collections: (raw.collections ?? {}) as Record<string, any>,
    views: (raw.views ?? {}) as Record<string, any>,
    users: (raw.users ?? {}) as Record<string, any>,
    rows: (raw.rows ?? {}) as Record<string, string[]>,
    files: (raw.files ?? {}) as NotionRecords["files"],
    ...(incompleteOf(raw.incomplete) ? { incomplete: incompleteOf(raw.incomplete)! } : {}),
  };
}

function incompleteOf(raw: unknown): NotionRecords["incomplete"] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, 100_000) : []);
  const collections = ids(r.collections);
  const blocks = ids(r.blocks);
  return collections.length || blocks.length ? { collections, blocks } : null;
}
