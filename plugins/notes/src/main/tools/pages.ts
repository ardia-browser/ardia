import * as Y from "yjs";
import { fromBase64 } from "../../shared/bytes";
import { allPages, blocksOf, childrenOf, commentsOf, displayTitle, getPage, isArchivedDeep, pagePath, updatePage, type PageMeta } from "../../shared/model";
import { createRow, databaseRows, initDatabase, readSettings, updateSettings } from "../../shared/database";
import { databaseTools } from "./database";
import { buildBlock, blockText, cleanBlock, cleanBlocks, readDoc, walkBlocks, writeDoc, type Block, type Inline, type StyledText, type TableContent } from "./blocks";
import { blockIndex, contentNodeOf, ensureRoot } from "./editing";
import { blocksToMarkdown, markdownToBlocks, titleFromMarkdown } from "./markdown";
import { Session, iso, type Found } from "./common";
import { ToolError, quoteList, suggest } from "./spec";

const by = (s: Session) => s.a.deviceId();

const PAGE_FIELDS = ["title", "icon", "cover", "coverY", "font", "fullWidth", "smallText", "locked", "isTemplate"] as const;

function checkIcon(v: unknown, field: string) {
  if (typeof v !== "string") throw new ToolError(`${field} must be an emoji, file:<sha256>, or "" for none.`);
  if (v && !/^file:[0-9a-f]{64}$/.test(v) && (v.length > 16 || /[A-Za-z0-9]{3,}/.test(v))) throw new ToolError(`${field} must be one emoji (or file:<sha256> from files upload), not '${v.slice(0, 20)}'.`);
  return v;
}

function checkCover(v: unknown, field: string) {
  if (typeof v !== "string") throw new ToolError(`${field} must be "", gradient:<0-11>, color:<0-9> or file:<sha256>.`);
  if (v && !/^(gradient:([0-9]|1[01])|color:[0-9]|file:[0-9a-f]{64})$/.test(v)) throw new ToolError(`${field} must be "", gradient:0 to gradient:11, color:0 to color:9, or file:<sha256> from files upload.`);
  return v;
}

function pagePatch(args: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of PAGE_FIELDS) if (args[k] !== undefined) patch[k] = args[k];
  if (patch.icon !== undefined) checkIcon(patch.icon, "icon");
  if (patch.cover !== undefined) checkCover(patch.cover, "cover");
  if (typeof patch.title === "string") patch.title = patch.title.slice(0, 2000);
  return patch;
}

function tree(s: Session, ws: string, tr: Y.Doc, root: string, depth: number, limit: { n: number }, archived: boolean): Record<string, unknown>[] {
  if (depth <= 0) return [];
  return childrenOf(tr, root, { archived }).flatMap((p) => {
    if (limit.n-- <= 0) return [];
    const isDb = p.kind === "database";
    return [{ id: p.id, title: displayTitle(p), icon: p.icon, kind: p.kind, ...(p.isTemplate ? { isTemplate: true } : {}), ...(p.archivedAt ? { archived: true } : {}), ...(isDb ? { rows: databaseRows(tr, p.id).length } : { children: tree(s, ws, tr, p.id, depth - 1, limit, archived) }) }];
  });
}

function bodyOf(args: Record<string, unknown>, field: string): Block[] | null {
  if (args.markdown !== undefined && args.blocks !== undefined) throw new ToolError(`${field}: give markdown or blocks, not both.`);
  if (args.markdown !== undefined) return markdownToBlocks(String(args.markdown), `${field}.markdown`);
  if (args.blocks !== undefined) return cleanBlocks(args.blocks, `${field}.blocks`);
  return null;
}

