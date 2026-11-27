import type * as Y from "yjs";
import { allPages, ancestorsOf, blocksOf, displayTitle, getPage, isArchivedDeep, isShareLink, pageIdFromPath, pagePath, updatePage, type PageMeta } from "../../shared/model";
import type { NotesAccess } from "./access";
import { readDoc, type Block } from "./blocks";
import { blocksToMarkdown } from "./markdown";
import { ToolError, closest, quoteList } from "./spec";

export type Found = { ws: string; tree: Y.Doc; meta: PageMeta };

const PAGE_ID = /^[0-9a-f]{12}$/;

export const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);

export class Session {
  constructor(readonly a: NotesAccess) {}

  workspaceIds(): string[] {
    return this.a.workspaces().map((w) => w.id);
  }

  async workspace(id?: unknown): Promise<string> {
    const list = this.a.workspaces();
    if (id === undefined || id === null || id === "") {
      const first = list.find((w) => w.state === "ready") ?? list[0];
      if (!first) throw new ToolError("There's no workspace yet; make one with workspaces create {name}.");
      return first.id;
    }
    if (typeof id !== "string") throw new ToolError("workspace must be a workspace id or name.");
    const exact = list.find((w) => w.id === id) ?? list.find((w) => w.name.toLowerCase() === id.toLowerCase());
    if (exact) return exact.id;
    const near = closest(id, list.map((w) => w.name));
    throw new ToolError(`There's no workspace '${id.slice(0, 60)}'${near ? `; did you mean '${near}'?` : ""}. Workspaces: ${quoteList(list.map((w) => `${w.name} (${w.id})`))}.`);
  }

  async page(ref: unknown, options: { workspace?: unknown; field?: string; archived?: boolean; kind?: "page" | "database" } = {}): Promise<Found> {
    const field = options.field ?? "page";
    if (typeof ref !== "string" || !ref.trim()) throw new ToolError(`${field} is required: a page id, an ardia://notes/… address or a page title.`);
    const wanted = ref.trim();
    const pool = options.workspace !== undefined ? [await this.workspace(options.workspace)] : this.workspaceIds();
    const id = PAGE_ID.test(wanted) ? wanted : wanted.includes("/") || wanted.includes("-") ? pageIdFromPath(wanted.replace(/^ardia:\/\/notes/, "")) : null;
    const check = (found: Found) => {
      if (options.kind && found.meta.kind !== options.kind) throw new ToolError(`${field} '${displayTitle(found.meta)}' (${found.meta.id}) is a ${found.meta.kind}, not a ${options.kind}.`);
      if (!options.archived && isArchivedDeep(found.tree, found.meta.id)) throw new ToolError(`${field} '${displayTitle(found.meta)}' (${found.meta.id}) is in the trash; restore it with trash restore {page: "${found.meta.id}"} first.`);
      return found;
    };
    if (id) {
      for (const ws of pool) {
        const tree = await this.a.tree(ws);
        const meta = getPage(tree, id);
        if (meta && isShareLink(meta) && this.a.workspaces().some((w) => w.id === meta.sharedIn)) {
          const shareTree = await this.a.tree(meta.sharedIn);
          const shared = getPage(shareTree, id);
          if (shared && !shared.deleted) return check({ ws: meta.sharedIn, tree: shareTree, meta: shared });
          continue;
        }
        if (meta && !meta.deleted) return check({ ws, tree, meta });
      }
      throw new ToolError(`There's no page ${id}${pool.length === 1 ? " in that workspace" : ""}. Find pages with pages list or search {query}.`);
    }
    const matches: Found[] = [];
    const titles: string[] = [];
    const lower = wanted.toLowerCase();
    for (const ws of pool) {
      const tree = await this.a.tree(ws);
      for (const meta of allPages(tree)) {
        if (meta.deleted || isShareLink(meta) || (!options.archived && isArchivedDeep(tree, meta.id))) continue;
        if (options.kind && meta.kind !== options.kind) continue;
        const title = displayTitle(meta);
        titles.push(title);
        if (title.toLowerCase() === lower) matches.push({ ws, tree, meta });
      }
    }
    if (matches.length === 1) return check(matches[0]!);
    if (matches.length > 1) throw new ToolError(`${matches.length} pages are called '${wanted.slice(0, 60)}': ${matches.slice(0, 10).map((m) => `${m.meta.id} (in ${this.trail(m)})`).join(", ")}. Pass the id.`);
    const near = closest(wanted, titles);
    throw new ToolError(`There's no ${options.kind ?? "page"} called '${wanted.slice(0, 60)}'${near ? `; did you mean '${near}'?` : ""}. Pass a page id, or find it with search {query}.`);
  }

