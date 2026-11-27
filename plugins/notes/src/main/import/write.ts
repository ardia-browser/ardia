import * as Y from "yjs";
import { addOption, addProperty, deleteProperty, DEFAULT_TAGS, initDatabase, readSchema, schemaOf, TITLE, updateProperty, type PropType } from "../../shared/database";
import { blocksOf, childrenOf, createPage, newId, orderBetween } from "../../shared/model";
import { IMPORT_LIMITS, ImportCancelled } from "./limits";
import { exportPageId, notionPageFamilies, pickPageId } from "./notionIds";
import { bodyPrint, EMPTY_BODY, printOf, Rebase, seedBody } from "./rebase";
import { safeUrl, textOf, type Block, type Column, type ImportNode, type Inline, type Marks } from "./ir";

export type Sink = {
  tree: Y.Doc;
  by: string;
  newDoc(page: string): Y.Doc;
  doc?(page: string): Promise<Y.Doc>;
  putFile(bytes: Uint8Array, ext: string): Promise<string>;
  hasFile?(sha: string, size: number): Promise<boolean>;
  flush(): Promise<void>;
  settle?(): Promise<void>;
  alive(): boolean;
};

export type Plan = {
  nodes: ImportNode[];
  link(target: string, from: ImportNode): string | null;
  asset(src: string, from: ImportNode): string | null;
  readAsset(path: string): Promise<Uint8Array>;
  assetSize?(path: string): number;
  assetName?(path: string): string;
  assetFingerprint?(path: string): string | null;
  stableKey?(node: ImportNode): string | null;
  prefetch?(paths: Iterable<string>): void;
  warnings?: number;
};

export type PlanSync = { workspace: string; candidates: ImportRecord[] };

export const SYNCED_EXPORT_PREFIX = "notion-export-";

export type WriteProgress = { pages: number; databases: number; attachments: number; skipped: number; current: string; done: number; total: number };

export type WriteResult = { root: string; pages: number; databases: number; attachments: number; skipped: number; conflicts: number; ids: Map<string, string>; pageIds: string[]; archived: number; files: Record<string, string>; recordId: string | null };

type Resolved = { page: (target: string) => string | null; asset: (src: string) => { url: string; name: string } | null };

const MARK_ATTRS = (marks: Marks | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!marks) return out;
  if (marks.bold) out.bold = {};
  if (marks.italic) out.italic = {};
  if (marks.underline) out.underline = {};
  if (marks.strike) out.strike = {};
  if (marks.code) out.code = {};
  if (marks.highlight) out.backgroundColor = { stringValue: "yellow" };
  if (marks.link) {
    const safe = safeUrl(marks.link);
    if (safe) out.link = { href: safe };
  }
  return out;
};

function inlineNodes(parts: Inline[], resolved: Resolved): (Y.XmlText | Y.XmlElement)[] {
  const nodes: (Y.XmlText | Y.XmlElement)[] = [];
  let text: Y.XmlText | null = null;
  let at = 0;
  const textRun = (value: string, marks?: Marks) => {
    if (!value) return;
    if (!text) {
      text = new Y.XmlText();
      nodes.push(text);
      at = 0;
    }
    text.insert(at, value, MARK_ATTRS(marks));
    at += value.length;
  };
  for (const part of parts) {
    if (part.t === "text") textRun(part.text.replace(/\u0000/g, ""), part.marks);
    else if (part.t === "ref") {
      const page = resolved.page(part.target);
      if (page) {
        const el = new Y.XmlElement("mention");
        el.setAttribute("kind", "page");
        el.setAttribute("pageId", page);
        nodes.push(el);
        text = null;
      } else textRun(part.text, part.marks);
    } else if (part.t === "math") {
      const el = new Y.XmlElement("inlineEquation");
      const inner = new Y.XmlText();
      inner.insert(0, part.text);
      el.insert(0, [inner]);
      nodes.push(el);
      text = null;
    } else if (part.t === "date") {
      const el = new Y.XmlElement("mention");
      el.setAttribute("kind", "date");
      el.setAttribute("date", part.date);
      nodes.push(el);
      text = null;
    } else {
      nodes.push(new Y.XmlElement("hardBreak"));
      text = null;
    }
  }
  return nodes;
}

