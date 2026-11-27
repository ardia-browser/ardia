import type { BlockSpec, Inline } from "../blocks";
import type { Color } from "../database";
import type { DatabaseSpec, DateCell, PageSpec } from "./types";

export const REF = "$ref";
export const VIEW_REF = "$view";
export const DATE_REF = "$date";

export const ref = (key: string) => ({ [REF]: key });
export const viewRef = (database: string, view: string) => ({ [VIEW_REF]: `${database}.${view}` });

type Content = Inline | Inline[];
const flat = (parts: Content[]): Inline[] => parts.flatMap((part) => (Array.isArray(part) ? part : [part]));

export const b = (text: string): Inline => ({ text, marks: { bold: {} } });
export const i = (text: string): Inline => ({ text, marks: { italic: {} } });
export const u = (text: string): Inline => ({ text, marks: { underline: {} } });
export const s = (text: string): Inline => ({ text, marks: { strike: {} } });
export const code = (text: string): Inline => ({ text, marks: { code: {} } });
export const tint = (text: string, color: Color): Inline => ({ text, marks: { textColor: { stringValue: color } } });
export const mark = (text: string, color: Color): Inline => ({ text, marks: { backgroundColor: { stringValue: color } } });
export const link = (text: string, href: string): Inline => ({ text, marks: { link: { href } } });
export const today = (offset = 0): Inline => ({ node: "mention", attrs: { kind: "date", pageId: "", name: "", color: "", date: { [DATE_REF]: offset } } });
export const mention = (key: string): Inline => ({ node: "mention", attrs: { kind: "page", pageId: ref(key), name: "", color: "", date: "" } });

export const p = (...content: Content[]): BlockSpec => ({ type: "paragraph", content: flat(content) });
export const empty = (): BlockSpec => ({ type: "paragraph" });
export const h1 = (text: string): BlockSpec => ({ type: "heading", attrs: { level: 1 }, content: [text] });
export const h2 = (text: string): BlockSpec => ({ type: "heading", attrs: { level: 2 }, content: [text] });
export const h3 = (text: string): BlockSpec => ({ type: "heading", attrs: { level: 3 }, content: [text] });
export const toggleHeading = (level: 1 | 2 | 3, text: string, children: BlockSpec[]): BlockSpec => ({ type: "heading", attrs: { level, isToggleable: true }, content: [text], children });
export const bullet = (content: Content, children: BlockSpec[] = []): BlockSpec => ({ type: "bulletListItem", content: flat([content]), ...(children.length ? { children } : {}) });
export const bullets = (...items: Content[]): BlockSpec[] => items.map((item) => bullet(item));
export const num = (content: Content, children: BlockSpec[] = []): BlockSpec => ({ type: "numberedListItem", content: flat([content]), ...(children.length ? { children } : {}) });
export const nums = (...items: Content[]): BlockSpec[] => items.map((item) => num(item));
export const todo = (content: Content, checked = false, children: BlockSpec[] = []): BlockSpec => ({ type: "checkListItem", attrs: { checked }, content: flat([content]), ...(children.length ? { children } : {}) });
export const todos = (...items: Content[]): BlockSpec[] => items.map((item) => todo(item));
export const toggle = (content: Content, children: BlockSpec[]): BlockSpec => ({ type: "toggleListItem", content: flat([content]), children });
export const quote = (...content: Content[]): BlockSpec => ({ type: "quote", content: flat(content) });
export const callout = (icon: string, content: Content, color: Color = "default"): BlockSpec => ({ type: "callout", attrs: { icon, backgroundColor: color === "default" ? "default" : color }, content: flat([content]) });
export const codeBlock = (language: string, text: string): BlockSpec => ({ type: "codeBlock", attrs: { language }, content: [text] });
export const equation = (latex: string): BlockSpec => ({ type: "equation", content: [latex] });
export const divider = (): BlockSpec => ({ type: "divider" });
export const toc = (): BlockSpec => ({ type: "toc" });
export const columns = (...cols: BlockSpec[][]): BlockSpec => ({ type: "columnList", children: cols.map((children) => ({ type: "column", attrs: { width: 1 }, children })) });
export const subpage = (key: string): BlockSpec => ({ type: "subpage", attrs: { pageId: ref(key) } });
export const linkTo = (key: string): BlockSpec => ({ type: "linkToPage", attrs: { pageId: ref(key) } });
export const database = (key: string, view?: string): BlockSpec => ({ type: "database", attrs: { workspace: "", database: ref(key), view: view ? viewRef(key, view) : "" } });
export const at = (d: number, time?: string): DateCell => (time ? { d, at: time } : { d });
export const span = (d: number, end: number): DateCell => ({ d, end });

export const page = (spec: Omit<PageSpec, "kind">): PageSpec => ({ kind: "page", ...spec });
export const db = (spec: Omit<DatabaseSpec, "kind">): DatabaseSpec => ({ kind: "database", ...spec });