export function pageTools(s: Session) {
  const pages = {
    list: async (args: Record<string, unknown>) => {
      const ws = args.parent ? (await s.page(args.parent, { field: "parent", workspace: args.workspace })).ws : await s.workspace(args.workspace);
      const tr = await s.a.tree(ws);
      const parent = args.parent ? (await s.page(args.parent, { field: "parent", workspace: ws })).meta.id : undefined;
      let list = allPages(tr).filter((p) => !p.deleted);
      if (parent !== undefined) list = list.filter((p) => p.parent === parent);
      if (args.archived !== true) list = list.filter((p) => !isArchivedDeep(tr, p.id));
      if (args.kind) list = list.filter((p) => p.kind === args.kind);
      if (args.templates === true) list = list.filter((p) => p.isTemplate);
      else if (args.templates === false) list = list.filter((p) => !p.isTemplate);
      if (args.rows === false) list = list.filter((p) => !(p.parent && getPage(tr, p.parent)?.kind === "database"));
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      const offset = Number(args.cursor ?? 0);
      if (!Number.isInteger(offset) || offset < 0) throw new ToolError("pages list.cursor must be the nextCursor of an earlier call.");
      const limit = (args.limit as number) ?? 100;
      return { workspace: ws, total: list.length, pages: list.slice(offset, offset + limit).map((meta) => s.pageJson({ ws, tree: tr, meta })), nextCursor: offset + limit < list.length ? String(offset + limit) : null };
    },
    tree: async (args: Record<string, unknown>) => {
      const root = args.root ? await s.page(args.root, { field: "root", workspace: args.workspace }) : null;
      const ws = root?.ws ?? (await s.workspace(args.workspace));
      const tr = await s.a.tree(ws);
      return { workspace: ws, name: s.wsName(ws), root: root?.meta.id ?? "", pages: tree(s, ws, tr, root?.meta.id ?? "", (args.depth as number) ?? 10, { n: (args.limit as number) ?? 2000 }, args.archived === true) };
    },
    get: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const extra: Record<string, unknown> = {};
      const content = args.content ?? "markdown";
      if (content === "markdown") extra.markdown = await s.markdown(found, { title: false, ids: args.ids === true });
      else if (content === "blocks") extra.blocks = await s.blocks(found);
      if (found.meta.kind === "database") {
        const doc = await s.a.doc(found.ws, found.meta.id);
        const settings = readSettings(doc);
        extra.database = { source: settings.source || found.meta.id, rows: databaseRows(found.tree, settings.source || found.meta.id).length, hint: "database get for its properties and views; rows query for rows" };
      }
      const parent = found.meta.parent ? getPage(found.tree, found.meta.parent) : null;
      if (parent?.kind === "database") extra.row = { database: parent.id, hint: "rows get for its properties" };
      extra.children = childrenOf(found.tree, found.meta.id).filter((p) => parent?.kind !== "database").slice(0, 200).map((p) => ({ id: p.id, title: displayTitle(p), kind: p.kind }));
      return { page: s.pageJson(found, extra) };
    },
    create: async (args: Record<string, unknown>) => {
      const parent = args.parent ? await s.page(args.parent, { field: "parent", workspace: args.workspace }) : null;
      const ws = parent?.ws ?? (await s.workspace(args.workspace));
      let body = bodyOf(args, "pages create");
      let title = args.title as string | undefined;
      let icon = args.icon as string | undefined;
      if (body && args.markdown !== undefined && title === undefined) {
        const t = titleFromMarkdown(body);
        if (t) {
          title = t.title;
          if (icon === undefined && t.icon) icon = t.icon;
          body = body.slice(1);
        }
      }
      const template = args.template ? await s.page(args.template, { field: "template", workspace: ws }) : null;
      if (template && body) throw new ToolError("pages create: give a template or content, not both.");
      if (icon !== undefined) checkIcon(icon, "icon");
      const after = args.after ? (await s.page(args.after, { field: "after", workspace: ws })).meta.id : undefined;
      if (parent?.meta.kind === "database") throw new ToolError(`pages create: '${displayTitle(parent.meta)}' is a database; add rows with rows create {database: "${parent.meta.id}", rows: [...]}.`);
      return s.a.edit([ws], async () => {
        const kind = args.kind === "database" ? "database" : "page";
        const { page } = (await s.a.run("createPage", { workspace: ws, parent: parent?.meta.id ?? "", kind, ...(title !== undefined ? { title } : {}), ...(icon !== undefined ? { icon } : {}), ...(after ? { after } : {}), ...(template ? { template: template.meta.id } : {}) })) as { page: string };
        const tr = await s.a.tree(ws);
        const patch = pagePatch({ ...args, title: undefined });
        if (template) patch.isTemplate = args.isTemplate === true;
        if (Object.keys(patch).length) updatePage(tr, page, patch, by(s));
        const doc = await s.a.doc(ws, page);
        if (kind === "database") initDatabase(doc, {});
        else if (body) {
          const content = body;
          doc.transact(() => writeDoc(blocksOf(doc), content));
        }
        if (parent && args.addBlock !== false && parent.meta.kind === "page" && kind === "page") {
          const pdoc = await s.a.doc(ws, parent.meta.id);
          await s.a.beforeEdit(ws, parent.meta.id, pdoc);
          pdoc.transact(() => ensureRoot(blocksOf(pdoc)).push([buildBlock(cleanBlock({ type: "subpage", props: { pageId: page } }, "block"))]));
        }
        const saved = await s.saved(ws, [page, ...(parent ? [parent.meta.id] : [])]);
        const found = await s.page(page, { workspace: ws, archived: true });
        return { page: s.pageJson(found), saved };
      });
    },
    update: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const patch = pagePatch(args);
      if (!Object.keys(patch).length) throw new ToolError(`pages update needs something to change: ${quoteList(PAGE_FIELDS)}.`);
      return s.a.edit([found.ws], async () => {
        updatePage(found.tree, found.meta.id, patch, by(s), s.a.now());
        const saved = await s.saved(found.ws, []);
        return { page: s.pageJson(await s.refreshed(found)), saved };
      });
    },
    move: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace });
      const toWs = args.toWorkspace !== undefined ? await s.workspace(args.toWorkspace) : found.ws;
      if (args.parent === undefined) throw new ToolError('pages move needs parent: a page id, or "" for the top of the workspace.');
      const parent = args.parent === "" ? null : await s.page(args.parent, { field: "parent", workspace: toWs });
      if (parent?.meta.kind === "database" && found.meta.kind !== "page") throw new ToolError("pages move: only pages can become database rows.");
      let after: string | null | undefined;
      if (args.after === null) after = null;
      else if (args.after !== undefined) after = (await s.page(args.after, { field: "after", workspace: toWs })).meta.id;
      const result = (await s.a.run("movePage", { workspace: found.ws, page: found.meta.id, parent: parent?.meta.id ?? "", ...(after !== undefined ? { after } : {}), ...(toWs !== found.ws ? { toWorkspace: toWs } : {}) })) as { page: string; workspace: string };
      const saved = await s.saved(result.workspace, []);
      return { page: s.pageJson(await s.page(result.page, { workspace: result.workspace })), saved };
    },
    duplicate: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace });
      const { page } = (await s.a.run("duplicatePage", { workspace: found.ws, page: found.meta.id })) as { page: string };
      const saved = await s.saved(found.ws, [page]);
      return { page: s.pageJson(await s.page(page, { workspace: found.ws })), saved };
    },
    archive: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace });
      await s.a.run("archivePage", { workspace: found.ws, page: found.meta.id });
      return { trashed: { id: found.meta.id, title: displayTitle(found.meta) }, saved: await s.saved(found.ws, []), hint: "trash restore brings it back" };
    },
    restore: async (args: Record<string, unknown>) => trash.restore(args),
    delete: async (args: Record<string, unknown>) => trash.delete(args),
    open: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const extra = args.view ? `?v=${encodeURIComponent(String(args.view))}` : args.peek ? `?p=${String(args.peek)}` : "";
      const path = `${pagePath(found.meta)}${extra}`;
      await s.a.openPath(path);
      return { opened: `ardia://notes${path}` };
    },
    backlinks: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      s.a.reindex();
      const list = (await s.a.run("backlinks", { workspace: found.ws, page: found.meta.id })) as { page: string; title: string; icon: string }[];
      return { page: found.meta.id, backlinks: list };
    },
    resolve: async (args: Record<string, unknown>) => {
      const found = await s.page(args.address, { field: "address", archived: true });
      return { page: s.pageJson(found) };
    },
  };

  const trash = {
    list: async (args: Record<string, unknown>) => {
      const pool = args.workspace !== undefined ? [await s.workspace(args.workspace)] : s.workspaceIds();
      const out: Record<string, unknown>[] = [];
      for (const ws of pool) {
        const tr = await s.a.tree(ws);
        for (const p of allPages(tr)) if (!p.deleted && p.archivedAt) out.push({ id: p.id, workspace: ws, title: displayTitle(p), kind: p.kind, trashedAt: iso(p.archivedAt), parent: p.parent });
      }
      out.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
      return { trash: out };
    },
    restore: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      if (!found.meta.archivedAt) throw new ToolError(`'${displayTitle(found.meta)}' isn't in the trash${isArchivedDeep(found.tree, found.meta.id) ? "; a page above it is, so restore that one" : ""}.`);
      await s.a.run("restorePage", { workspace: found.ws, page: found.meta.id });
      return { page: s.pageJson(await s.refreshed(found)), saved: await s.saved(found.ws, []) };
    },
    delete: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      if (!isArchivedDeep(found.tree, found.meta.id) && args.permanent !== true) throw new ToolError(`'${displayTitle(found.meta)}' isn't in the trash. Move it there with pages archive (it can come back), or pass permanent: true to delete it for good now.`);
      await s.a.run("deletePage", { workspace: found.ws, page: found.meta.id });
      return { deleted: { id: found.meta.id, title: displayTitle(found.meta) } };
    },
    empty: async (args: Record<string, unknown>) => {
      if (args.confirm !== true) throw new ToolError("trash empty deletes every page in the trash for good; pass confirm: true.");
      const pool = args.workspace !== undefined ? [await s.workspace(args.workspace)] : s.workspaceIds();
      const deleted: string[] = [];
      for (const ws of pool) {
        const tr = await s.a.tree(ws);
        for (const p of allPages(tr)) {
          if (p.deleted || !p.archivedAt) continue;
          const fresh = getPage(tr, p.id);
          if (!fresh || fresh.deleted) continue;
          await s.a.run("deletePage", { workspace: ws, page: p.id });
          deleted.push(p.id);
        }
      }
      return { deleted };
    },
  };

  const templates = {
    list: async (args: Record<string, unknown>) => {
      if (args.database !== undefined) {
        const db = await s.page(args.database, { field: "database", kind: "database" });
        const doc = await s.a.doc(db.ws, db.meta.id);
        const source = readSettings(doc).source || db.meta.id;
        return { database: db.meta.id, defaultTemplate: readSettings(doc).defaultTemplate, templates: databaseRows(db.tree, source, { templates: true }).map((t) => ({ id: t.id, title: displayTitle(t), icon: t.icon })) };
      }
      const pool = args.workspace !== undefined ? [await s.workspace(args.workspace)] : s.workspaceIds();
      const out: Record<string, unknown>[] = [];
      for (const ws of pool) {
        const tr = await s.a.tree(ws);
        for (const p of allPages(tr)) {
          if (!p.isTemplate || isArchivedDeep(tr, p.id)) continue;
          const parent = p.parent ? getPage(tr, p.parent) : null;
          if (parent?.kind === "database") continue;
          out.push({ id: p.id, workspace: ws, title: displayTitle(p), icon: p.icon, kind: p.kind });
        }
      }
      return { templates: out };
    },
    create: async (args: Record<string, unknown>) => {
      if (args.database !== undefined) {
        const db = await s.page(args.database, { field: "database", kind: "database" });
        const doc = await s.a.doc(db.ws, db.meta.id);
        const source = readSettings(doc).source || db.meta.id;
        const body = bodyOf(args, "templates create");
        return s.a.edit([db.ws], async () => {
          const id = createRow(db.tree, source, [], { by: by(s), title: String(args.title ?? "New template"), isTemplate: true, now: s.a.now() });
          if (typeof args.icon === "string") updatePage(db.tree, id, { icon: checkIcon(args.icon, "icon") }, by(s));
          if (body) {
            const pdoc = await s.a.doc(db.ws, id);
            pdoc.transact(() => writeDoc(blocksOf(pdoc), body));
          }
          if (args.default === true) {
            updateSettings(doc, { defaultTemplate: id });
          }
          const saved = await s.saved(db.ws, [id, db.meta.id]);
          return { template: s.pageJson(await s.page(id, { workspace: db.ws, archived: true })), saved };
        });
      }
      if (args.from !== undefined) {
        const from = await s.page(args.from, { field: "from", workspace: args.workspace });
        const { page } = (await s.a.run("duplicatePage", { workspace: from.ws, page: from.meta.id })) as { page: string };
        const tr = await s.a.tree(from.ws);
        updatePage(tr, page, { isTemplate: true, ...(args.title !== undefined ? { title: String(args.title) } : { title: displayTitle(from.meta) }) }, by(s));
        return { template: s.pageJson(await s.page(page, { workspace: from.ws })), saved: await s.saved(from.ws, [page]) };
      }
      return pages.create({ ...args, isTemplate: true, title: args.title ?? "New template", addBlock: false });
    },
    apply: async (args: Record<string, unknown>) => {
      const tpl = await s.page(args.template, { field: "template", workspace: args.workspace });
      if (!tpl.meta.isTemplate) throw new ToolError(`'${displayTitle(tpl.meta)}' isn't a template; mark it with pages update {isTemplate: true}, or use pages duplicate.`);
      const parentOfTemplate = tpl.meta.parent ? getPage(tpl.tree, tpl.meta.parent) : null;
      if (parentOfTemplate?.kind === "database") {
        return databaseTools(s).rows.create({ database: parentOfTemplate.id, rows: [{ template: tpl.meta.id, ...(args.title !== undefined ? { title: args.title } : {}) }] });
      }
      if (args.target !== undefined) {
        const target = await s.page(args.target, { field: "target", workspace: tpl.ws });
        const blocks = await s.blocks(tpl);
        const fresh = blocks.map((b) => cleanBlock(stripIds(b), "template"));
        const { saved } = await s.editPage(target, (doc) => {
          doc.transact(() => {
            const root = ensureRoot(blocksOf(doc));
            const kids = root.toArray();
            const only = kids.length === 1 && kids[0] instanceof Y.XmlElement ? readDoc(blocksOf(doc)) : null;
            if (only && only.length === 1 && only[0]!.type === "paragraph" && !blockText(only[0]!)) root.delete(0, 1);
            root.insert(root.length, fresh.map(buildBlock));
          });
        });
        return { page: s.pageJson(await s.refreshed(target)), saved };
      }
      return pages.create({ workspace: tpl.ws, template: tpl.meta.id, ...(args.parent !== undefined ? { parent: args.parent } : {}), ...(args.title !== undefined ? { title: args.title } : {}) });
    },
  };

  const search = async (args: Record<string, unknown>) => {
    s.a.reindex();
    const ws = args.workspace !== undefined ? await s.workspace(args.workspace) : undefined;
    const hits = (await s.a.run("search", { query: String(args.query ?? ""), ...(ws ? { workspace: ws } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.titlesOnly !== undefined ? { titlesOnly: args.titlesOnly } : {}) })) as { workspace: string; page: string; title: string; icon: string; path: string[]; snippet: string; score: number; updatedAt: number }[];
    return { query: args.query, hits: hits.map((h) => ({ id: h.page, workspace: h.workspace, title: h.title, icon: h.icon, path: h.path, snippet: h.snippet, score: Math.round(h.score * 1000) / 1000, updatedAt: iso(h.updatedAt), address: `ardia://notes${pagePath({ id: h.page, title: h.title })}` })) };
  };

  const history = {
    list: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const list = (await s.a.run("history", { workspace: found.ws, page: found.meta.id })) as { id: string; at: number; by: string; size: number }[];
      return { page: found.meta.id, versions: list.map((v) => ({ id: v.id, at: iso(v.at), by: v.by, size: v.size })) };
    },
    get: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const { state } = (await s.a.run("versionState", { workspace: found.ws, page: found.meta.id, version: args.version })) as { state: string };
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, fromBase64(state));
      const blocks = readDoc(blocksOf(doc));
      doc.destroy();
      return { page: found.meta.id, version: args.version, ...(args.format === "blocks" ? { blocks } : { markdown: blocksToMarkdown(blocks, { pageOf: s.pageOf(found.tree) }) }) };
    },
    restore: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace });
      await s.a.run("restoreVersion", { workspace: found.ws, page: found.meta.id, version: args.version });
      return { page: found.meta.id, restored: args.version, saved: await s.saved(found.ws, [found.meta.id]), hint: "the version before the restore was saved too; history list shows it" };
    },
  };

  const files = {
    upload: async (args: Record<string, unknown>) => {
      const ws = args.page !== undefined ? (await s.page(args.page, { workspace: args.workspace })).ws : await s.workspace(args.workspace);
      const data = String(args.data ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new ToolError("files upload.data must be base64.");
      const bytes = fromBase64(data);
      if (!bytes.length) throw new ToolError("files upload.data is empty.");
      const ref = await s.a.putFile(ws, bytes, String(args.name), String(args.type ?? ""));
      return { ref, workspace: ws, size: bytes.length, name: args.name, hint: "use ref as an image/file block's url, a page icon or cover, or a files property value {ref, name, type}" };
    },
    get: async (args: Record<string, unknown>) => {
      const ws = await s.workspace(args.workspace);
      const out = (await s.a.run("file", { workspace: ws, ref: args.ref })) as { type: string; data: string };
      const size = Math.floor((out.data.length * 3) / 4);
      if (out.data.length > 900_000) throw new ToolError(`That file is ${size} bytes; the CLI carries at most about 650 KB. Open the page to see it.`);
      return { ref: args.ref, type: out.type, size, data: out.data };
    },
    list: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const refs = new Map<string, { ref: string; where: string; name?: string }>();
      const add = (ref: unknown, where: string, name?: string) => {
        if (typeof ref === "string" && /^file:[0-9a-f]{64}$/.test(ref) && !refs.has(ref)) refs.set(ref, { ref, where, ...(name ? { name } : {}) });
      };
      add(found.meta.icon, "icon");
      add(found.meta.cover, "cover");
      walkBlocks(await s.blocks(found), (b) => add(b.props.url, `${b.type} block ${b.id}`, typeof b.props.name === "string" ? b.props.name : undefined));
      for (const [k, v] of Object.entries(found.meta.props)) if (Array.isArray(v)) for (const f of v) if (f && typeof f === "object") add((f as Record<string, unknown>).ref, `property ${k}`, String((f as Record<string, unknown>).name ?? ""));
      return { page: found.meta.id, workspace: found.ws, files: [...refs.values()] };
    },
  };

  const exporter = async (args: Record<string, unknown>) => {
    const root = await s.page(args.page, { workspace: args.workspace, archived: true });
    const format = (args.format as string) ?? "markdown";
    const ids = args.subtree === true ? subtreeIds(root.tree, root.meta.id) : [root.meta.id];
    if (ids.length > 200) throw new ToolError(`That subtree has ${ids.length} pages; export at most 200 at a time.`);
    const out: { id: string; title: string; path: string; text: string }[] = [];
    let total = 0;
    for (const id of ids) {
      const found: Found = { ws: root.ws, tree: root.tree, meta: getPage(root.tree, id)! };
      const blocks = await s.blocks(found);
      const text = format === "html" ? htmlPage(found.meta, blocks, s.pageOf(root.tree)) : `# ${found.meta.icon && !found.meta.icon.startsWith("file:") ? `${found.meta.icon} ` : ""}${displayTitle(found.meta)}\n\n${blocksToMarkdown(blocks, { pageOf: s.pageOf(root.tree) })}`;
      total += text.length;
      if (total > 900_000) throw new ToolError("The export is over 900 KB; export fewer pages (subtree: false) or one page at a time.");
      out.push({ id, title: displayTitle(found.meta), path: exportPath(root.tree, root.meta.id, id, format), text });
    }
    return { format, files: out };
  };

  const comments = {
    list: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace, archived: true });
      const doc = await s.a.doc(found.ws, found.meta.id);
      const wanted = args.resolved === undefined ? false : args.resolved;
      const threads: Record<string, unknown>[] = [];
      const anchors = threadAnchors(blocksOf(doc));
      commentsOf(doc).forEach((t, id) => {
        if (!(t instanceof Y.Map)) return;
        const json = threadJson(s, t, id, anchors.get(id));
        if (!json) return;
        if (wanted !== "all" && json.resolved !== wanted) return;
        threads.push(json);
      });
      threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return { page: found.meta.id, threads };
    },
    add: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace });
      let threadId = "";
      const { saved } = await s.editPage(
        found,
        (doc) => {
          doc.transact(() => {
            const now = s.a.now();
            threadId = globalThis.crypto.randomUUID();
            const metadata: Record<string, unknown> = {};
            if (args.block !== undefined) {
              const index = blockIndex(blocksOf(doc));
              const el = index.get(String(args.block));
              if (!el) throw new ToolError(`comments add: there's no block '${String(args.block)}' on this page${suggest(String(args.block), index.keys())}`);
              const quote = anchorComment(el, threadId, args.quote as string | undefined);
              metadata.quote = quote;
            } else metadata.page = true;
            const thread = new Y.Map<unknown>();
            thread.set("id", threadId);
            thread.set("createdAt", now);
            thread.set("updatedAt", now);
            const list = new Y.Array<Y.Map<unknown>>();
            list.push([commentMap(s, String(args.text), now)]);
            thread.set("comments", list);
            thread.set("resolved", false);
            thread.set("metadata", metadata);
            commentsOf(doc).set(threadId, thread);
          });
        },
        { force: true, history: false },
      );
      const doc = await s.a.doc(found.ws, found.meta.id);
      return { thread: threadJson(s, commentsOf(doc).get(threadId) as Y.Map<unknown>, threadId, threadAnchors(blocksOf(doc)).get(threadId)), saved };
    },
    reply: async (args: Record<string, unknown>) => threadEdit(s, args, (t) => {
      (t.get("comments") as Y.Array<Y.Map<unknown>>).push([commentMap(s, String(args.text), s.a.now())]);
      t.set("updatedAt", s.a.now());
    }),
    edit: async (args: Record<string, unknown>) => threadEdit(s, args, (t) => {
      const list = t.get("comments") as Y.Array<Y.Map<unknown>>;
      const at = list.toArray().findIndex((c) => c.get("id") === args.comment);
      if (at < 0) throw new ToolError(`comments edit: thread has no comment '${String(args.comment)}'.`);
      const c = list.get(at);
      if (c.get("userId") !== s.a.deviceId()) throw new ToolError("comments edit: only comments made on this Mac can be edited.");
      c.set("body", commentBody(String(args.text)));
      c.set("updatedAt", s.a.now());
      t.set("updatedAt", s.a.now());
    }),
    resolve: async (args: Record<string, unknown>) => threadEdit(s, args, (t) => {
      t.set("resolved", true);
      t.set("resolvedUpdatedAt", s.a.now());
      t.set("resolvedBy", s.a.deviceId());
    }),
    unresolve: async (args: Record<string, unknown>) => threadEdit(s, args, (t) => {
      t.set("resolved", false);
      t.set("resolvedUpdatedAt", s.a.now());
    }),
    delete: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { workspace: args.workspace });
      const { saved } = await s.editPage(
        found,
        (doc) => {
          const map = commentsOf(doc);
          const t = map.get(String(args.thread));
          if (!(t instanceof Y.Map)) throw new ToolError(`comments delete: there's no thread '${String(args.thread)}' on this page.`);
          doc.transact(() => {
            if (args.comment === undefined) map.delete(String(args.thread));
            else {
              const list = t.get("comments") as Y.Array<Y.Map<unknown>>;
              const at = list.toArray().findIndex((c) => c.get("id") === args.comment);
              if (at < 0) throw new ToolError(`comments delete: thread has no comment '${String(args.comment)}'.`);
              list.delete(at, 1);
              if (list.length === 0) map.delete(String(args.thread));
              else t.set("updatedAt", s.a.now());
            }
          });
        },
        { force: true, history: false },
      );
      return { deleted: { thread: args.thread, ...(args.comment !== undefined ? { comment: args.comment } : {}) }, saved };
    },
  };

  return { pages, trash, templates, search, history, files, export: exporter, comments };
}