function plainText(value: string): Y.XmlText {
  const t = new Y.XmlText();
  if (value) t.insert(0, value);
  return t;
}

function contentElement(block: Block, resolved: Resolved): Y.XmlElement | null {
  const props = block.props ?? {};
  switch (block.type) {
    case "codeBlock": {
      const el = new Y.XmlElement("codeBlock");
      el.setAttribute("language", String(props.language || "text").slice(0, 40));
      el.insert(0, [plainText(block.text ?? "")]);
      return el;
    }
    case "equation": {
      const el = new Y.XmlElement("equation");
      el.insert(0, [plainText(block.text ?? "")]);
      return el;
    }
    case "divider":
      return new Y.XmlElement("divider");
    case "image":
    case "file": {
      const asset = block.src ? resolved.asset(block.src) : null;
      if (!asset) return null;
      const el = new Y.XmlElement(block.type === "image" && !/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico)$/i.test(asset.name) && asset.url.startsWith("file:") ? "file" : block.type);
      el.setAttribute("url", asset.url);
      el.setAttribute("name", asset.name);
      if (typeof props.caption === "string" && props.caption) el.setAttribute("caption", props.caption.slice(0, 500));
      return el;
    }
    case "pageRef": {
      const page = block.target ? resolved.page(block.target) : null;
      if (!page) return null;
      const el = new Y.XmlElement(props.subpage ? "subpage" : "linkToPage");
      el.setAttribute("pageId", page);
      return el;
    }
    case "bookmark": {
      const url = safeUrl(String(props.url ?? ""));
      if (!url) return null;
      const el = new Y.XmlElement("bookmark");
      el.setAttribute("url", url);
      return el;
    }
    case "table": {
      const el = new Y.XmlElement("table");
      const rows = (block.rows ?? []).map((row) => {
        const tr = new Y.XmlElement("tableRow");
        tr.insert(
          0,
          row.map((cell) => {
            const td = new Y.XmlElement("tableCell");
            const p = new Y.XmlElement("tableParagraph");
            const kids = inlineNodes(cell, resolved);
            if (kids.length) p.insert(0, kids);
            td.insert(0, [p]);
            return td;
          }),
        );
        return tr;
      });
      if (!rows.length) return null;
      el.insert(0, rows);
      return el;
    }
    default: {
      const el = new Y.XmlElement(block.type);
      if (block.type === "heading") el.setAttribute("level", Math.min(3, Math.max(1, Number(props.level) || 1)) as unknown as string);
      if (block.type === "checkListItem") el.setAttribute("checked", (props.checked === true) as unknown as string);
      if (block.type === "callout") el.setAttribute("icon", String(props.icon || "💡").slice(0, 16));
      const kids = inlineNodes(block.content ?? [], resolved);
      if (kids.length) el.insert(0, kids);
      return el;
    }
  }
}

function container(block: Block, resolved: Resolved, budget: { n: number }, depth: number, blockId: () => string = newId): Y.XmlElement | null {
  if (budget.n <= 0) return null;
  let content = contentElement(block, resolved);
  if (!content && (block.type === "image" || block.type === "file") && block.src) {
    const label = block.src.replace(/^[a-z]+:/, "").split("/").pop() ?? "";
    content = contentElement({ type: "paragraph", content: [{ t: "text", text: `[${label}]`, marks: { italic: true } }] }, resolved);
  }
  if (!content) return null;
  budget.n--;
  const box = new Y.XmlElement("blockContainer");
  box.setAttribute("id", blockId());
  box.insert(0, [content]);
  const children = depth < IMPORT_LIMITS.depth ? (block.children ?? []).map((c) => container(c, resolved, budget, depth + 1, blockId)).filter((c): c is Y.XmlElement => !!c) : [];
  if (children.length) {
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, children);
    box.insert(1, [group]);
  }
  return box;
}

