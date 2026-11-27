import * as Y from "yjs";
import type { PageId, PageKind } from "./protocol";

export type PageMeta = {
  id: PageId;
  title: string;
  icon: string;
  cover: string;
  coverY: number;
  parent: PageId | "";
  order: string;
  kind: PageKind;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  archivedAt: number;
  deleted: boolean;
  font: "default" | "serif" | "mono";
  fullWidth: boolean;
  smallText: boolean;
  locked: boolean;
  isTemplate: boolean;
  sharedIn: string;
  props: Record<string, unknown>;
};

export const PAGE_FIELDS = ["title", "icon", "cover", "coverY", "parent", "order", "kind", "createdAt", "createdBy", "updatedAt", "updatedBy", "archivedAt", "deleted", "font", "fullWidth", "smallText", "locked", "isTemplate"] as const;

export const pagesOf = (tree: Y.Doc) => tree.getMap<Y.Map<unknown>>("pages");
export const metaOf = (tree: Y.Doc) => tree.getMap<unknown>("meta");
export const blocksOf = (page: Y.Doc) => page.getXmlFragment("blocks");
export const commentsOf = (page: Y.Doc) => page.getMap<unknown>("comments");

export function newId(): PageId {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

export function orderBetween(before: string | null, after: string | null): string {
  const a = before ?? "";
  let b = after;
  let out = "";
  for (let i = 0; ; i++) {
    const lo = i < a.length ? DIGITS.indexOf(a[i]!) : 0;
    const hi = b !== null && i < b.length ? DIGITS.indexOf(b[i]!) : DIGITS.length;
    if (hi - lo > 1) return out + DIGITS[(lo + hi) >> 1];
    out += DIGITS[lo];
    if (hi - lo === 1) b = null;
  }
}

function read(entry: Y.Map<unknown>, id: PageId): PageMeta {
  const props = entry.get("props");
  return {
    id,
    title: String(entry.get("title") ?? ""),
    icon: String(entry.get("icon") ?? ""),
    cover: String(entry.get("cover") ?? ""),
    coverY: Number(entry.get("coverY") ?? 50),
    parent: String(entry.get("parent") ?? ""),
    order: String(entry.get("order") ?? ""),
    kind: entry.get("kind") === "database" ? "database" : "page",
    createdAt: Number(entry.get("createdAt") ?? 0),
    createdBy: String(entry.get("createdBy") ?? ""),
    updatedAt: Number(entry.get("updatedAt") ?? 0),
    updatedBy: String(entry.get("updatedBy") ?? ""),
    archivedAt: Number(entry.get("archivedAt") ?? 0),
    deleted: entry.get("deleted") === true,
    font: entry.get("font") === "serif" || entry.get("font") === "mono" ? (entry.get("font") as "serif" | "mono") : "default",
    fullWidth: entry.get("fullWidth") === true,
    smallText: entry.get("smallText") === true,
    locked: entry.get("locked") === true,
    isTemplate: entry.get("isTemplate") === true,
    sharedIn: typeof entry.get("sharedIn") === "string" ? String(entry.get("sharedIn")) : "",
    props: props instanceof Y.Map ? (props.toJSON() as Record<string, unknown>) : {},
  };
}

type PageIndex = { dirty: boolean; all: PageMeta[]; byId: Map<PageId, PageMeta>; children: Map<string, PageMeta[]> };

const indexes = new WeakMap<Y.Doc, PageIndex>();

const byOrder = (a: PageMeta, b: PageMeta) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1);

