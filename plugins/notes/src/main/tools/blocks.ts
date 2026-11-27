import * as Y from "yjs";
import { ToolError, closest, quoteList, suggest } from "./spec";

export const COLOR_NAMES = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export const ALIGNMENTS = ["left", "center", "right", "justify"] as const;

type PropDef = { type: "string" | "number" | "boolean"; default: unknown; values?: readonly (string | number)[]; doc: string; min?: number; max?: number };
type ContentKind = "inline" | "plain" | "table" | "none";
export type BlockDef = { content: ContentKind; props: Record<string, PropDef>; doc: string; layout?: "columnList" | "column" };

const textColor: PropDef = { type: "string", default: "default", values: COLOR_NAMES, doc: "text colour" };
const backgroundColor: PropDef = { type: "string", default: "default", values: COLOR_NAMES, doc: "background colour" };
const textAlignment: PropDef = { type: "string", default: "left", values: ALIGNMENTS, doc: "alignment" };
const base = { textColor, backgroundColor, textAlignment };
const media = (preview: boolean): Record<string, PropDef> => ({
  ...(preview ? { textAlignment } : {}),
  backgroundColor,
  name: { type: "string", default: "", doc: "file name" },
  url: { type: "string", default: "", doc: "address: https://… or file:<sha256> from files upload" },
  caption: { type: "string", default: "", doc: "caption shown under it" },
  showPreview: { type: "boolean", default: true, doc: "show the media itself rather than a link" },
  ...(preview ? { previewWidth: { type: "number", default: undefined, min: 16, max: 4000, doc: "width in pixels" } } : {}),
});
const pageId: PropDef = { type: "string", default: "", doc: "page id (12 hex)" };

export const BLOCKS: Record<string, BlockDef> = {
  paragraph: { content: "inline", props: base, doc: "plain text" },
  heading: {
    content: "inline",
    props: { ...base, level: { type: "number", default: 1, values: [1, 2, 3, 4], doc: "1 to 4" }, isToggleable: { type: "boolean", default: false, doc: "a toggle heading that folds its children" } },
    doc: "section heading",
  },
  quote: { content: "inline", props: { backgroundColor, textColor }, doc: "quotation" },
  bulletListItem: { content: "inline", props: base, doc: "bulleted list item; nested items go in children" },
  numberedListItem: { content: "inline", props: { ...base, start: { type: "number", default: undefined, min: 0, max: 1e9, doc: "number of the first item in its list" } }, doc: "numbered list item" },
  checkListItem: { content: "inline", props: { ...base, checked: { type: "boolean", default: false, doc: "ticked" } }, doc: "to-do" },
  toggleListItem: { content: "inline", props: base, doc: "toggle; what it folds goes in children" },
  callout: { content: "inline", props: { textColor, backgroundColor, icon: { type: "string", default: "💡", doc: "emoji" } }, doc: "highlighted note with an icon" },
  codeBlock: {
    content: "plain",
    props: {
      language: { type: "string", default: "text", doc: "language id such as javascript, python, mermaid" },
      wrap: { type: "boolean", default: false, doc: "wrap long lines" },
      view: { type: "string", default: "split", values: ["code", "preview", "split"], doc: "for mermaid and other previews" },
    },
    doc: "code; content is the source text",
  },
  equation: { content: "plain", props: {}, doc: "display maths; content is TeX" },
  table: { content: "table", props: { textColor }, doc: "table; content is tableContent" },
  image: { content: "none", props: media(true), doc: "image" },
  video: { content: "none", props: media(true), doc: "video" },
  audio: { content: "none", props: media(false), doc: "audio" },
  file: {
    content: "none",
    props: { backgroundColor, name: { type: "string", default: "", doc: "file name" }, url: { type: "string", default: "", doc: "address or file:<sha256>" }, caption: { type: "string", default: "", doc: "caption" } },
    doc: "attachment",
  },
  divider: { content: "none", props: {}, doc: "horizontal rule" },
  subpage: { content: "none", props: { pageId }, doc: "a child page shown as a block" },
  linkToPage: { content: "none", props: { pageId }, doc: "a link to another page" },
  bookmark: { content: "none", props: { url: { type: "string", default: "", doc: "web address" } }, doc: "web bookmark" },
  embed: { content: "none", props: { url: { type: "string", default: "", doc: "web address" } }, doc: "embedded page (Figma, YouTube, Maps…)" },
  toc: { content: "none", props: { textColor }, doc: "table of contents" },
  breadcrumb: { content: "none", props: {}, doc: "where this page sits" },
  database: {
    content: "none",
    props: { workspace: { type: "string", default: "", doc: "workspace id" }, database: { type: "string", default: "", doc: "database page id" }, view: { type: "string", default: "", doc: "view id or view type" } },
    doc: "inline database; make one with database create {inline: true}",
  },
  columnList: { content: "none", props: {}, doc: "columns side by side; children are 2 or more column blocks", layout: "columnList" },
  column: { content: "none", props: { width: { type: "number", default: 1, min: 0.05, max: 20, doc: "relative width" } }, doc: "one column; children are its blocks", layout: "column" },
};