export function writeImportedBlocks(doc: Y.Doc, blocks: Block[], resolved: Resolved, blockId: () => string = newId) {
  const budget = { n: IMPORT_LIMITS.blocksPerPage };
  const boxes = blocks.map((b) => container(b, resolved, budget, 0, blockId)).filter((c): c is Y.XmlElement => !!c);
  if (budget.n <= 0) {
    const note = container({ type: "paragraph", content: [{ t: "text", text: "This page was cut short on import: it had more blocks than Notes takes on one page.", marks: { italic: true } }] }, resolved, { n: 1 }, 0, blockId);
    if (note) boxes.push(note);
  }
  if (!boxes.length) return;
  const fragment = blocksOf(doc);
  doc.transact(() => {
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, boxes);
    fragment.insert(0, [group]);
  });
}

const MIME_EXT = /\.([a-z0-9]{1,8})$/i;

const yieldNow = () => new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

function collectSrcs(blocks: Block[], out: Set<string>) {
  for (const b of blocks) {
    if ((b.type === "image" || b.type === "file") && b.src) out.add(b.src);
    if (b.children) collectSrcs(b.children, out);
  }
}

const parseNumber = (raw: string): number | null => {
  const cleaned = raw.replace(/[,\s$€£¥₹%]/g, "");
  if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? (raw.trim().endsWith("%") ? n / 100 : n) : null;
};

export function parseDate(raw: string): string | null {
  const v = raw.trim().replace(/^@/, "");
  if (!v) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(v);
  if (iso) return iso[4] ? `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}` : `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(v.replace(/\s*\(.*\)$/, "").replace(/ (\d{1,2}:\d{2}) ?(AM|PM)/i, " $1 $2"));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return /\d:\d\d/.test(v) ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

const splitMulti = (raw: string) =>
  raw
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);

function columnType(column: Column): PropType {
  return column.type === "person" ? "text" : column.type === "files" ? "text" : column.type;
}

type SchemaProp = { id: string; type: PropType; options: Map<string, string> };

function writeDatabase(doc: Y.Doc, node: ImportNode, rows: ImportNode[], stable?: (key: string) => string): Map<string, SchemaProp> {
  initDatabase(doc, { title: "Table" });
  const columns = (node.columns ?? []).slice(0, IMPORT_LIMITS.columns);
  const props = new Map<string, SchemaProp>();
  const hasTags = columns.some((c, i) => i > 0 && c.name.trim().toLowerCase() === "tags" && c.type === "multi_select");
  if (!hasTags && schemaOf(doc).get(DEFAULT_TAGS)?.get("deleted") !== true) deleteProperty(doc, DEFAULT_TAGS);
  columns.forEach((column, index) => {
    if (index === 0) return;
    const type = columnType(column);
    const name = column.name.slice(0, 200) || `Column ${index + 1}`;
    const isTags = hasTags && column.name.trim().toLowerCase() === "tags" && column.type === "multi_select";
    let id: string;
    if (isTags) id = DEFAULT_TAGS;
    else if (stable) {
      id = stable(`prop:${column.name}`);
      const entry = schemaOf(doc).get(id);
      if (entry?.get("deleted") === true) return;
      if (!entry) addProperty(doc, { type, name }, { id });
      else if (entry.get("name") !== name || entry.get("type") !== type) updateProperty(doc, id, { name, type });
    } else id = addProperty(doc, { type, name });
    const options = new Map<string, string>();
    if (type === "select" || type === "multi_select" || type === "status") {
      const names = new Set<string>();
      for (const row of rows) {
        const raw = row.cells?.[column.name] ?? "";
        for (const v of type === "multi_select" ? splitMulti(raw) : [raw.trim()]) if (v) names.add(v.slice(0, 200));
        if (names.size > 500) break;
      }
      const existing = readSchema(doc).find((p) => p.id === id);
      for (const option of existing?.options ?? []) options.set(option.name, option.id);
      const palette = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
      let n = 0;
      for (const name of names)
        if (!options.has(name))
          options.set(
            name,
            addOption(doc, id, name, { color: palette[n++ % palette.length], ...(type === "status" ? { group: /done|complete/i.test(name) ? "done" : /progress|doing/i.test(name) ? "doing" : "todo" } : {}), ...(stable ? { id: stable(`option:${id}:${name}`) } : {}) }),
          );
    }
    props.set(column.name, { id, type, options });
  });
  return props;
}

function cellValue(raw: string, prop: { type: PropType; options: Map<string, string> }): unknown {
  const v = raw.trim();
  if (!v) return undefined;
  switch (prop.type) {
    case "number":
      return parseNumber(v) ?? undefined;
    case "checkbox":
      return /^(yes|true|x|1|✓|checked)$/i.test(v);
    case "select":
    case "status":
      return prop.options.get(v.slice(0, 200));
    case "multi_select":
      return splitMulti(v)
        .map((s) => prop.options.get(s.slice(0, 200)))
        .filter(Boolean);
    case "date": {
      const parts = v.split(/\s+→\s+/);
      const start = parseDate(parts[0]!);
      if (!start) return v.length < 200 ? undefined : undefined;
      const end = parts[1] ? parseDate(parts[1]) : null;
      return end ? { start, end } : { start };
    }
    case "url":
    case "email":
    case "phone":
    case "text":
      return v.slice(0, 20_000);
    default:
      return v.slice(0, 20_000);
  }
}

const DOCS_AHEAD = 3;

export const syncedId = exportPageId;

const sameValue = (a: unknown, b: unknown) => a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

function sequence(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n++).toString(36)}`;
}