function breakParentCycles(all: PageMeta[]): PageMeta[] {
  const byId = new Map(all.map((p) => [p.id, p]));
  const settled = new Set<string>();
  for (const start of all) {
    if (settled.has(start.id)) continue;
    const path: PageMeta[] = [];
    const onPath = new Map<string, number>();
    let current: PageMeta | undefined = start;
    while (current && !settled.has(current.id) && !onPath.has(current.id)) {
      onPath.set(current.id, path.length);
      path.push(current);
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    if (current && onPath.has(current.id)) {
      const cycle = path.slice(onPath.get(current.id));
      cycle.reduce((low, p) => (p.id < low.id ? p : low)).parent = "";
    }
    for (const p of path) settled.add(p.id);
  }
  return all;
}

function readAll(tree: Y.Doc): PageMeta[] {
  const out: PageMeta[] = [];
  pagesOf(tree).forEach((entry, id) => out.push(read(entry, id)));
  return breakParentCycles(out);
}

function readOne(tree: Y.Doc, id: PageId): PageMeta | null {
  const pages = pagesOf(tree);
  const entry = pages.get(id);
  if (!entry) return null;
  const page = read(entry, id);
  const path = [id];
  for (let at = page.parent; at && path.length <= pages.size; ) {
    const index = path.indexOf(at);
    if (index >= 0) {
      if (index === 0 && path.every((p) => p >= id)) page.parent = "";
      break;
    }
    path.push(at);
    const next = pages.get(at);
    at = next ? String(next.get("parent") ?? "") : "";
  }
  return page;
}

function pageIndex(tree: Y.Doc): PageIndex | null {
  if ((tree as unknown as { _transaction: unknown })._transaction) return null;
  let index = indexes.get(tree);
  if (!index) {
    const created: PageIndex = { dirty: true, all: [], byId: new Map(), children: new Map() };
    tree.on("beforeTransaction", () => {
      created.dirty = true;
    });
    indexes.set(tree, (index = created));
  }
  if (index.dirty) {
    index.all = readAll(tree);
    index.byId = new Map(index.all.map((p) => [p.id, p]));
    index.children = new Map();
    for (const p of index.all) {
      const list = index.children.get(p.parent);
      if (list) list.push(p);
      else index.children.set(p.parent, [p]);
    }
    for (const list of index.children.values()) list.sort(byOrder);
    index.dirty = false;
  }
  return index;
}

export function getPage(tree: Y.Doc, id: PageId): PageMeta | null {
  const index = pageIndex(tree);
  if (index) return index.byId.get(id) ?? null;
  return readOne(tree, id);
}

export function allPages(tree: Y.Doc): PageMeta[] {
  const index = pageIndex(tree);
  return index ? index.all.slice() : readAll(tree);
}

export const isLive = (p: PageMeta) => !p.deleted && p.archivedAt === 0;

export const isShareLink = (p: Pick<PageMeta, "sharedIn" | "deleted"> | null | undefined): boolean => !!p && !p.deleted && p.sharedIn !== "";

export function childrenOf(tree: Y.Doc, parent: PageId | "", options: { archived?: boolean } = {}): PageMeta[] {
  const index = pageIndex(tree);
  const pool = index ? (index.children.get(parent) ?? []) : readAll(tree).filter((p) => p.parent === parent).sort(byOrder);
  return pool.filter((p) => !p.deleted && (options.archived || p.archivedAt === 0));
}

export function ancestorsOf(tree: Y.Doc, id: PageId): PageMeta[] {
  const out: PageMeta[] = [];
  const seen = new Set<string>([id]);
  let current = getPage(tree, id);
  while (current?.parent && !seen.has(current.parent)) {
    seen.add(current.parent);
    const parent = getPage(tree, current.parent);
    if (!parent) break;
    out.unshift(parent);
    current = parent;
  }
  return out;
}

export function isArchivedDeep(tree: Y.Doc, id: PageId): boolean {
  const page = getPage(tree, id);
  if (!page || page.deleted || page.archivedAt) return true;
  return ancestorsOf(tree, id).some((p) => p.deleted || p.archivedAt > 0);
}

export type NewPage = { id?: PageId; parent: PageId | ""; kind: PageKind; title?: string; icon?: string; after?: PageId | null; order?: string; props?: Record<string, unknown>; by: string; now?: number };

export function createPage(tree: Y.Doc, input: NewPage): PageId {
  const id = input.id ?? newId();
  const now = input.now ?? Date.now();
  tree.transact(() => {
    let order: string;
    const siblings = input.order === undefined ? childrenOf(tree, input.parent) : [];
    if (input.order !== undefined) order = input.order;
    else if (input.after === undefined) order = orderBetween(siblings.at(-1)?.order ?? null, null);
    else if (input.after === null) order = orderBetween(null, siblings[0]?.order ?? null);
    else {
      const index = siblings.findIndex((s) => s.id === input.after);
      order = orderBetween(siblings[index]?.order ?? null, siblings[index + 1]?.order ?? null);
    }
    const entry = new Y.Map<unknown>();
    const props = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(input.props ?? {})) props.set(k, v);
    entry.set("title", input.title ?? "");
    entry.set("icon", input.icon ?? "");
    entry.set("cover", "");
    entry.set("parent", input.parent);
    entry.set("order", order);
    entry.set("kind", input.kind);
    entry.set("createdAt", now);
    entry.set("createdBy", input.by);
    entry.set("updatedAt", now);
    entry.set("updatedBy", input.by);
    entry.set("archivedAt", 0);
    entry.set("props", props);
    pagesOf(tree).set(id, entry);
  });
  return id;
}