export const BLOCK_TYPES = Object.keys(BLOCKS);
export const STYLE_KEYS = ["bold", "italic", "underline", "strike", "code", "textColor", "backgroundColor"] as const;
const BOOL_STYLES = new Set(["bold", "italic", "underline", "strike", "code"]);
const CELL_PROPS: Record<string, PropDef> = {
  backgroundColor,
  textColor,
  textAlignment,
  colspan: { type: "number", default: 1, min: 1, max: 100, doc: "columns it spans" },
  rowspan: { type: "number", default: 1, min: 1, max: 100, doc: "rows it spans" },
};

export type Styles = Partial<Record<"bold" | "italic" | "underline" | "strike" | "code", true> & Record<"textColor" | "backgroundColor", string>>;
export type StyledText = { type: "text"; text: string; styles: Styles };
export type Link = { type: "link"; href: string; content: StyledText[] };
export type Mention = { type: "mention"; props: { kind: "page" | "user" | "date"; pageId?: string; name?: string; color?: string; date?: string } };
export type InlineEquation = { type: "inlineEquation"; content: string };
export type Inline = StyledText | Link | Mention | InlineEquation;
export type TableCell = { type: "tableCell"; props: Record<string, unknown>; content: Inline[] };
export type TableContent = { type: "tableContent"; columnWidths: (number | null)[]; headerRows: number; headerCols: number; rows: { cells: TableCell[] }[] };
export type Block = { id: string; type: string; props: Record<string, unknown>; content?: Inline[] | TableContent; children: Block[] };

export const LIMITS = { blocks: 5000, depth: 24, text: 100_000, inline: 2000 };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function newBlockId(): string {
  return globalThis.crypto.randomUUID();
}

const LINK_SCHEMES = new Set(["http", "https", "mailto", "tel", "ardia"]);

