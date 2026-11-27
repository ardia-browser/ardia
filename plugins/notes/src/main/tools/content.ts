import * as Y from "yjs";
import { blocksOf } from "../../shared/model";
import { BLOCKS, blockText, buildBlock, buildGroup, cleanBlocks, cleanInline, cleanProps, emptyParagraph, readBlockElement, walkBlocks, type Block, type Inline } from "./blocks";
import { blockIndex, checkFits, childTarget, contentNodeOf, ensureRoot, locate, reconcile, removeAt, setInline, updateBlockInPlace, type ReconcileStats } from "./editing";
import { blocksToMarkdown, markdownToBlocks, parseInline } from "./markdown";
import { Session, type Found } from "./common";
import { ToolError, any, arr, bool, checkFields, int, oneOf, opt, req, str, type Field } from "./spec";

const pageField = req(str(4096), "page id, ardia://notes/… address or exact title");
const blocksField = opt(any("a list of blocks: {id?, type, props?, content?, children?} (see describe › blocks)", 900_000));
const markdownField = opt(str(900_000), "Markdown in the dialect describe › markdown lists");

export const CONTENT_ACTIONS: Record<string, { doc: string; fields: Record<string, Field> }> = {
  get: {
    doc: "Read a page's body as Markdown (default), BlockNote block JSON with stable ids, or plain text.",
    fields: {
      page: pageField,
      format: opt(oneOf(["markdown", "blocks", "text"]), "default markdown"),
      ids: opt(bool, "markdown only: end each block's first line with {#blockId} so patch ops can target it"),
      block: opt(str(64), "only this block and its children"),
      title: opt(bool, "markdown only: start with '# Title' (default true)"),
    },
  },
  set: {
    doc: "Write the whole body. mode merge (default) keeps blocks that didn't change (matched by {#id} or by content), so comments, ids and other people's edits on them survive; replace rewrites everything.",
    fields: { page: pageField, markdown: markdownField, blocks: blocksField, mode: opt(oneOf(["merge", "replace"])), force: opt(bool, "edit even though the page is locked") },
  },
  append: {
    doc: "Add blocks at the end of the page, or at the end of a block's children.",
    fields: { page: pageField, markdown: markdownField, blocks: blocksField, parent: opt(str(64), "block id to append inside"), force: opt(bool) },
  },
  patch: {
    doc: "Surgical edits by block id, applied in order in one transaction; each op is checked before anything changes.",
    fields: { page: pageField, ops: req(arr(any("an op", 900_000), 500, 1), "list of ops; see describe › patchOps"), force: opt(bool) },
  },
};

export const PATCH_OPS: Record<string, { doc: string; fields: Record<string, Field> }> = {
  insert: {
    doc: "Insert blocks. Where: after or before a block id, or inside parent (a block id) at index; default the end of the page.",
    fields: { op: req(oneOf(["insert"])), blocks: blocksField, markdown: markdownField, after: opt(str(64)), before: opt(str(64)), parent: opt(str(64)), index: opt(int(0, 100_000)) },
  },
  update: {
    doc: "Change one block in place: its type, props (merged; null clears one) and content. content takes inline JSON or plain text; markdown takes inline Markdown. Text is diffed so the rest of the block keeps its identity.",
    fields: { op: req(oneOf(["update"])), id: req(str(64)), type: opt(str(40)), props: opt(any("props object")), content: opt(any("inline content, text, or tableContent")), markdown: opt(str(100_000), "inline Markdown for the block's text") },
  },
  delete: { doc: "Delete a block and its children.", fields: { op: req(oneOf(["delete"])), id: req(str(64)) } },
  move: {
    doc: "Move a block (with its children) after or before another, or inside parent at index (default end of the page).",
    fields: { op: req(oneOf(["move"])), id: req(str(64)), after: opt(str(64)), before: opt(str(64)), parent: opt(str(64)), index: opt(int(0, 100_000)) },
  },
  replace: { doc: "Replace one block with new blocks.", fields: { op: req(oneOf(["replace"])), id: req(str(64)), blocks: blocksField, markdown: markdownField } },
  replace_text: {
    doc: "Find and replace text inside blocks, keeping each block's formatting outside the match. Scope to one block with id.",
    fields: { op: req(oneOf(["replace_text"])), find: req(str(10_000, { min: 1 })), replace: req(str(10_000)), id: opt(str(64)), all: opt(bool, "every match (default only the first)"), caseSensitive: opt(bool, "default true") },
  },
  children: {
    doc: "Replace a block's children (merge semantics as in set).",
    fields: { op: req(oneOf(["children"])), id: req(str(64)), blocks: blocksField, markdown: markdownField },
  },
};

