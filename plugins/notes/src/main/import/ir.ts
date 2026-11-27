export type Marks = { bold?: true; italic?: true; underline?: true; strike?: true; code?: true; link?: string; highlight?: true };

export type Inline =
  | { t: "text"; text: string; marks?: Marks }
  | { t: "ref"; target: string; text: string; marks?: Marks }
  | { t: "math"; text: string }
  | { t: "date"; date: string }
  | { t: "break" };

export type BlockType =
  | "paragraph"
  | "heading"
  | "bulletListItem"
  | "numberedListItem"
  | "checkListItem"
  | "toggleListItem"
  | "quote"
  | "callout"
  | "codeBlock"
  | "equation"
  | "divider"
  | "image"
  | "file"
  | "table"
  | "pageRef"
  | "bookmark";

export type Block = {
  type: BlockType;
  props?: Record<string, string | number | boolean>;
  content?: Inline[];
  text?: string;
  src?: string;
  target?: string;
  rows?: Inline[][][];
  children?: Block[];
};

export type ColumnType = "text" | "number" | "select" | "multi_select" | "status" | "date" | "checkbox" | "url" | "email" | "phone" | "person" | "files";

export type Column = { name: string; type: ColumnType };

export type ImportNode = {
  key: string;
  parent: string | null;
  title: string;
  icon?: string;
  kind: "page" | "database";
  createdAt?: number;
  updatedAt?: number;
  path?: string;
  aliases?: string[];
  load?: () => Promise<Block[]>;
  blocks?: Block[];
  columns?: Column[];
  cells?: Record<string, string>;
};

export const textOf = (inlines: Inline[] | undefined): string =>
  (inlines ?? []).map((i) => (i.t === "text" || i.t === "ref" || i.t === "math" ? i.text : i.t === "date" ? i.date : "\n")).join("");

export const para = (text: string): Block => ({ type: "paragraph", content: text ? [{ t: "text", text }] : [] });

const SAFE_URL = /^(https?:|mailto:|tel:)/i;

export function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!url || url.length > 4096) return null;
  return SAFE_URL.test(url) ? url : null;
}

export function isExternal(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw.trim());
}