function stripIds(b: Block): unknown {
  const { id: _id, children, ...rest } = b;
  return { ...rest, children: children.map(stripIds) };
}

function subtreeIds(tr: Y.Doc, root: string): string[] {
  const ids = [root];
  for (let i = 0; i < ids.length; i++) for (const c of childrenOf(tr, ids[i]!)) if (!ids.includes(c.id)) ids.push(c.id);
  return ids;
}

function exportPath(tr: Y.Doc, root: string, id: string, format: string) {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = getPage(tr, id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(displayTitle(cur).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 80));
    if (cur.id === root) break;
    cur = cur.parent ? getPage(tr, cur.parent) : null;
  }
  return `${parts.join("/")}.${format === "html" ? "html" : "md"}`;
}

const esc = (t: string) => t.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

function inlineHtml(list: Inline[], pageOf: (id: string) => { title: string } | null): string {
  const styled = (t: StyledText) => {
    let h = esc(t.text).replace(/\n/g, "<br>");
    const st = t.styles;
    if (st.code) h = `<code>${h}</code>`;
    if (st.bold) h = `<strong>${h}</strong>`;
    if (st.italic) h = `<em>${h}</em>`;
    if (st.underline) h = `<u>${h}</u>`;
    if (st.strike) h = `<s>${h}</s>`;
    if (st.textColor || st.backgroundColor) h = `<span data-color="${st.textColor ?? ""}" data-bg="${st.backgroundColor ?? ""}">${h}</span>`;
    return h;
  };
  return list
    .map((i) => {
      if (i.type === "text") return styled(i);
      if (i.type === "link") return /^(https?:|mailto:|ardia:)/i.test(i.href) ? `<a href="${esc(i.href)}">${i.content.map(styled).join("")}</a>` : i.content.map(styled).join("");
      if (i.type === "inlineEquation") return `<code class="math">${esc(i.content)}</code>`;
      if (i.props.kind === "page") return `@${esc(pageOf(i.props.pageId ?? "")?.title ?? "Untitled")}`;
      if (i.props.kind === "date") return `@${esc(i.props.date ?? "")}`;
      return `@${esc(i.props.name ?? "")}`;
    })
    .join("");
}