function bodyBlocks(args: Record<string, unknown>, path: string, allowEmpty = false): Block[] {
  if (args.markdown !== undefined && args.blocks !== undefined) throw new ToolError(`${path}: give markdown or blocks, not both.`);
  if (args.markdown !== undefined) return markdownToBlocks(String(args.markdown), `${path}.markdown`);
  if (args.blocks !== undefined) return cleanBlocks(args.blocks, `${path}.blocks`);
  if (allowEmpty) return [];
  throw new ToolError(`${path} needs markdown or blocks.`);
}

function idsIn(blocks: Block[]): string[] {
  const out: string[] = [];
  walkBlocks(blocks, (b) => out.push(b.id));
  return out;
}

function checkPageRefs(blocks: Block[], tree: Y.Doc, getPage: (id: string) => unknown, path: string) {
  walkBlocks(blocks, (b) => {
    const id = b.type === "subpage" || b.type === "linkToPage" ? b.props.pageId : b.type === "database" ? b.props.database : undefined;
    if (typeof id === "string" && id && !getPage(id)) throw new ToolError(`${path}: a ${b.type} block points at page ${id}, which isn't in this workspace.`);
    const inline = Array.isArray(b.content) ? (b.content as Inline[]) : [];
    for (const i of inline) if (i.type === "mention" && i.props.kind === "page" && !getPage(i.props.pageId ?? "")) throw new ToolError(`${path}: a mention points at page ${i.props.pageId}, which isn't in this workspace.`);
  });
  void tree;
}

function fillDatabaseBlocks(blocks: Block[], ws: string) {
  walkBlocks(blocks, (b) => {
    if (b.type === "database" && !b.props.workspace) b.props.workspace = ws;
  });
}

type Where = { after?: string; before?: string; parent?: string; index?: number };

function target(index: Map<string, Y.XmlElement>, fragment: Y.XmlFragment, where: Where, path: string): { parent: Y.XmlElement; at: number } {
  const given = ["after", "before", "parent"].filter((k) => (where as Record<string, unknown>)[k] !== undefined);
  if (given.length > 1) throw new ToolError(`${path}: give one of after, before or parent.`);
  if (where.after) {
    const l = locate(index, where.after, `${path}.after`);
    return { parent: l.parent, at: l.index + 1 };
  }
  if (where.before) {
    const l = locate(index, where.before, `${path}.before`);
    return { parent: l.parent, at: l.index };
  }
  const parent = where.parent ? childTarget(locate(index, where.parent, `${path}.parent`).el) : ensureRoot(fragment);
  const count = parent.toArray().filter((c) => c instanceof Y.XmlElement).length;
  const at = where.index === undefined ? parent.length : Math.min(where.index, count);
  return { parent, at };
}

function checkFresh(index: Map<string, Y.XmlElement>, blocks: Block[], path: string, except?: Set<string>) {
  for (const id of idsIn(blocks)) if (index.has(id) && !except?.has(id)) throw new ToolError(`${path}: block id '${id}' is already on this page; leave id out for new blocks.`);
}

