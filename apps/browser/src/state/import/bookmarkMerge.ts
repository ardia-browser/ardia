import type { BookmarkNode as ImportedNode } from "../../platform/importModule";
import type { Bookmarks } from "../browser/types";
import { newBookmarkId } from "../bookmarks/bookmarks";
import { pageKey } from "../tabs/pageKeys";
import { pairFolders, type FolderEdge } from "./folderMatching";

type Nodes = Bookmarks["nodes"];

export type ImportedFolder = { source: string; engine: string; wrapper?: true; adopted?: true };
export type ImportedFolders = Record<string, ImportedFolder>;

export type BookmarkMerge = { links: number; folders: number; skipped: number; intoEarlier: boolean; made: ImportedFolders };

type Merging = {
  nodes: Nodes;
  before: Nodes;
  seen: ReadonlySet<string>;
  pages: Map<string, ReadonlySet<string>>;
  nested: (folderId: string) => Candidate | null;
  record: (folderId: string, kind?: FolderKind) => void;
  now: number;
  out: BookmarkMerge;
};

type FolderKind = { wrapper?: boolean; adopted?: boolean };
type Candidate = { id: string; earlier: boolean; needsEvidence: boolean };
type Place = { id: string; candidate: (folderId: string) => Candidate | null };

export const EDGE_WORK_BUDGET = 200_000;

export function countedPages(pagesOf: string[][], holders: ReadonlyMap<string, readonly number[]>): Set<string> {
  const uses = new Map<string, number>();
  for (const pages of pagesOf) for (const page of pages) if (holders.has(page)) uses.set(page, (uses.get(page) ?? 0) + 1);
  const byCost = [...uses].map(([page, n]) => ({ page, cost: n * holders.get(page)!.length })).sort((a, z) => a.cost - z.cost || (a.page < z.page ? -1 : 1));
  const counted = new Set<string>();
  let work = 0;
  for (const { page, cost } of byCost) {
    if (work + cost > EDGE_WORK_BUDGET) continue;
    work += cost;
    counted.add(page);
  }
  return counted;
}

const pagesIn = (nodes: ImportedNode[]): string[] =>
  nodes.flatMap((n) => (n.type === "folder" ? pagesIn(n.children ?? []) : n.url ? [pageKey(n.url)] : []));

const linkCount = (nodes: ImportedNode[]): number => nodes.reduce((n, c) => n + (c.type === "url" ? 1 : linkCount(c.children ?? [])), 0);

type PageIndex = Pick<Merging, "before" | "pages">;

function pagesUnder(m: PageIndex, id: string): ReadonlySet<string> {
  const known = m.pages.get(id);
  if (known) return known;
  const node = m.before[id];
  const out = new Set<string>();
  m.pages.set(id, out);
  if (node?.kind === "url") out.add(pageKey(node.url));
  else if (node) for (const child of node.children) for (const page of pagesUnder(m, child)) out.add(page);
  return out;
}

export function bookmarkedPages(nodes: Nodes, folderIds: string[]): Set<string> {
  const index: PageIndex = { before: nodes, pages: new Map() };
  return new Set(folderIds.flatMap((id) => [...pagesUnder(index, id)]));
}

function childFolders(m: Merging, place: Place): Candidate[] {
  const parent = m.before[place.id];
  if (parent?.kind !== "folder") return [];
  const out: Candidate[] = [];
  for (const id of parent.children) {
    const c = m.before[id]?.kind === "folder" ? place.candidate(id) : null;
    if (c) out.push(c);
  }
  return out;
}

function unseen(m: Merging, nodes: ImportedNode[]): ImportedNode[] {
  return nodes.flatMap((n): ImportedNode[] => {
    if (n.type === "url") return n.url && m.seen.has(pageKey(n.url)) ? [] : [n];
    const children = unseen(m, n.children ?? []);
    return children.length || !n.children?.length ? [{ ...n, children }] : [];
  });
}

function build(m: Merging, n: ImportedNode, parentId: string): string {
  const id = newBookmarkId();
  const addedAt = n.dateAdded ?? m.now;
  if (n.type === "url") {
    m.nodes[id] = { kind: "url", id, parentId, title: n.title ?? n.url ?? "", url: n.url ?? "", favicon: null, addedAt };
    m.out.links += 1;
  } else {
    m.nodes[id] = { kind: "folder", id, parentId, title: n.title, children: (n.children ?? []).map((c) => build(m, c, id)), addedAt };
    m.out.folders += 1;
    m.record(id);
  }
  return id;
}

function append(m: Merging, parentId: string, nodes: ImportedNode[], earlier: boolean): string[] {
  const parent = m.nodes[parentId];
  if (!nodes.length || parent?.kind !== "folder") return [];
  const ids = nodes.map((n) => build(m, n, parentId));
  m.nodes[parentId] = { ...parent, children: [...parent.children, ...ids] };
  if (earlier) m.out.intoEarlier = true;
  return ids;
}