export function safeHref(v: string, media = false): boolean {
  const squashed = v.replace(/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/g, "");
  if (media) return squashed === v && (v === "" || /^https?:\/\//i.test(v) || /^file:[0-9a-f]{64}$/.test(v));
  let decoded = squashed;
  try {
    decoded = decodeURIComponent(squashed).replace(/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/g, "");
  } catch {
    return false;
  }
  for (const form of [squashed, decoded]) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(form)?.[1]?.toLowerCase();
    if (scheme === undefined ? form.startsWith("//") : !LINK_SCHEMES.has(scheme)) return false;
    if (scheme === "ardia" && !/^ardia:\/\/notes(\/|$)/i.test(form)) return false;
  }
  return true;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanProp(def: PropDef, value: unknown, path: string): unknown {
  if (value === null) return null;
  if (def.type === "boolean") {
    if (typeof value !== "boolean") throw new ToolError(`${path} must be true or false.`);
    return value;
  }
  if (def.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${path} must be a number.`);
    if (def.values && !def.values.includes(value)) throw new ToolError(`${path} must be one of ${def.values.join(", ")}.`);
    if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) throw new ToolError(`${path} must be from ${def.min} to ${def.max}.`);
    return value;
  }
  if (typeof value !== "string") throw new ToolError(`${path} must be text.`);
  if (value.length > 4000) throw new ToolError(`${path} is longer than 4000 characters.`);
  if (path.endsWith(".url") && !safeHref(value, true)) throw new ToolError(`${path} must be an https:// address or file:<sha256> from files upload.`);
  if (def.values && !def.values.includes(value)) throw new ToolError(`${path} is '${value.slice(0, 40)}', which isn't one of ${quoteList(def.values.map(String))}${suggest(value, def.values.map(String))}`);
  return value;
}

export function cleanProps(type: string, defs: Record<string, PropDef>, raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isPlain(raw)) throw new ToolError(`${path} must be an object.`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const def = defs[k];
    if (!def) {
      const known = Object.keys(defs);
      throw new ToolError(`unknown prop '${k.slice(0, 40)}' for a ${type} block at ${path}${suggest(k, known)}${known.length ? ` ${type} takes ${quoteList(known)}.` : ` ${type} takes no props.`}`);
    }
    if (v === undefined) continue;
    out[k] = cleanProp(def, v, `${path}.${k}`);
  }
  return out;
}

function cleanStyles(raw: unknown, path: string): Styles {
  if (raw === undefined) return {};
  if (!isPlain(raw)) throw new ToolError(`${path} must be an object of styles.`);
  const out: Styles = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(STYLE_KEYS as readonly string[]).includes(k)) throw new ToolError(`unknown style '${k.slice(0, 40)}' at ${path}${suggest(k, STYLE_KEYS)} Styles: ${quoteList(STYLE_KEYS)}.`);
    if (BOOL_STYLES.has(k)) {
      if (v === false || v === undefined) continue;
      if (v !== true) throw new ToolError(`${path}.${k} must be true.`);
      (out as Record<string, unknown>)[k] = true;
    } else {
      if (v === "default" || v === undefined) continue;
      if (typeof v !== "string" || !(COLOR_NAMES as readonly string[]).includes(v)) throw new ToolError(`${path}.${k} must be one of ${quoteList(COLOR_NAMES)}.`);
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

type Budget = { blocks: number; ids: Set<string> };

function cleanStyledList(raw: unknown, path: string, budget: { n: number }): StyledText[] {
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) throw new ToolError(`${path} must be text or a list of styled text.`);
  return list.map((item, i) => {
    const p = `${path}[${i}]`;
    if (typeof item === "string") return { type: "text", text: textOf(item, p, budget), styles: {} };
    if (!isPlain(item) || (item.type !== undefined && item.type !== "text")) throw new ToolError(`${p} must be text or {type: "text", text, styles}.`);
    for (const k of Object.keys(item)) if (!["type", "text", "styles"].includes(k)) throw new ToolError(`unknown field '${k}' at ${p}${suggest(k, ["type", "text", "styles"])}`);
    return { type: "text", text: textOf(item.text, `${p}.text`, budget), styles: cleanStyles(item.styles, `${p}.styles`) };
  });
}

function textOf(v: unknown, path: string, budget: { n: number }): string {
  if (typeof v !== "string") throw new ToolError(`${path} must be text.`);
  budget.n += v.length;
  if (budget.n > LIMITS.text) throw new ToolError(`${path}: a block holds at most ${LIMITS.text} characters.`);
  return v;
}

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
const PAGE = /^[0-9a-f]{12}$/;

export function cleanInline(raw: unknown, path: string, plain = false): Inline[] {
  if (raw === undefined || raw === null) return [];
  const budget = { n: 0 };
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) throw new ToolError(`${path} must be text or a list of inline content.`);
  if (list.length > LIMITS.inline) throw new ToolError(`${path} has ${list.length} pieces; the most is ${LIMITS.inline}.`);
  const out: Inline[] = [];
  list.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (typeof item === "string") return void out.push({ type: "text", text: textOf(item, p, budget), styles: {} });
    if (!isPlain(item)) throw new ToolError(`${p} must be text or an inline object.`);
    const type = item.type ?? "text";
    if (plain && type !== "text") throw new ToolError(`${p}: this block holds plain text only.`);
    const allowed: Record<string, string[]> = { text: ["type", "text", "styles"], link: ["type", "href", "content"], mention: ["type", "props"], inlineEquation: ["type", "content"] };
    const fields = allowed[String(type)];
    if (!fields) throw new ToolError(`${p}.type is '${String(type).slice(0, 40)}', which isn't one of 'text', 'link', 'mention', 'inlineEquation'${suggest(String(type), Object.keys(allowed))}`);
    for (const k of Object.keys(item)) if (!fields.includes(k)) throw new ToolError(`unknown field '${k}' at ${p}${suggest(k, fields)} A ${String(type)} takes ${quoteList(fields)}.`);
    if (type === "text") {
      const styles = cleanStyles(item.styles, `${p}.styles`);
      out.push({ type: "text", text: textOf(item.text, `${p}.text`, budget), styles: plain ? {} : styles });
    } else if (type === "link") {
      if (typeof item.href !== "string" || !item.href || item.href.length > 4000) throw new ToolError(`${p}.href must be an address.`);
      if (!safeHref(item.href)) throw new ToolError(`${p}.href must be an http, https, mailto, tel or ardia address.`);
      out.push({ type: "link", href: item.href, content: cleanStyledList(item.content ?? item.href, `${p}.content`, budget) });
    } else if (type === "mention") {
      const props = item.props;
      if (!isPlain(props)) throw new ToolError(`${p}.props must be {kind: "page", pageId} or {kind: "user", name} or {kind: "date", date}.`);
      const kind = props.kind ?? "page";
      for (const k of Object.keys(props)) if (!["kind", "pageId", "name", "color", "date"].includes(k)) throw new ToolError(`unknown field '${k}' at ${p}.props${suggest(k, ["kind", "pageId", "name", "color", "date"])}`);
      if (kind === "page") {
        if (typeof props.pageId !== "string" || !PAGE.test(props.pageId)) throw new ToolError(`${p}.props.pageId must be a 12-character hex page id.`);
        out.push({ type: "mention", props: { kind: "page", pageId: props.pageId } });
      } else if (kind === "user") {
        if (typeof props.name !== "string" || !props.name || props.name.length > 200) throw new ToolError(`${p}.props.name must be a name.`);
        const color = props.color === undefined ? "" : props.color;
        if (typeof color !== "string" || (color && !/^#[0-9a-fA-F]{6}$/.test(color))) throw new ToolError(`${p}.props.color must be a #rrggbb colour.`);
        out.push({ type: "mention", props: { kind: "user", name: props.name, color } });
      } else if (kind === "date") {
        if (typeof props.date !== "string" || !DATE.test(props.date)) throw new ToolError(`${p}.props.date must be YYYY-MM-DD.`);
        out.push({ type: "mention", props: { kind: "date", date: props.date } });
      } else throw new ToolError(`${p}.props.kind must be 'page', 'user' or 'date'.`);
    } else {
      out.push({ type: "inlineEquation", content: textOf(item.content, `${p}.content`, budget) });
    }
  });
  return out;
}