function cleanOp(raw: unknown, i: number): Record<string, unknown> & { op: string } {
  const path = `ops[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`${path} must be an object with an op.`);
  const op = (raw as Record<string, unknown>).op;
  const spec = typeof op === "string" ? PATCH_OPS[op] : undefined;
  if (!spec) throw new ToolError(`${path}.op must be one of ${Object.keys(PATCH_OPS).map((k) => `'${k}'`).join(", ")}.`);
  return checkFields(spec.fields, raw, path) as Record<string, unknown> & { op: string };
}

function replaceText(el: Y.XmlElement, find: string, replace: string, all: boolean, caseSensitive: boolean): number {
  const node = contentNodeOf(el);
  if (!node) return 0;
  let count = 0;
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    let text = child.toString().length ? (child.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("") : "";
    let from = 0;
    for (;;) {
      const hay = caseSensitive ? text : text.toLowerCase();
      const at = hay.indexOf(caseSensitive ? find : find.toLowerCase(), from);
      if (at < 0) break;
      const attrs = attrsAt(child, at);
      child.delete(at, find.length);
      if (replace) child.insert(at, replace, attrs);
      text = text.slice(0, at) + replace + text.slice(at + find.length);
      from = at + replace.length;
      count++;
      if (!all) return count;
    }
  }
  return count;
}

function attrsAt(text: Y.XmlText, offset: number): Record<string, unknown> {
  let pos = 0;
  for (const d of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const len = typeof d.insert === "string" ? d.insert.length : 1;
    if (offset < pos + len) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.attributes ?? {})) if (!k.startsWith("comment")) out[k] = v;
      return out;
    }
    pos += len;
  }
  return {};
}

function updateFromOp(el: Y.XmlElement, op: Record<string, unknown>, path: string) {
  const current = readBlockElement(el);
  if (!current) throw new ToolError(`${path}: that block can't be edited.`);
  const type = op.type === undefined ? current.type : String(op.type);
  const def = BLOCKS[type];
  if (!def) throw new ToolError(`${path}.type '${type.slice(0, 40)}' isn't a block type.`);
  if ((current.type === "columnList" || current.type === "column" || def.layout) && type !== current.type) throw new ToolError(`${path}: columns can't change type.`);
  const props = cleanProps(type, def.props, op.props, `${path}.props`);
  let content: Block["content"] | undefined;
  if (op.markdown !== undefined && op.content !== undefined) throw new ToolError(`${path}: give content or markdown, not both.`);
  if (op.markdown !== undefined) {
    if (def.content !== "inline" && def.content !== "plain") throw new ToolError(`${path}: a ${type} block has no text.`);
    content = def.content === "plain" ? [{ type: "text", text: String(op.markdown), styles: {} }] : cleanInline(parseInline(String(op.markdown)), `${path}.markdown`);
  } else if (op.content !== undefined) {
    if (def.content === "none") throw new ToolError(`${path}: a ${type} block has no content.`);
    const probe = cleanBlocks([{ type, content: op.content }], path)[0]!;
    content = probe.content;
  }
  const next: Block = { id: current.id, type, props, ...(content !== undefined ? { content } : {}), children: [] };
  updateBlockInPlace(el, next, { props: "merge", content: content !== undefined });
}