function blocksHtml(blocks: Block[], pageOf: (id: string) => { title: string } | null): string {
  let out = "";
  let list: string | null = null;
  const close = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const b of blocks) {
    const inner = Array.isArray(b.content) ? inlineHtml(b.content as Inline[], pageOf) : "";
    const kids = b.children.length ? blocksHtml(b.children, pageOf) : "";
    const tag = b.type === "bulletListItem" || b.type === "checkListItem" ? "ul" : b.type === "numberedListItem" ? "ol" : null;
    if (tag !== list) {
      close();
      if (tag) {
        out += `<${tag}>`;
        list = tag;
      }
    }
    switch (b.type) {
      case "paragraph":
        out += `<p>${inner}</p>${kids}`;
        break;
      case "heading":
        out += `<h${b.props.level ?? 1}>${inner}</h${b.props.level ?? 1}>${kids}`;
        break;
      case "bulletListItem":
      case "numberedListItem":
        out += `<li>${inner}${kids}</li>`;
        break;
      case "checkListItem":
        out += `<li><input type="checkbox" disabled${b.props.checked ? " checked" : ""}> ${inner}${kids}</li>`;
        break;
      case "toggleListItem":
        out += `<details><summary>${inner}</summary>${kids}</details>`;
        break;
      case "quote":
        out += `<blockquote>${inner}</blockquote>${kids}`;
        break;
      case "callout":
        out += `<aside>${esc(String(b.props.icon ?? "💡"))} ${inner}${kids}</aside>`;
        break;
      case "codeBlock":
        out += `<pre><code class="language-${esc(String(b.props.language ?? "text"))}">${esc((b.content as StyledText[]).map((t) => t.text).join(""))}</code></pre>`;
        break;
      case "equation":
        out += `<pre class="math">${esc((b.content as StyledText[]).map((t) => t.text).join(""))}</pre>`;
        break;
      case "divider":
        out += "<hr>";
        break;
      case "table": {
        const t = b.content as TableContent;
        out += `<table>${t.rows.map((r, ri) => `<tr>${r.cells.map((c, ci) => (ri < t.headerRows || ci < t.headerCols ? `<th>${inlineHtml(c.content, pageOf)}</th>` : `<td>${inlineHtml(c.content, pageOf)}</td>`)).join("")}</tr>`).join("")}</table>`;
        break;
      }
      case "image":
        out += `<figure><img src="${esc(String(b.props.url ?? ""))}" alt="${esc(String(b.props.caption ?? ""))}">${b.props.caption ? `<figcaption>${esc(String(b.props.caption))}</figcaption>` : ""}</figure>`;
        break;
      case "columnList":
        out += `<div style="display:flex;gap:24px">${b.children.map((c) => `<div style="flex:${Number(c.props.width ?? 1)}">${blocksHtml(c.children, pageOf)}</div>`).join("")}</div>`;
        break;
      case "subpage":
      case "linkToPage":
        out += `<p>📄 ${esc(pageOf(String(b.props.pageId ?? ""))?.title ?? "Untitled")}</p>`;
        break;
      default:
        if (b.props.url) out += `<p><a href="${esc(String(b.props.url))}">${esc(String(b.props.name || b.props.caption || b.props.url))}</a></p>`;
    }
  }
  close();
  return out;
}