function cleanTable(raw: unknown, path: string): TableContent {
  if (!isPlain(raw) || raw.type !== "tableContent") throw new ToolError(`${path} must be {type: "tableContent", rows: [{cells: [...]}]}.`);
  for (const k of Object.keys(raw)) if (!["type", "rows", "headerRows", "headerCols", "columnWidths"].includes(k)) throw new ToolError(`unknown field '${k}' at ${path}${suggest(k, ["rows", "headerRows", "headerCols", "columnWidths"])}`);
  if (!Array.isArray(raw.rows) || raw.rows.length === 0 || raw.rows.length > 1000) throw new ToolError(`${path}.rows must be 1 to 1000 rows.`);
  const rows = raw.rows.map((row, r) => {
    const rp = `${path}.rows[${r}]`;
    const cellsRaw = isPlain(row) ? row.cells : Array.isArray(row) ? row : undefined;
    if (!Array.isArray(cellsRaw) || cellsRaw.length === 0 || cellsRaw.length > 100) throw new ToolError(`${rp}.cells must be 1 to 100 cells.`);
    return {
      cells: cellsRaw.map((cell, c): TableCell => {
        const cp = `${rp}.cells[${c}]`;
        if (isPlain(cell) && cell.type === "tableCell") {
          for (const k of Object.keys(cell)) if (!["type", "props", "content"].includes(k)) throw new ToolError(`unknown field '${k}' at ${cp}`);
          return { type: "tableCell", props: cleanProps("tableCell", CELL_PROPS, cell.props, `${cp}.props`), content: cleanInline(cell.content, `${cp}.content`) };
        }
        return { type: "tableCell", props: {}, content: cleanInline(cell, cp) };
      }),
    };
  });
  const count = (v: unknown, name: string, max: number) => {
    if (v === undefined) return 0;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > max) throw new ToolError(`${path}.${name} must be a whole number from 0 to ${max}.`);
    return v as number;
  };
  const width = Math.max(...rows.map((r) => r.cells.length));
  let columnWidths: (number | null)[] = [];
  if (raw.columnWidths !== undefined) {
    if (!Array.isArray(raw.columnWidths) || raw.columnWidths.some((w) => w !== null && (typeof w !== "number" || w < 20 || w > 4000))) throw new ToolError(`${path}.columnWidths must be a list of pixel widths (20 to 4000) or null.`);
    columnWidths = raw.columnWidths as (number | null)[];
  }
  return { type: "tableContent", columnWidths, headerRows: count(raw.headerRows, "headerRows", rows.length), headerCols: count(raw.headerCols, "headerCols", width), rows };
}