export function applyOps(fragment: Y.XmlFragment, rawOps: unknown[], ws: string, getPage: (id: string) => unknown): { changed: string[]; removed: string[]; replaced: number } {
  const ops = rawOps.map((raw, i) => cleanOp(raw, i));
  const changed = new Set<string>();
  const removed: string[] = [];
  let replaced = 0;
  ensureRoot(fragment);
  ops.forEach((op, i) => {
    const path = `ops[${i}] (${op.op})`;
    const index = blockIndex(fragment);
    switch (op.op) {
      case "insert": {
        const blocks = bodyBlocks(op, path);
        fillDatabaseBlocks(blocks, ws);
        checkPageRefs(blocks, null as unknown as Y.Doc, getPage, path);
        checkFresh(index, blocks, path);
        const { parent, at } = target(index, fragment, op as Where, path);
        checkFits(parent, blocks, path);
        parent.insert(at, blocks.map(buildBlock));
        for (const id of idsIn(blocks)) changed.add(id);
        return;
      }
      case "update": {
        const { el } = locate(index, String(op.id), `${path}.id`);
        updateFromOp(el, op, path);
        changed.add(String(op.id));
        return;
      }
      case "delete": {
        const l = locate(index, String(op.id), `${path}.id`);
        const gone = readBlockElement(l.el);
        if (gone) removed.push(...idsIn([gone]));
        removeAt(l.parent, l.index);
        if (l.parent.nodeName === "columnList" && l.parent.toArray().length < 2) unwrapColumns(l.parent);
        return;
      }
      case "move": {
        const l = locate(index, String(op.id), `${path}.id`);
        const moving = readBlockElement(l.el)!;
        const inside = new Set(idsIn([moving]));
        for (const k of ["after", "before", "parent"] as const) if (typeof op[k] === "string" && inside.has(op[k] as string)) throw new ToolError(`${path}: a block can't move inside itself.`);
        const clone = l.el.clone() as Y.XmlElement;
        removeAt(l.parent, l.index);
        const fresh = blockIndex(fragment);
        const { parent, at } = target(fresh, fragment, op as Where, path);
        checkFits(parent, [moving], path);
        parent.insert(at, [clone]);
        changed.add(moving.id);
        return;
      }
      case "replace": {
        const l = locate(index, String(op.id), `${path}.id`);
        const blocks = bodyBlocks(op, path);
        fillDatabaseBlocks(blocks, ws);
        checkPageRefs(blocks, null as unknown as Y.Doc, getPage, path);
        const old = readBlockElement(l.el)!;
        checkFresh(index, blocks, path, new Set(idsIn([old])));
        checkFits(l.parent, blocks, path);
        removed.push(...idsIn([old]).filter((id) => !idsIn(blocks).includes(id)));
        l.parent.delete(l.index, 1);
        if (blocks.length) l.parent.insert(l.index, blocks.map(buildBlock));
        else if (l.parent.length === 0) removeAt(l.parent, 0 as number);
        for (const id of idsIn(blocks)) changed.add(id);
        return;
      }
      case "children": {
        const l = locate(index, String(op.id), `${path}.id`);
        const blocks = bodyBlocks(op, path, true);
        fillDatabaseBlocks(blocks, ws);
        checkPageRefs(blocks, null as unknown as Y.Doc, getPage, path);
        const stats: ReconcileStats = { kept: 0, updated: 0, inserted: 0, deleted: 0, moved: 0 };
        const el = l.el;
        if (el.nodeName === "blockContainer") {
          const group = el.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === "blockGroup");
          if (!blocks.length) {
            if (group) el.delete(el.toArray().indexOf(group), 1);
          } else reconcile(group ?? childTarget(el), blocks, stats);
        } else {
          checkFits(el, blocks, path);
          if (el.nodeName === "columnList" && blocks.length < 2) throw new ToolError(`${path}: a columnList needs at least 2 columns.`);
          reconcile(el, blocks, stats);
        }
        changed.add(String(op.id));
        return;
      }
      case "replace_text": {
        const find = String(op.find);
        const replace = String(op.replace);
        const all = op.all === true;
        const caseSensitive = op.caseSensitive !== false;
        const els = op.id ? [locate(index, String(op.id), `${path}.id`).el] : [...index.values()];
        let total = 0;
        for (const el of els) {
          const n = replaceText(el, find, replace, all, caseSensitive);
          if (n) {
            total += n;
            const id = el.getAttribute("id");
            if (typeof id === "string") changed.add(id);
            if (!all) break;
          }
        }
        if (!total) throw new ToolError(`${path}: '${find.slice(0, 60)}' isn't in ${op.id ? `block ${String(op.id)}` : "this page"}.`);
        replaced += total;
        return;
      }
    }
  });
  return { changed: [...changed], removed, replaced };
}

function unwrapColumns(list: Y.XmlElement) {
  const parent = list.parent;
  if (!(parent instanceof Y.XmlElement)) return;
  const at = parent.toArray().indexOf(list);
  const column = list.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  const kids = column ? column.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement).map((c) => c.clone() as Y.XmlElement) : [];
  parent.delete(at, 1);
  if (kids.length) parent.insert(at, kids);
  else if (parent.length === 0) removeAt(parent, 0);
}

function subtree(blocks: Block[], id: string): Block | null {
  let found: Block | null = null;
  walkBlocks(blocks, (b) => {
    if (!found && b.id === id) found = b;
  });
  return found;
}

function summary(blocks: Block[], ids: string[]) {
  const wanted = new Set(ids);
  const out: { id: string; type: string; text: string }[] = [];
  walkBlocks(blocks, (b) => {
    if (wanted.has(b.id)) out.push({ id: b.id, type: b.type, text: blockText(b).slice(0, 200) });
  });
  return out;
}