  trail(found: Found): string {
    const crumbs = ancestorsOf(found.tree, found.meta.id).map((p) => displayTitle(p));
    return crumbs.length ? crumbs.join(" / ") : this.wsName(found.ws);
  }

  wsName(ws: string) {
    return this.a.workspaces().find((w) => w.id === ws)?.name ?? ws;
  }

  pageJson(found: Found, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const m = found.meta;
    return {
      id: m.id,
      workspace: found.ws,
      title: m.title,
      icon: m.icon,
      kind: m.kind,
      parent: m.parent,
      path: ancestorsOf(found.tree, m.id).map((p) => ({ id: p.id, title: displayTitle(p) })),
      address: `ardia://notes${pagePath(m)}`,
      cover: m.cover,
      coverY: m.coverY,
      font: m.font,
      fullWidth: m.fullWidth,
      smallText: m.smallText,
      locked: m.locked,
      isTemplate: m.isTemplate,
      archived: isArchivedDeep(found.tree, m.id),
      createdAt: iso(m.createdAt),
      updatedAt: iso(m.updatedAt),
      createdBy: this.person(m.createdBy),
      updatedBy: this.person(m.updatedBy),
      ...extra,
    };
  }

  person(device: string) {
    if (!device) return "";
    return device === this.a.deviceId() ? this.a.me().name : device;
  }

  async refreshed(found: Found): Promise<Found> {
    const tree = await this.a.tree(found.ws);
    const meta = getPage(tree, found.meta.id);
    if (!meta) throw new ToolError(`Page ${found.meta.id} went away.`);
    return { ws: found.ws, tree, meta };
  }

  async blocks(found: Found): Promise<Block[]> {
    const doc = await this.a.doc(found.ws, found.meta.id);
    return readDoc(blocksOf(doc));
  }

  pageOf(tree: Y.Doc) {
    return (id: string) => {
      const meta = getPage(tree, id);
      return meta && !meta.deleted ? { title: displayTitle(meta) } : null;
    };
  }

  async markdown(found: Found, options: { ids?: boolean; title?: boolean } = {}): Promise<string> {
    const body = blocksToMarkdown(await this.blocks(found), { ids: options.ids, pageOf: this.pageOf(found.tree) });
    if (options.title === false) return body;
    const icon = found.meta.icon && !found.meta.icon.startsWith("file:") ? `${found.meta.icon} ` : "";
    return `# ${icon}${displayTitle(found.meta)}\n\n${body}`;
  }

  touch(found: Found) {
    updatePage(found.tree, found.meta.id, {}, this.a.deviceId(), this.a.now());
  }

  async saved(ws: string, pages: string[], tree = true): Promise<boolean> {
    return this.a.flush(ws, [...(tree ? ["ws"] : []), ...pages.map((p) => `p-${p}`)]);
  }

  async editPage<T>(found: Found, task: (doc: Y.Doc) => T | Promise<T>, options: { force?: boolean; history?: boolean } = {}): Promise<{ value: T; saved: boolean }> {
    if (found.meta.locked && !options.force) throw new ToolError(`'${displayTitle(found.meta)}' is locked. Unlock it with pages update {page: "${found.meta.id}", locked: false}, or pass force: true.`);
    return this.a.edit([found.ws], async () => {
      const doc = await this.a.doc(found.ws, found.meta.id);
      if (options.history !== false) await this.a.beforeEdit(found.ws, found.meta.id, doc);
      const value = await task(doc);
      this.touch(found);
      const saved = await this.saved(found.ws, [found.meta.id]);
      return { value, saved };
    });
  }
}

export function page12(v: unknown, field: string): string {
  if (typeof v !== "string" || !PAGE_ID.test(v)) throw new ToolError(`${field} must be a 12-character hex page id.`);
  return v;
}