export type CleanOptions = { budget?: Budget; keepIds?: boolean };

export function cleanBlocks(raw: unknown, path: string, options: CleanOptions = {}, depth = 0, parentLayout: "columnList" | "column" | null = null): Block[] {
  const budget = options.budget ?? { blocks: 0, ids: new Set<string>() };
  if (!Array.isArray(raw)) throw new ToolError(`${path} must be a list of blocks.`);
  if (depth > LIMITS.depth) throw new ToolError(`${path}: blocks nest at most ${LIMITS.depth} deep.`);
  return raw.map((item, i) => cleanBlock(item, `${path}[${i}]`, { ...options, budget }, depth, parentLayout));
}

export function cleanBlock(item: unknown, p: string, options: CleanOptions & { budget?: Budget } = {}, depth = 0, parentLayout: "columnList" | "column" | null = null): Block {
  const budget = options.budget ?? { blocks: 0, ids: new Set<string>() };
  if (++budget.blocks > LIMITS.blocks) throw new ToolError(`at most ${LIMITS.blocks} blocks fit in one call.`);
  if (typeof item === "string") item = { type: "paragraph", content: item };
  if (!isPlain(item)) throw new ToolError(`${p} must be a block object {type, props, content, children} or text.`);
  for (const k of Object.keys(item)) if (!["id", "type", "props", "content", "children"].includes(k)) throw new ToolError(`unknown field '${k}' at ${p}${suggest(k, ["id", "type", "props", "content", "children"])} A block takes 'id', 'type', 'props', 'content', 'children'.`);
  const type = item.type === undefined ? "paragraph" : item.type;
  if (typeof type !== "string" || !BLOCKS[type]) throw new ToolError(`${p}.type is '${String(type).slice(0, 40)}', which isn't a block type${suggest(String(type), BLOCK_TYPES)} Types: ${quoteList(BLOCK_TYPES)}.`);
  const def = BLOCKS[type]!;
  if (parentLayout === "columnList" && type !== "column") throw new ToolError(`${p}: a columnList holds only column blocks.`);
  if (parentLayout !== "columnList" && type === "column") throw new ToolError(`${p}: a column block goes only inside a columnList.`);
  if (parentLayout === "column" && type === "columnList") throw new ToolError(`${p}: columns can't nest inside a column.`);
  let id: string;
  if (item.id !== undefined) {
    if (typeof item.id !== "string" || !ID.test(item.id)) throw new ToolError(`${p}.id must be 1 to 64 letters, digits, '-' or '_'.`);
    if (budget.ids.has(item.id)) throw new ToolError(`${p}.id '${item.id}' appears twice.`);
    id = item.id;
  } else id = newBlockId();
  budget.ids.add(id);
  const props = cleanProps(type, def.props, item.props, `${p}.props`);
  let content: Block["content"];
  if (def.content === "inline") content = cleanInline(item.content, `${p}.content`);
  else if (def.content === "plain") content = mergeText(cleanInline(item.content, `${p}.content`, true) as StyledText[]);
  else if (def.content === "table") content = item.content === undefined ? { type: "tableContent", columnWidths: [], headerRows: 0, headerCols: 0, rows: [{ cells: [{ type: "tableCell", props: {}, content: [] }] }] } : cleanTable(item.content, `${p}.content`);
  else if (item.content !== undefined && !(Array.isArray(item.content) && item.content.length === 0)) throw new ToolError(`${p}: a ${type} block has no content; use props${Object.keys(def.props).length ? ` (${quoteList(Object.keys(def.props))})` : ""}.`);
  const children = item.children === undefined ? [] : cleanBlocks(item.children, `${p}.children`, { ...options, budget }, depth + 1, def.layout ?? null);
  if (type === "columnList" && children.length < 2) throw new ToolError(`${p}: a columnList needs at least 2 column children.`);
  if (type === "column" && children.length === 0) children.push(emptyParagraph());
  return { id, type, props, ...(content !== undefined ? { content } : {}), children };
}

export const emptyParagraph = (): Block => ({ id: newBlockId(), type: "paragraph", props: {}, content: [], children: [] });

function mergeText(list: StyledText[]): StyledText[] {
  const text = list.map((t) => t.text).join("");
  return text ? [{ type: "text", text, styles: {} }] : [];
}