export function contentTool(s: Session) {
  const pageGetter = (found: Found) => (id: string) => {
    const meta = found.tree && (found.tree.getMap("pages").get(id) as Y.Map<unknown> | undefined);
    return meta && meta.get("deleted") !== true ? meta : null;
  };
  return {
    get: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page, { archived: true });
      const format = (args.format as string) ?? "markdown";
      let blocks = await s.blocks(found);
      if (args.block) {
        const one = subtree(blocks, String(args.block));
        if (!one) throw new ToolError(`There's no block '${String(args.block)}' on this page.`);
        blocks = [one];
      }
      const base = { page: found.meta.id, title: found.meta.title, workspace: found.ws, format };
      if (format === "blocks") return { ...base, blocks };
      if (format === "text") {
        const lines: string[] = [];
        walkBlocks(blocks, (b, depth) => lines.push(`${"  ".repeat(depth)}${blockText(b)}`));
        return { ...base, text: lines.join("\n") };
      }
      const body = blocksToMarkdown(blocks, { ids: args.ids === true, pageOf: s.pageOf(found.tree) });
      const icon = found.meta.icon && !found.meta.icon.startsWith("file:") ? `${found.meta.icon} ` : "";
      return { ...base, markdown: args.title === false || args.block ? body : `# ${icon}${found.meta.title || "Untitled"}\n\n${body}` };
    },
    set: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page);
      let blocks = bodyBlocks(args, "content set", true);
      const first = blocks[0];
      if (args.markdown !== undefined && first?.type === "heading" && first.props.level === 1 && !first.children.length) {
        const text = blockText(first).trim();
        const title = (found.meta.title || "Untitled").trim();
        if (text === title || (found.meta.icon && text === `${found.meta.icon} ${title}`)) blocks = blocks.slice(1);
      }
      fillDatabaseBlocks(blocks, found.ws);
      checkPageRefs(blocks, found.tree, pageGetter(found), "content set");
      const stats: ReconcileStats = { kept: 0, updated: 0, inserted: 0, deleted: 0, moved: 0 };
      const { saved } = await s.editPage(
        found,
        (doc) => {
          const fragment = blocksOf(doc);
          doc.transact(() => {
            if (args.mode === "replace") {
              if (fragment.length) fragment.delete(0, fragment.length);
              fragment.insert(0, [buildGroupOf(blocks)]);
              stats.inserted = idsIn(blocks).length;
            } else reconcile(ensureRoot(fragment), blocks, stats);
          });
        },
        { force: args.force === true },
      );
      const after = await s.blocks(found);
      return { page: found.meta.id, stats, blockCount: countBlocks(after), saved, ids: after.map((b) => b.id) };
    },
    append: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page);
      const blocks = bodyBlocks(args, "content append");
      fillDatabaseBlocks(blocks, found.ws);
      checkPageRefs(blocks, found.tree, pageGetter(found), "content append");
      const { saved } = await s.editPage(
        found,
        (doc) => {
          const fragment = blocksOf(doc);
          doc.transact(() => {
            const index = blockIndex(fragment);
            checkFresh(index, blocks, "content append");
            const { parent, at } = target(index, fragment, args.parent ? { parent: String(args.parent) } : {}, "content append");
            checkFits(parent, blocks, "content append");
            dropTrailingEmpty(parent, args.parent === undefined);
            parent.insert(Math.min(at, parent.length), blocks.map(buildBlock));
          });
        },
        { force: args.force === true },
      );
      return { page: found.meta.id, appended: summary(blocks, idsIn(blocks)).slice(0, 200), saved };
    },
    patch: async (args: Record<string, unknown>) => {
      const found = await s.page(args.page);
      const ops = args.ops as unknown[];
      let result: ReturnType<typeof applyOps> = { changed: [], removed: [], replaced: 0 };
      const { saved } = await s.editPage(
        found,
        (doc) => {
          const probe = new Y.Doc({ gc: false });
          Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
          applyOps(blocksOf(probe), ops, found.ws, pageGetter(found));
          probe.destroy();
          doc.transact(() => {
            result = applyOps(blocksOf(doc), ops, found.ws, pageGetter(found));
          });
        },
        { force: args.force === true },
      );
      const after = await s.blocks(found);
      return { page: found.meta.id, applied: ops.length, changed: summary(after, result.changed), removed: result.removed, ...(result.replaced ? { replaced: result.replaced } : {}), saved };
    },
  };
}

function dropTrailingEmpty(parent: Y.XmlElement, root: boolean) {
  if (!root) return;
  const kids = parent.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  if (kids.length !== 1) return;
  const only = readBlockElement(kids[0]!);
  if (only && only.type === "paragraph" && !blockText(only) && !only.children.length) parent.delete(0, 1);
}

function countBlocks(blocks: Block[]) {
  let n = 0;
  walkBlocks(blocks, () => n++);
  return n;
}

function buildGroupOf(blocks: Block[]) {
  return buildGroup(blocks.length ? blocks : [emptyParagraph()]);
}