type BodyTarget = { tree: Y.Doc; page: string; entry: Y.Map<unknown> | undefined; rebase: Rebase };

function writeBody(doc: Y.Doc, blocks: Block[], resolved: Resolved, existed: boolean, target: BodyTarget | null) {
  if (!target) return writeImportedBlocks(doc, blocks, resolved);
  const ids = () => sequence(target.page);
  const fresh = new Y.Doc();
  writeImportedBlocks(fresh, blocks, resolved, ids());
  const incoming = bodyPrint(blocksOf(fresh));
  fresh.destroy();
  const fragment = blocksOf(doc);
  const current = fragment.length ? bodyPrint(fragment) : EMPTY_BODY;
  let write = false;
  target.tree.transact(() => (write = target.rebase.body(target.page, target.entry, current, incoming, existed)));
  if (!write) return;
  if (!fragment.length) return seedBody(doc, target.page, incoming, (scratch) => writeImportedBlocks(scratch, blocks, resolved, ids()));
  doc.transact(() => fragment.delete(0, fragment.length));
  writeImportedBlocks(doc, blocks, resolved, ids());
}

function previousExport(candidates: ImportRecord[], ids: Set<string>): ImportRecord | null {
  let best: ImportRecord | null = null;
  let bestShared = 0;
  for (const record of candidates) {
    if (!record.id.startsWith(SYNCED_EXPORT_PREFIX)) continue;
    let shared = 0;
    for (const id of record.pages ?? []) if (ids.has(id)) shared++;
    if (shared > bestShared) {
      best = record;
      bestShared = shared;
    }
  }
  return best;
}