export function blockText(block: Pick<Block, "content">): string {
  const c = block.content;
  if (!c) return "";
  if (!Array.isArray(c)) return c.rows.map((r) => r.cells.map((cell) => inlineText(cell.content)).join(" | ")).join("\n");
  return inlineText(c);
}

export function inlineText(list: Inline[]): string {
  return list
    .map((i) => {
      if (i.type === "text") return i.text;
      if (i.type === "link") return i.content.map((t) => t.text).join("");
      if (i.type === "inlineEquation") return i.content;
      if (i.props.kind === "page") return `@${i.props.pageId}`;
      if (i.props.kind === "date") return `@${i.props.date}`;
      return `@${i.props.name}`;
    })
    .join("");
}

const markKeys = (attrs: Record<string, unknown> | undefined): Styles & { link?: string } => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (BOOL_STYLES.has(k)) out[k] = true;
    else if (k === "textColor" || k === "backgroundColor") {
      const value = isPlain(v) ? v.stringValue : undefined;
      if (typeof value === "string" && value && value !== "default") out[k] = value;
    } else if (k === "link") {
      const href = isPlain(v) ? v.href : undefined;
      if (typeof href === "string") out.link = href;
    }
  }
  return out as Styles & { link?: string };
};

function readTextRuns(text: Y.XmlText, out: (StyledText & { link?: string })[]) {
  for (const op of text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof op.insert !== "string") continue;
    const { link, ...styles } = markKeys(op.attributes);
    out.push({ type: "text", text: op.insert, styles, ...(link ? { link } : {}) });
  }
}

const sameStyles = (a: Styles, b: Styles) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
};

export function readInline(node: Y.XmlElement): Inline[] {
  const runs: (StyledText & { link?: string } | Mention | InlineEquation)[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) readTextRuns(child, runs as (StyledText & { link?: string })[]);
    else if (child instanceof Y.XmlElement) {
      if (child.nodeName === "hardBreak") {
        const last = runs[runs.length - 1];
        runs.push({ type: "text", text: "\n", styles: last && last.type === "text" ? { ...last.styles } : {}, ...(last && last.type === "text" && last.link ? { link: last.link } : {}) });
      } else if (child.nodeName === "mention") {
        const a = child.getAttributes() as Record<string, unknown>;
        const kind = a.kind === "user" || a.kind === "date" ? a.kind : "page";
        if (kind === "page") runs.push({ type: "mention", props: { kind, pageId: String(a.pageId ?? "") } });
        else if (kind === "user") runs.push({ type: "mention", props: { kind, name: String(a.name ?? ""), ...(a.color ? { color: String(a.color) } : {}) } });
        else runs.push({ type: "mention", props: { kind, date: String(a.date ?? "") } });
      } else if (child.nodeName === "inlineEquation") {
        runs.push({ type: "inlineEquation", content: child.toArray().map((c) => (c instanceof Y.XmlText ? c.toString().replace(/<[^>]*>/g, "") : "")).join("") });
      }
    }
  }
  const out: Inline[] = [];
  for (const run of runs) {
    if (run.type !== "text") {
      out.push(run);
      continue;
    }
    const piece: StyledText = { type: "text", text: run.text, styles: run.styles };
    const last = out[out.length - 1];
    if (run.link) {
      if (last && last.type === "link" && last.href === run.link) {
        const tail = last.content[last.content.length - 1];
        if (tail && sameStyles(tail.styles, piece.styles)) tail.text += piece.text;
        else last.content.push(piece);
      } else out.push({ type: "link", href: run.link, content: [piece] });
    } else if (last && last.type === "text" && sameStyles(last.styles, piece.styles)) last.text += piece.text;
    else out.push(piece);
  }
  return out;
}

function plainOf(node: Y.XmlElement): string {
  let s = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) for (const op of child.toDelta() as { insert: unknown }[]) s += typeof op.insert === "string" ? op.insert : "";
    else if (child instanceof Y.XmlElement && child.nodeName === "hardBreak") s += "\n";
  }
  return s;
}

function readProps(type: string, el: Y.XmlElement): Record<string, unknown> {
  const def = BLOCKS[type];
  const attrs = el.getAttributes() as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "id" || v === null || v === undefined) continue;
    const pd = def?.props[k];
    if (!pd) continue;
    if (pd.default === v) continue;
    out[k] = v;
  }
  return out;
}