function matchFolders(m: Merging, folders: ImportedNode[], places: Place[]): Map<ImportedNode, Candidate> {
  const byTitle = new Map<string, { sources: ImportedNode[]; candidates: Candidate[] }>();
  const group = (title: string) => {
    let g = byTitle.get(title);
    if (!g) byTitle.set(title, (g = { sources: [], candidates: [] }));
    return g;
  };
  for (const source of folders) group(source.title).sources.push(source);
  for (const place of places) for (const c of childFolders(m, place)) byTitle.get(m.before[c.id]?.title ?? "")?.candidates.push(c);
  const matched = new Map<ImportedNode, Candidate>();
  for (const { sources, candidates } of byTitle.values()) {
    if (!candidates.length) continue;
    const holders = new Map<string, number[]>();
    candidates.forEach((c, i) => {
      for (const page of pagesUnder(m, c.id)) {
        const list = holders.get(page);
        if (list) list.push(i);
        else holders.set(page, [i]);
      }
    });
    const pagesOf = sources.map((source) => [...new Set(pagesIn(source.children ?? []))]);
    const counted = countedPages(pagesOf, holders);
    const edges: FolderEdge[] = [];
    pagesOf.forEach((pages, s) => {
      const shared = new Map<number, number>();
      for (const page of pages) {
        if (!counted.has(page)) continue;
        for (const c of holders.get(page) ?? []) shared.set(c, (shared.get(c) ?? 0) + 1);
      }
      for (const [candidate, count] of shared) {
        const c = candidates[candidate]!;
        if (c.needsEvidence && count * 2 <= pagesUnder(m, c.id).size) continue;
        edges.push({ source: s, candidate, shared: count });
      }
    });
    const positional = candidates.map((c) => !c.needsEvidence);
    pairFolders(sources.length, candidates.length, edges, positional).forEach((c, s) => {
      if (c < 0) return;
      const candidate = candidates[c]!;
      matched.set(sources[s]!, candidate);
    });
  }
  return matched;
}

function mergeLevel(m: Merging, nodes: ImportedNode[], places: Place[]): ImportedNode[] {
  const matched = matchFolders(m, nodes.filter((n) => n.type === "folder"), places);
  const fresh: ImportedNode[] = [];
  for (const n of nodes) {
    const folder = matched.get(n);
    if (!folder) {
      fresh.push(...unseen(m, [n]));
      continue;
    }
    const before = m.out.links + m.out.folders;
    const inner = mergeLevel(m, n.children ?? [], [{ id: folder.id, candidate: m.nested }]);
    append(m, folder.id, inner, folder.earlier);
    if (folder.needsEvidence && m.out.links + m.out.folders > before) m.record(folder.id, { adopted: true });
  }
  return fresh;
}

export function mergeImportedBookmarks(
  nodes: Nodes,
  seen: ReadonlySet<string>,
  placements: { rootId: string; nodes: ImportedNode[] }[],
  from: { source: string; engine: string; made: ImportedFolders },
): BookmarkMerge {
  const recorded = (id: string) => from.made[id];
  const ownFolder = (id: string): Candidate | null => {
    const f = recorded(id);
    return f && f.source === from.source && !f.wrapper ? { id, earlier: !f.adopted, needsEvidence: false } : null;
  };
  const nested = (id: string): Candidate | null => (recorded(id) ? ownFolder(id) : { id, earlier: false, needsEvidence: false });
  const atRoot = (id: string): Candidate | null => (recorded(id) ? ownFolder(id) : { id, earlier: false, needsEvidence: true });
  const out: BookmarkMerge = { links: 0, folders: 0, skipped: 0, intoEarlier: false, made: {} };
  const record = (id: string, kind: FolderKind = {}) => {
    out.made[id] = { source: from.source, engine: from.engine, ...(kind.wrapper ? { wrapper: true as const } : {}), ...(kind.adopted ? { adopted: true as const } : {}) };
  };
  const m: Merging = { nodes, before: { ...nodes }, seen, pages: new Map(), nested, record, now: Date.now(), out };
  const wrapperTitle = `Imported from ${from.source}`;
  for (const { rootId, nodes: incoming } of placements) {
    const root = m.before[rootId];
    if (!incoming.length || root?.kind !== "folder") continue;
    if (!root.children.length) {
      append(m, rootId, unseen(m, incoming), false);
      continue;
    }
    const folders = root.children.filter((id) => m.before[id]?.kind === "folder");
    const ownWrapper = folders.find((id) => recorded(id)?.source === from.source && recorded(id)!.wrapper);
    const adopted = ownWrapper ? undefined : folders.find((id) => !recorded(id) && m.before[id]!.title === wrapperTitle);
    const wrapper = ownWrapper ?? adopted;
    if (adopted) record(adopted, { wrapper: true, adopted: true });
    const madeByImport = !!ownWrapper && !recorded(ownWrapper)!.adopted;
    const places: Place[] = [
      ...(wrapper ? [{ id: wrapper, candidate: nested }] : []),
      { id: rootId, candidate: (id: string) => (id === wrapper ? null : atRoot(id)) },
    ];
    const fresh = mergeLevel(m, incoming, places);
    if (!fresh.length) continue;
    if (wrapper) append(m, wrapper, fresh, madeByImport);
    else for (const id of append(m, rootId, [{ type: "folder", title: wrapperTitle, children: fresh }], false)) record(id, { wrapper: true });
  }
  m.out.skipped = placements.reduce((n, p) => n + linkCount(p.nodes), 0) - m.out.links;
  return m.out;
}