function htmlPage(meta: PageMeta, blocks: Block[], pageOf: (id: string) => { title: string } | null) {
  const title = esc(displayTitle(meta));
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:708px;margin:48px auto;padding:0 24px}</style></head><body><h1>${title}</h1>${blocksHtml(blocks, pageOf)}</body></html>`;
}

function commentBody(text: string) {
  return text.split("\n").map((line) => ({ type: "paragraph", content: line }));
}

function commentMap(s: Session, text: string, now: number) {
  const me = s.a.me();
  const c = new Y.Map<unknown>();
  c.set("id", globalThis.crypto.randomUUID());
  c.set("userId", me.deviceId);
  c.set("createdAt", now);
  c.set("updatedAt", now);
  c.set("body", commentBody(text));
  c.set("reactionsByUser", new Y.Map());
  c.set("metadata", { name: me.name, color: me.color });
  return c;
}

function bodyText(body: unknown): string {
  if (!Array.isArray(body)) return "";
  return body
    .map((b) => {
      const c = (b as { content?: unknown })?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : typeof (x as { text?: unknown })?.text === "string" ? (x as { text: string }).text : "")).join("");
      return "";
    })
    .join("\n");
}

function threadJson(s: Session, t: Y.Map<unknown>, id: string, anchor?: { block: string; text: string }) {
  if (!(t instanceof Y.Map)) return null;
  const list = t.get("comments");
  const comments = list instanceof Y.Array ? (list.toArray() as Y.Map<unknown>[]) : [];
  const live = comments.filter((c) => c instanceof Y.Map && !c.get("deletedAt"));
  if (!live.length || t.get("deletedAt")) return null;
  const meta = (t.get("metadata") ?? {}) as Record<string, unknown>;
  return {
    id,
    resolved: t.get("resolved") === true,
    ...(meta.page ? { onPage: true } : {}),
    ...(typeof meta.quote === "string" ? { quote: meta.quote } : {}),
    ...(anchor ? { block: anchor.block } : {}),
    createdAt: iso(Number(t.get("createdAt") ?? 0)),
    updatedAt: iso(Number(t.get("updatedAt") ?? 0)),
    comments: live.map((c) => {
      const m = (c.get("metadata") ?? {}) as Record<string, unknown>;
      const user = String(c.get("userId") ?? "");
      return { id: String(c.get("id") ?? ""), author: typeof m.name === "string" ? m.name : s.person(user), userId: user, text: bodyText(c.get("body")), createdAt: iso(Number(c.get("createdAt") ?? 0)), ...(c.get("updatedAt") !== c.get("createdAt") ? { editedAt: iso(Number(c.get("updatedAt") ?? 0)) } : {}) };
    }),
  };
}

async function threadEdit(s: Session, args: Record<string, unknown>, change: (t: Y.Map<unknown>) => void) {
  const found = await s.page(args.page, { workspace: args.workspace });
  const { saved } = await s.editPage(
    found,
    (doc) => {
      const t = commentsOf(doc).get(String(args.thread));
      if (!(t instanceof Y.Map)) {
        const ids = [...commentsOf(doc).keys()];
        throw new ToolError(`There's no thread '${String(args.thread).slice(0, 60)}' on this page${suggest(String(args.thread), ids)} List them with comments list.`);
      }
      doc.transact(() => change(t));
    },
    { force: true, history: false },
  );
  const doc = await s.a.doc(found.ws, found.meta.id);
  return { thread: threadJson(s, commentsOf(doc).get(String(args.thread)) as Y.Map<unknown>, String(args.thread), threadAnchors(blocksOf(doc)).get(String(args.thread))), saved };
}