function readTable(node: Y.XmlElement): TableContent {
  const rows: { cells: TableCell[] }[] = [];
  const kinds: boolean[][] = [];
  const widths: (number | null)[] = [];
  for (const row of node.toArray()) {
    if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") continue;
    const cells: TableCell[] = [];
    const heads: boolean[] = [];
    for (const cell of row.toArray()) {
      if (!(cell instanceof Y.XmlElement)) continue;
      const attrs = cell.getAttributes() as Record<string, unknown>;
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attrs)) {
        const pd = CELL_PROPS[k];
        if (pd && v !== null && v !== undefined && v !== pd.default) props[k] = v;
      }
      const colwidth = attrs.colwidth;
      if (rows.length === 0 && Array.isArray(colwidth)) for (const w of colwidth) widths.push(typeof w === "number" ? w : null);
      else if (rows.length === 0) widths.push(null);
      const para = cell.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement);
      cells.push({ type: "tableCell", props, content: para ? readInline(para) : [] });
      heads.push(cell.nodeName === "tableHeader");
    }
    rows.push({ cells });
    kinds.push(heads);
  }
  let headerRows = 0;
  while (headerRows < kinds.length && kinds[headerRows]!.length && kinds[headerRows]!.every(Boolean)) headerRows++;
  let headerCols = 0;
  const width = Math.max(0, ...kinds.map((k) => k.length));
  while (headerCols < width && kinds.every((k, r) => r < headerRows || k[headerCols] === true)) headerCols++;
  if (headerCols && kinds.slice(headerRows).length === 0) headerCols = 0;
  return { type: "tableContent", columnWidths: widths.some((w) => w !== null) ? widths : [], headerRows, headerCols, rows };
}

export function readBlockElement(el: Y.XmlElement): Block | null {
  if (el.nodeName === "columnList" || el.nodeName === "column") {
    const children = el.toArray().flatMap((c) => (c instanceof Y.XmlElement ? [readBlockElement(c)] : [])).filter((b): b is Block => !!b);
    return { id: String(el.getAttribute("id") ?? ""), type: el.nodeName, props: readProps(el.nodeName, el), children };
  }
  if (el.nodeName !== "blockContainer") return null;
  const parts = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  const node = parts.find((c) => c.nodeName !== "blockGroup");
  const group = parts.find((c) => c.nodeName === "blockGroup");
  const children = group ? readGroup(group) : [];
  const id = String(el.getAttribute("id") ?? "");
  if (!node) return { id, type: "paragraph", props: {}, content: [], children };
  const type = node.nodeName;
  const def = BLOCKS[type];
  const props = readProps(type, node);
  let content: Block["content"];
  if (!def || def.content === "inline") content = readInline(node);
  else if (def.content === "plain") {
    const text = plainOf(node);
    content = text ? [{ type: "text", text, styles: {} }] : [];
  } else if (def.content === "table") content = readTable(node);
  return { id, type, props, ...(content !== undefined ? { content } : {}), children };
}

export function readGroup(group: Y.XmlElement | Y.XmlFragment): Block[] {
  const out: Block[] = [];
  for (const child of group.toArray()) if (child instanceof Y.XmlElement) {
    const block = readBlockElement(child);
    if (block) out.push(block);
  }
  return out;
}

export function rootGroup(fragment: Y.XmlFragment): Y.XmlElement | null {
  const first = fragment.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === "blockGroup");
  return first ?? null;
}

export function readDoc(fragment: Y.XmlFragment): Block[] {
  const root = rootGroup(fragment);
  return root ? readGroup(root) : [];
}

export function styleAttrs(styles: Styles, link?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (BOOL_STYLES.has(k)) out[k] = {};
    else if (typeof v === "string") out[k] = { stringValue: v };
  }
  if (link) out.link = { href: link };
  return out;
}

export type Piece = { kind: "text"; text: string; attrs: Record<string, unknown> } | { kind: "el"; make: () => Y.XmlElement; key: string };