export async function writePlan(plan: Plan, sink: Sink, root: { title: string; icon: string }, progress: (p: WriteProgress) => void, cancelled: () => boolean, now: number, options: { sync?: PlanSync; onRoot?: (id: string) => void } = {}): Promise<WriteResult> {
  const sync = options.sync;
  const nodes = plan.nodes.slice(0, IMPORT_LIMITS.pages);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const ids = new Map<string, string>();
  const pagesMap = sink.tree.getMap<Y.Map<unknown>>("pages");
  const syncing = sync && plan.stableKey ? sync : null;
  const live = (id: string): Y.Map<unknown> | null => {
    const entry = pagesMap.get(id);
    return entry instanceof Y.Map && entry.get("deleted") !== true ? entry : null;
  };
  const taken = new Set<string>();
  const keyOf = (n: ImportNode) => plan.stableKey?.(n) ?? `key:${n.key}`;
  for (const n of nodes) {
    let id: string | null = null;
    if (syncing) id = pickPageId(pagesMap, (c) => taken.has(c), notionPageFamilies(syncing.workspace, keyOf(n)));
    id ??= newId();
    taken.add(id);
    ids.set(n.key, id);
  }
  const depthOf = (n: ImportNode) => {
    let d = 0;
    let cur: ImportNode | undefined = n;
    const seen = new Set<string>();
    while (cur?.parent && byKey.has(cur.parent) && !seen.has(cur.parent) && d < 64) {
      seen.add(cur.parent);
      cur = byKey.get(cur.parent);
      d++;
    }
    return d;
  };
  const ordered = nodes.map((n, i) => ({ n, i, d: depthOf(n) })).sort((a, b) => a.d - b.d || a.i - b.i);
  const previous = syncing ? previousExport(syncing.candidates, taken) : null;
  const previousRoot = previous?.roots[0];
  const top = nodes.filter((n) => !n.parent || !byKey.has(n.parent));
  const seededRoot = syncing ? pickPageId(pagesMap, (c) => taken.has(c), [(k) => syncedId(syncing.workspace, `root:${printOf(top.map(keyOf).sort().join("\n"))}${k ? `#${k}` : ""}`)]) : null;
  const rootCandidate = previousRoot && live(previousRoot) ? previousRoot : seededRoot;
  const reusedRoot = rootCandidate && live(rootCandidate) ? rootCandidate : null;
  const rootId = reusedRoot ?? createPage(sink.tree, { ...(seededRoot ? { id: seededRoot } : {}), parent: "", kind: "page", title: root.title, icon: root.icon, by: sink.by, now });
  if (!reusedRoot) options.onRoot?.(rootId);
  if (reusedRoot) {
    const entry = live(reusedRoot)!;
    if (Number(entry.get("archivedAt") ?? 0) > 0) sink.tree.transact(() => entry.set("archivedAt", 0));
  }
  const rootDoc = reusedRoot && sink.doc ? await sink.doc(rootId) : sink.newDoc(rootId);
  const existed = new Set<string>();
  if (syncing) for (const n of nodes) if (live(ids.get(n.key)!)) existed.add(ids.get(n.key)!);
  const lastOrder = new Map<string, string | null>();
  const orderAfter = (parent: string) => {
    if (!lastOrder.has(parent)) lastOrder.set(parent, syncing ? (childrenOf(sink.tree, parent).at(-1)?.order ?? null) : null);
    const order = orderBetween(lastOrder.get(parent) ?? null, null);
    lastOrder.set(parent, order);
    return order;
  };
  const counts = { pages: 0, databases: 0, attachments: 0, skipped: plan.warnings ?? 0 };
  const rebase = new Rebase();
  const bodyTarget = (page: string): BodyTarget | null => (syncing ? { tree: sink.tree, page, entry: pagesMap.get(page), rebase } : null);
  const total = ordered.length;
  const parentOf = (n: ImportNode) => (n.parent && byKey.has(n.parent) && n.parent !== n.key ? ids.get(n.parent)! : rootId);
  for (let at = 0; at < ordered.length; at += 250) {
    if (cancelled() || !sink.alive()) throw new ImportCancelled();
    sink.tree.transact(() => {
      for (const { n } of ordered.slice(at, at + 250)) {
        const id = ids.get(n.key)!;
        const parent = parentOf(n);
        const title = n.title.slice(0, 2000);
        const entry = existed.has(id) ? live(id) : null;
        if (entry) {
          let changed = false;
          const set = (k: string, v: unknown) => {
            if (entry.get(k) === v) return;
            entry.set(k, v);
            changed = true;
          };
          set("kind", n.kind);
          rebase.field(id, entry, "title", entry.get("title") ?? "", title, () => set("title", title));
          rebase.field(id, entry, "icon", entry.get("icon") ?? "", n.icon ?? "", () => set("icon", n.icon ?? ""));
          rebase.field(id, entry, "archivedAt", Number(entry.get("archivedAt") ?? 0), 0, () => set("archivedAt", 0));
          rebase.field(id, entry, "parent", entry.get("parent") ?? "", parent, () => {
            set("parent", parent);
            set("order", orderAfter(parent));
          });
          if (changed) {
            entry.set("updatedAt", now);
            entry.set("updatedBy", sink.by);
          }
          continue;
        }
        createPage(sink.tree, { id, parent, kind: n.kind, title, icon: n.icon, order: orderAfter(parent), by: sink.by, now: n.createdAt && Number.isFinite(n.createdAt) ? n.createdAt : now });
        const made = syncing ? pagesMap.get(id) : undefined;
        if (made) for (const [k, v] of [["title", title], ["icon", n.icon ?? ""], ["archivedAt", 0], ["parent", parent]] as const) rebase.remember(made, k, v);
      }
    });
    await yieldNow();
  }
  const rowsOf = new Map<string, ImportNode[]>();
  for (const n of nodes) if (n.parent && byKey.get(n.parent)?.kind === "database") (rowsOf.get(n.parent) ?? rowsOf.set(n.parent, []).get(n.parent)!).push(n);
  const schemas = new Map<string, Map<string, SchemaProp>>();
  const assetCache = new Map<string, { url: string; name: string } | null>();
  const externalAsset = (src: string) => {
    const external = safeUrl(src);
    return external && /^https?:/i.test(external) ? { url: external, name: external.split("/").pop()?.split("?")[0] ?? "" } : null;
  };
  const knownFiles = previous?.files ?? {};
  const fileMarks: Record<string, string> = {};
  let done = 0;
  const report = (current: string) => progress({ ...counts, current, done, total });
  const loadAhead = (from: number) => {
    if (!plan.prefetch) return;
    const paths: string[] = [];
    for (let i = from; i < Math.min(ordered.length, from + DOCS_AHEAD); i++) {
      const next = ordered[i]!.n;
      if (next.load && next.path) paths.push(next.path);
    }
    plan.prefetch(paths);
  };
  for (const [index, { n }] of ordered.entries()) {
    if (cancelled() || !sink.alive()) throw new ImportCancelled();
    loadAhead(index + 1);
    report(n.path ?? n.title);
    const id = ids.get(n.key)!;
    const had = existed.has(id);
    const doc = had && sink.doc ? await sink.doc(id) : sink.newDoc(id);
    if (n.kind === "database") {
      schemas.set(n.key, writeDatabase(doc, n, rowsOf.get(n.key) ?? [], syncing ? (key) => syncedId(syncing.workspace, `${id}:${key}`) : undefined));
      counts.databases++;
    } else counts.pages++;
    const parent = n.parent ? byKey.get(n.parent) : undefined;
    if (parent?.kind === "database" && n.cells) {
      const schema = schemas.get(parent.key);
      const entry = pagesMap.get(id);
      const propsMap = entry?.get("props");
      if (schema && propsMap instanceof Y.Map && entry)
        sink.tree.transact(() => {
          for (const [name, raw] of Object.entries(n.cells!)) {
            const prop = schema.get(name);
            if (!prop || prop.id === TITLE) continue;
            const value = cellValue(raw, prop);
            const incoming = value !== undefined && !(Array.isArray(value) && !value.length) ? value : null;
            const current = propsMap.has(prop.id) ? propsMap.get(prop.id) : null;
            const apply = () => {
              if (incoming === null) propsMap.delete(prop.id);
              else if (!sameValue(current, incoming)) propsMap.set(prop.id, incoming);
            };
            if (syncing) rebase.field(id, entry, `prop:${prop.id}`, current, incoming, apply);
            else if (incoming !== null || had) apply();
          }
        });
    }
    let blocks: Block[] | null = null;
    const before = { title: n.title, icon: n.icon };
    try {
      blocks = n.blocks ?? (n.load ? await n.load() : []);
    } catch {
      counts.skipped++;
    }
    if (n.title !== before.title || n.icon !== before.icon) {
      const entry = pagesMap.get(id);
      const title = n.title.slice(0, 2000);
      const icon = (n.icon ?? "").slice(0, 16);
      if (entry)
        sink.tree.transact(() => {
          if (n.title !== before.title) rebase.field(id, entry, "title", entry.get("title") ?? "", title, () => entry.set("title", title));
          if (n.icon !== before.icon) rebase.field(id, entry, "icon", entry.get("icon") ?? "", icon, () => entry.set("icon", icon));
        });
    }
    if (blocks === null) {
      done++;
      continue;
    }
    const srcs = new Set<string>();
    collectSrcs(blocks, srcs);
    if (plan.prefetch && srcs.size) {
      const wanted: string[] = [];
      for (const src of srcs) {
        if (externalAsset(src)) continue;
        const path = plan.asset(src, n);
        if (!path || assetCache.has(path)) continue;
        const print = syncing ? plan.assetFingerprint?.(path) : null;
        if (print && knownFiles[syncedId(syncing!.workspace, `file:${print}`)]) continue;
        wanted.push(path);
      }
      plan.prefetch(wanted);
    }
    const pageAssets = new Map<string, { url: string; name: string } | null>();
    for (const src of srcs) {
      const external = externalAsset(src);
      if (external) {
        pageAssets.set(src, external);
        continue;
      }
      const path = plan.asset(src, n);
      if (!path) {
        pageAssets.set(src, null);
        counts.skipped++;
        continue;
      }
      if (assetCache.has(path)) {
        pageAssets.set(src, assetCache.get(path)!);
        continue;
      }
      try {
        const size = plan.assetSize?.(path) ?? 0;
        if (size > IMPORT_LIMITS.attachmentBytes) throw new Error("too big");
        report(path);
        const name = plan.assetName?.(path) ?? path.split("/").pop() ?? "file";
        const print = syncing ? plan.assetFingerprint?.(path) : null;
        const mark = print ? syncedId(syncing!.workspace, `file:${print}`) : null;
        const known = mark ? knownFiles[mark] : undefined;
        let sha: string;
        if (mark && known && sink.hasFile && (await sink.hasFile(known, size))) sha = known;
        else {
          const bytes = await plan.readAsset(path);
          const ext = (MIME_EXT.exec(name)?.[1] ?? "bin").toLowerCase();
          sha = await sink.putFile(bytes, ext);
        }
        if (mark) fileMarks[mark] = sha;
        const value = { url: `file:${sha}`, name: name.slice(0, 255) };
        assetCache.set(path, value);
        pageAssets.set(src, value);
        counts.attachments++;
      } catch (error) {
        if (error instanceof ImportCancelled) throw error;
        assetCache.set(path, null);
        pageAssets.set(src, null);
        counts.skipped++;
      }
    }
    const resolved: Resolved = {
      page: (target) => {
        const key = plan.link(target, n);
        return key ? (ids.get(key) ?? null) : null;
      },
      asset: (src) => pageAssets.get(src) ?? null,
    };
    writeBody(doc, blocks, resolved, had, bodyTarget(id));
    done++;
    if (done % 25 === 0) await yieldNow();
  }
  if (top.length) writeBody(rootDoc, top.slice(0, 2000).map((n): Block => ({ type: "pageRef", target: `key:${n.key}`, props: { subpage: true } })), { page: (t) => ids.get(t.slice(4)) ?? null, asset: () => null }, !!reusedRoot, bodyTarget(rootId));
  const kept = new Set(ids.values());
  const whole = plan.nodes.length <= IMPORT_LIMITS.pages;
  const missing = (previous?.pages ?? []).filter((id) => !kept.has(id) && id !== rootId);
  const gone = whole ? missing : [];
  let archived = 0;
  if (gone.length)
    sink.tree.transact(() => {
      for (const id of gone) {
        const entry = live(id);
        if (!entry || Number(entry.get("archivedAt") ?? 0) > 0) continue;
        entry.set("archivedAt", now);
        entry.set("updatedBy", sink.by);
        rebase.remember(entry, "archivedAt", now);
        archived++;
      }
    });
  report("");
  await sink.flush();
  return { root: rootId, ...counts, conflicts: rebase.conflicts.size, ids, pageIds: whole ? [...kept] : [...kept, ...missing], archived, files: fileMarks, recordId: syncing ? (previous?.id ?? `${SYNCED_EXPORT_PREFIX}${rootId}`) : null };
}

export type ImportRecord = { id: string; source: string; at: number; roots: string[]; by: string; pages?: string[]; files?: Record<string, string> };

const FILE_MARKS_MAX = 20_000;

export const importsOf = (tree: Y.Doc) => tree.getMap<Y.Map<unknown>>("imports");

export function recordImport(tree: Y.Doc, record: ImportRecord) {
  tree.transact(() => {
    const entry = new Y.Map<unknown>();
    entry.set("source", record.source.slice(0, 40));
    entry.set("at", record.at);
    entry.set("by", record.by);
    entry.set("roots", record.roots.slice(0, 2000));
    if (record.pages) entry.set("pages", record.pages.slice(0, 50_000));
    if (record.files) entry.set("files", Object.fromEntries(Object.entries(record.files).filter(([k, v]) => /^[0-9a-f]{12}$/.test(k) && /^[0-9a-f]{64}$/.test(v)).slice(0, FILE_MARKS_MAX)));
    importsOf(tree).set(record.id, entry);
  });
}

export function readImports(tree: Y.Doc): ImportRecord[] {
  const out: ImportRecord[] = [];
  importsOf(tree).forEach((entry, id) => {
    if (!(entry instanceof Y.Map)) return;
    const roots = entry.get("roots");
    const pages = entry.get("pages");
    const files = fileMarksOf(entry.get("files"));
    out.push({ id, source: String(entry.get("source") ?? ""), at: Number(entry.get("at") ?? 0), by: String(entry.get("by") ?? ""), roots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === "string") : [], ...(Array.isArray(pages) ? { pages: pages.filter((r): r is string => typeof r === "string") } : {}), ...(files ? { files } : {}) });
  });
  return out.sort((a, b) => b.at - a.at);
}

function fileMarksOf(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= FILE_MARKS_MAX) break;
    if (/^[0-9a-f]{12}$/.test(k) && typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) {
      out[k] = v;
      n++;
    }
  }
  return out;
}

export function undoImport(tree: Y.Doc, id: string, by: string, now = Date.now()): string[] {
  const record = readImports(tree).find((r) => r.id === id);
  if (!record) return [];
  const pages = tree.getMap<Y.Map<unknown>>("pages");
  const archived: string[] = [];
  tree.transact(() => {
    for (const root of record.roots) {
      const entry = pages.get(root);
      if (!entry || entry.get("deleted") === true || Number(entry.get("archivedAt") ?? 0) > 0) continue;
      entry.set("archivedAt", now);
      entry.set("updatedAt", now);
      entry.set("updatedBy", by);
      archived.push(root);
    }
    importsOf(tree).delete(id);
  });
  return archived;
}

export { textOf };