function markKey(threadId: string) {
  let h = 2166136261;
  for (let i = 0; i < threadId.length; i++) h = Math.imul(h ^ threadId.charCodeAt(i), 16777619) >>> 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let x = h;
  for (let i = 0; i < 8; i++) {
    out += alphabet[x & 63];
    x = Math.imul(x ^ (x >>> 7), 2654435761) >>> 0;
  }
  return `comment--${out}`;
}

function anchorComment(el: Y.XmlElement, threadId: string, quote?: string): string {
  const node = contentNodeOf(el);
  const text = node?.toArray().find((c): c is Y.XmlText => c instanceof Y.XmlText);
  if (!node || !text) throw new ToolError("comments add: that block has no text to comment on; leave block out for a page comment.");
  const plain = (text.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
  let start = 0;
  let length = plain.length;
  if (quote !== undefined) {
    const at = plain.indexOf(quote);
    if (at < 0) throw new ToolError(`comments add: '${quote.slice(0, 60)}' isn't in that block's text.`);
    start = at;
    length = quote.length;
  }
  if (!length) throw new ToolError("comments add: that block is empty; leave block out for a page comment.");
  text.format(start, length, { [markKey(threadId)]: { orphan: false, threadId } });
  return plain.slice(start, start + length);
}

function threadAnchors(fragment: Y.XmlFragment): Map<string, { block: string; text: string }> {
  const out = new Map<string, { block: string; text: string }>();
  for (const [id, el] of blockIndex(fragment)) {
    const node = contentNodeOf(el);
    if (!node) continue;
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlText)) continue;
      for (const d of child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        for (const [k, v] of Object.entries(d.attributes ?? {})) {
          if (!k.startsWith("comment") || !v || typeof v !== "object") continue;
          const t = (v as { threadId?: unknown }).threadId;
          if (typeof t === "string") {
            const prev = out.get(t);
            out.set(t, { block: id, text: (prev?.block === id ? prev.text : "") + (typeof d.insert === "string" ? d.insert : "") });
          }
        }
      }
    }
  }
  return out;
}