export function inlinePieces(list: Inline[], plain: boolean): Piece[] {
  const out: Piece[] = [];
  const pushText = (text: string, attrs: Record<string, unknown>) => {
    if (!text) return;
    if (plain) {
      out.push({ kind: "text", text, attrs: {} });
      return;
    }
    const parts = text.split(/(\n)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === "\n") out.push({ kind: "el", key: "hardBreak", make: () => new Y.XmlElement("hardBreak") });
      else out.push({ kind: "text", text: part, attrs });
    }
  };
  for (const item of list) {
    if (item.type === "text") pushText(item.text, plain ? {} : styleAttrs(item.styles));
    else if (item.type === "link") for (const t of item.content) pushText(t.text, styleAttrs(t.styles, item.href));
    else if (item.type === "mention") {
      const props = item.props;
      out.push({
        kind: "el",
        key: `mention:${JSON.stringify(props)}`,
        make: () => {
          const el = new Y.XmlElement("mention");
          for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== "") el.setAttribute(k, v as string);
          return el;
        },
      });
    } else {
      const content = item.content;
      out.push({
        kind: "el",
        key: `eq:${content}`,
        make: () => {
          const el = new Y.XmlElement("inlineEquation");
          if (content) {
            const t = new Y.XmlText();
            t.insert(0, content);
            el.insert(0, [t]);
          }
          return el;
        },
      });
    }
  }
  return out;
}

export function piecesToNodes(pieces: Piece[]): (Y.XmlText | Y.XmlElement)[] {
  const nodes: (Y.XmlText | Y.XmlElement)[] = [];
  let text: Y.XmlText | null = null;
  let at = 0;
  for (const piece of pieces) {
    if (piece.kind === "el") {
      nodes.push(piece.make());
      text = null;
      continue;
    }
    if (!text) {
      text = new Y.XmlText();
      at = 0;
      nodes.push(text);
    }
    text.insert(at, piece.text, piece.attrs);
    at += piece.text.length;
  }
  return nodes;
}

function setProps(el: Y.XmlElement, props: Record<string, unknown>) {
  for (const [k, v] of Object.entries(props)) if (v !== null && v !== undefined) el.setAttribute(k, v as string);
}

function buildTable(node: Y.XmlElement, table: TableContent) {
  const rows: Y.XmlElement[] = [];
  table.rows.forEach((row, r) => {
    const tr = new Y.XmlElement("tableRow");
    const cells = row.cells.map((cell, c) => {
      const header = r < table.headerRows || c < table.headerCols;
      const td = new Y.XmlElement(header ? "tableHeader" : "tableCell");
      setProps(td, cell.props);
      const width = table.columnWidths[c];
      if (typeof width === "number") td.setAttribute("colwidth", [width] as unknown as string);
      const para = new Y.XmlElement("tableParagraph");
      const nodes = piecesToNodes(inlinePieces(cell.content, false));
      if (nodes.length) para.insert(0, nodes);
      td.insert(0, [para]);
      return td;
    });
    tr.insert(0, cells);
    rows.push(tr);
  });
  node.insert(0, rows);
}

export function buildContentNode(block: Block): Y.XmlElement {
  const def = BLOCKS[block.type]!;
  const node = new Y.XmlElement(block.type);
  setProps(node, block.props);
  if (def.content === "table" && block.content && !Array.isArray(block.content)) buildTable(node, block.content);
  else if ((def.content === "inline" || def.content === "plain") && Array.isArray(block.content)) {
    const nodes = piecesToNodes(inlinePieces(block.content, def.content === "plain"));
    if (nodes.length) node.insert(0, nodes);
  }
  return node;
}

export function buildBlock(block: Block): Y.XmlElement {
  const def = BLOCKS[block.type]!;
  if (def.layout) {
    const el = new Y.XmlElement(block.type);
    el.setAttribute("id", block.id);
    setProps(el, block.props);
    const kids = block.children.map(buildBlock);
    if (kids.length) el.insert(0, kids);
    return el;
  }
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", block.id);
  const parts: Y.XmlElement[] = [buildContentNode(block)];
  if (block.children.length) parts.push(buildGroup(block.children));
  container.insert(0, parts);
  return container;
}

export function buildGroup(blocks: Block[]): Y.XmlElement {
  const group = new Y.XmlElement("blockGroup");
  const kids = blocks.map(buildBlock);
  if (kids.length) group.insert(0, kids);
  return group;
}

export function writeDoc(fragment: Y.XmlFragment, blocks: Block[]) {
  const list = blocks.length ? blocks : [emptyParagraph()];
  if (fragment.length) fragment.delete(0, fragment.length);
  fragment.insert(0, [buildGroup(list)]);
}

export function walkBlocks(blocks: Block[], visit: (b: Block, depth: number, parent: Block | null) => void, depth = 0, parent: Block | null = null) {
  for (const b of blocks) {
    visit(b, depth, parent);
    walkBlocks(b.children, visit, depth + 1, b);
  }
}

export function suggestType(type: string) {
  return closest(type, BLOCK_TYPES);
}

export const CELL_PROP_DEFS = CELL_PROPS;