export type PagePatch = Partial<Omit<PageMeta, "id" | "props" | "createdAt" | "createdBy">>;

export function updatePage(tree: Y.Doc, id: PageId, patch: PagePatch, by: string, now = Date.now()) {
  const entry = pagesOf(tree).get(id);
  if (!entry) return;
  tree.transact(() => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) entry.set(k, v);
    entry.set("updatedAt", now);
    entry.set("updatedBy", by);
  });
}

export function setProp(tree: Y.Doc, id: PageId, prop: string, value: unknown, by: string, now = Date.now()) {
  const entry = pagesOf(tree).get(id);
  if (!entry) return;
  tree.transact(() => {
    let props = entry.get("props");
    if (!(props instanceof Y.Map)) {
      props = new Y.Map<unknown>();
      entry.set("props", props);
    }
    if (value === undefined || value === null) (props as Y.Map<unknown>).delete(prop);
    else (props as Y.Map<unknown>).set(prop, value);
    entry.set("updatedAt", now);
    entry.set("updatedBy", by);
  });
}

export function movePage(tree: Y.Doc, id: PageId, parent: PageId | "", after: PageId | null | undefined, by: string) {
  if (id === parent || ancestorsOf(tree, parent).some((p) => p.id === id)) return false;
  const siblings = childrenOf(tree, parent).filter((p) => p.id !== id);
  let order: string;
  if (after === undefined) order = orderBetween(siblings.at(-1)?.order ?? null, null);
  else if (after === null) order = orderBetween(null, siblings[0]?.order ?? null);
  else {
    const index = siblings.findIndex((s) => s.id === after);
    order = orderBetween(siblings[index]?.order ?? null, siblings[index + 1]?.order ?? null);
  }
  updatePage(tree, id, { parent, order }, by);
  return true;
}

export function archivePage(tree: Y.Doc, id: PageId, by: string, now = Date.now()) {
  updatePage(tree, id, { archivedAt: now }, by, now);
}

export function restorePage(tree: Y.Doc, id: PageId, by: string) {
  const page = getPage(tree, id);
  if (!page) return;
  const parentGone = page.parent && isArchivedDeep(tree, page.parent);
  updatePage(tree, id, parentGone ? { archivedAt: 0, parent: "" } : { archivedAt: 0 }, by);
}

export function deletePage(tree: Y.Doc, id: PageId, by: string) {
  const doomed = [id];
  const seen = new Set(doomed);
  const children = new Map<string, string[]>();
  for (const p of allPages(tree)) (children.get(p.parent) ?? children.set(p.parent, []).get(p.parent)!).push(p.id);
  for (let i = 0; i < doomed.length; i++)
    for (const child of children.get(doomed[i]!) ?? [])
      if (!seen.has(child)) {
        seen.add(child);
        doomed.push(child);
      }
  tree.transact(() => {
    for (const page of doomed) updatePage(tree, page, { deleted: true, title: "", icon: "", cover: "" }, by);
  });
  return doomed;
}

export function slug(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return cleaned || "Untitled";
}

export const pagePath = (page: Pick<PageMeta, "id" | "title">) => `/${slug(page.title)}-${page.id}`;

export function pageIdFromPath(path: string): PageId | null {
  const first = path.split(/[?#]/)[0]!.split("/").filter(Boolean)[0] ?? "";
  const m = /(?:^|-)([0-9a-f]{12})$/.exec(first);
  return m ? m[1]! : null;
}

export function displayTitle(page: Pick<PageMeta, "title" | "kind"> | null): string {
  if (!page) return "Untitled";
  return page.title.trim() || "Untitled";
}

export function plainText(fragment: Y.XmlFragment): string {
  const out: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment | Y.XmlHook) => {
    if (node instanceof Y.XmlText) {
      out.push(node.toString().replace(/<[^>]+>/g, ""));
      return;
    }
    if (node instanceof Y.XmlElement) {
      const block = node.nodeName === "blockContainer" || node.nodeName === "paragraph" || node.nodeName === "heading";
      for (const child of node.toArray()) walk(child as Y.XmlElement);
      if (block) out.push("\n");
      return;
    }
    if (node instanceof Y.XmlFragment) for (const child of node.toArray()) walk(child as Y.XmlElement);
  };
  walk(fragment);
  return out.join("").replace(/\n{2,}/g, "\n").trim();
}
