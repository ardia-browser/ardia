import { BLOCKS, COLOR_NAMES, cleanBlock, newBlockId, safeHref, type Block, type Inline, type StyledText, type Styles, type TableContent } from "./blocks";
import { ToolError } from "./spec";

export type PageRef = (id: string) => { title: string } | null;

const ALERTS: Record<string, string> = { NOTE: "ℹ️", TIP: "💡", IMPORTANT: "❗", WARNING: "⚠️", CAUTION: "🛑" };
const DIRECTIVES = ["image", "video", "audio", "file", "bookmark", "embed", "toc", "breadcrumb", "page", "link", "database"] as const;
const DIRECTIVE_TYPE: Record<string, string> = { image: "image", video: "video", audio: "audio", file: "file", bookmark: "bookmark", embed: "embed", toc: "toc", breadcrumb: "breadcrumb", page: "subpage", link: "linkToPage", database: "database" };

function slug(title: string) {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return cleaned || "Untitled";
}

const escapeText = (text: string) => text.replace(/([\\`*_[\]~$<])/g, "\\$1").replace(/@(page|user|date)\(/g, "\\@$1(");

function escapeLineStart(line: string) {
  if (/^(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|:::|\||---|___|\*\*\*|```|\$\$|!\[|::[a-z])/.test(line)) return `\\${line}`;
  return line;
}

function wrap(text: string, open: string, close = open) {
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  const core = text.slice(lead.length, text.length - trail.length);
  return core ? `${lead}${open}${core}${close}${trail}` : text;
}

function styled(t: StyledText): string {
  if (!t.text) return "";
  const s = t.styles;
  let out: string;
  if (s.code) {
    const ticks = t.text.includes("`") ? "``" : "`";
    const pad = t.text.startsWith("`") || t.text.endsWith("`") ? " " : "";
    out = `${ticks}${pad}${t.text}${pad}${ticks}`;
  } else out = escapeText(t.text);
  if (s.bold) out = wrap(out, "**");
  if (s.italic) out = wrap(out, "*");
  if (s.strike) out = wrap(out, "~~");
  if (s.underline) out = wrap(out, "<u>", "</u>");
  if (s.textColor || s.backgroundColor) out = wrap(out, `<span${s.textColor ? ` color="${s.textColor}"` : ""}${s.backgroundColor ? ` bg="${s.backgroundColor}"` : ""}>`, "</span>");
  return out;
}

export function inlineToMarkdown(list: Inline[], pageOf: PageRef): string {
  return list
    .map((item) => {
      if (item.type === "text") return styled(item);
      if (item.type === "link") return `[${item.content.map(styled).join("")}](${item.href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
      if (item.type === "inlineEquation") return `$${item.content.replace(/\$/g, "\\$")}$`;
      const p = item.props;
      if (p.kind === "page") {
        const page = pageOf(p.pageId ?? "");
        const title = page?.title || "Untitled";
        return `[@${escapeText(title)}](ardia://notes/${slug(title)}-${p.pageId})`;
      }
      if (p.kind === "date") return `@date(${p.date})`;
      return `@user(${(p.name ?? "").replace(/[()]/g, "")}${p.color ? ` ${p.color}` : ""})`;
    })
    .join("");
}

const attrValue = (v: unknown) => {
  const s = String(v);
  return /^[^\s}"]+$/.test(s) ? s : `"${s.replace(/"/g, "'")}"`;
};

function attrsOf(block: Block, skip: string[], ids: boolean): string {
  const parts: string[] = [];
  if (ids && block.id) parts.push(`#${block.id}`);
  for (const [k, v] of Object.entries(block.props)) if (!skip.includes(k) && v !== undefined && v !== null) parts.push(`${k}=${attrValue(v)}`);
  return parts.length ? ` {${parts.join(" ")}}` : "";
}

type Out = { lines: string[]; ids: boolean; pageOf: PageRef };

function indent(lines: string[], by: string): string[] {
  return lines.map((l) => (l ? by + l : l));
}

function textLines(md: string): string[] {
  return md.split("\n").map((l, i) => (i === 0 ? l : escapeLineStart(l)));
}

function tableToMarkdown(table: TableContent, pageOf: PageRef): string[] {
  const width = Math.max(...table.rows.map((r) => r.cells.length));
  const cell = (c: TableContent["rows"][number]["cells"][number] | undefined) => (c ? inlineToMarkdown(c.content, pageOf).replace(/\|/g, "\\|").replace(/\n/g, "<br>") : "");
  const row = (cells: TableContent["rows"][number]["cells"]) => `| ${Array.from({ length: width }, (_, i) => cell(cells[i])).join(" | ")} |`;
  const lines: string[] = [];
  table.rows.forEach((r, i) => {
    lines.push(row(r.cells));
    if (i === 0) lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  });
  if (table.headerRows !== 1 || table.headerCols) lines.push(`{headerRows=${table.headerRows}${table.headerCols ? ` headerCols=${table.headerCols}` : ""}}`);
  return lines;
}

function blockToLines(block: Block, out: Out, listIndex: number): string[] {
  const inline = Array.isArray(block.content) ? inlineToMarkdown(block.content as Inline[], out.pageOf) : "";
  const kids = (by: string) => (block.children.length ? indent(blocksToLines(block.children, out), by) : []);
  switch (block.type) {
    case "paragraph": {
      const a = attrsOf(block, [], out.ids);
      const body = textLines(escapeLineStart(inline));
      if (!inline && !a) return block.children.length ? ["&nbsp;", ...kids("  ")] : [];
      if (a) body[body.length - 1] += a;
      return [...body, ...kids("  ")];
    }
    case "heading": {
      const level = Number(block.props.level ?? 1);
      const hashes = "#".repeat(level);
      if (block.props.isToggleable) {
        const body = blocksToLines(block.children, out);
        return [`<details><summary>${hashes} ${inline.replace(/\n/g, " ")}${attrsOf(block, ["level", "isToggleable"], out.ids)}</summary>`, "", ...body, ...(body.length ? [""] : []), "</details>"];
      }
      return [`${hashes} ${inline.replace(/\n/g, " ")}${attrsOf(block, ["level"], out.ids)}`, ...kids("  ")];
    }
    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem": {
      const marker = block.type === "bulletListItem" ? "- " : block.type === "checkListItem" ? `- [${block.props.checked ? "x" : " "}] ` : `${listIndex}. `;
      const skip = block.type === "checkListItem" ? ["checked"] : block.type === "numberedListItem" ? ["start"] : [];
      const body = textLines(inline);
      body[0] = marker + body[0];
      body[body.length - 1] += attrsOf(block, skip, out.ids);
      const pad = " ".repeat(block.type === "numberedListItem" ? marker.length : 2);
      return [...body.map((l, i) => (i === 0 ? l : pad + l)), ...kids(pad)];
    }
    case "toggleListItem": {
      const body = blocksToLines(block.children, out);
      return [`<details><summary>${inline.replace(/\n/g, "<br>")}${attrsOf(block, [], out.ids)}</summary>`, "", ...body, ...(body.length ? [""] : []), "</details>"];
    }
    case "quote":
    case "callout": {
      const head = block.type === "callout" ? `[!${block.props.icon ?? "💡"}] ` : "";
      const body = textLines(inline);
      body[0] = head + body[0];
      body[body.length - 1] += attrsOf(block, block.type === "callout" ? ["icon"] : [], out.ids);
      return [...body.map((l) => `> ${l}`), ...kids("  ")];
    }
    case "codeBlock": {
      const text = Array.isArray(block.content) ? (block.content as StyledText[]).map((t) => t.text).join("") : "";
      const fence = text.includes("```") ? "````" : "```";
      const lang = String(block.props.language ?? "text");
      return [`${fence}${lang === "text" ? "" : lang}${attrsOf(block, ["language"], out.ids)}`, ...text.split("\n"), fence, ...kids("  ")];
    }
    case "equation": {
      const text = Array.isArray(block.content) ? (block.content as StyledText[]).map((t) => t.text).join("") : "";
      return [`$$${attrsOf(block, [], out.ids)}`, ...text.split("\n"), "$$", ...kids("  ")];
    }
    case "divider":
      return [`---${attrsOf(block, [], out.ids)}`];
    case "table":
      return [...tableToMarkdown(block.content as TableContent, out.pageOf), ...(attrsOf(block, [], out.ids) ? [attrsOf(block, [], out.ids).trim()] : [])];
    case "image": {
      const url = String(block.props.url ?? "");
      const alt = String(block.props.caption ?? "");
      return [`![${alt.replace(/[[\]]/g, "")}](${url.replace(/[()\s]/g, (c) => encodeURIComponent(c))})${attrsOf(block, ["url", "caption"], out.ids)}`];
    }
    case "columnList": {
      const lines = [`:::columns${attrsOf(block, [], out.ids)}`];
      for (const column of block.children) lines.push(`:::column${attrsOf(column, [], out.ids)}`, ...blocksToLines(column.children, out), ":::");
      lines.push(":::");
      return lines;
    }
    default: {
      const name = Object.entries(DIRECTIVE_TYPE).find(([, t]) => t === block.type)?.[0];
      if (!name) return [`<!-- ${block.type} -->`];
      const p = block.props;
      let label = "";
      let target = "";
      if (block.type === "subpage" || block.type === "linkToPage") {
        target = String(p.pageId ?? "");
        label = out.pageOf(target)?.title ?? "";
      } else if (block.type === "database") {
        target = String(p.database ?? "");
        label = out.pageOf(target)?.title ?? "";
      } else if (block.type === "bookmark" || block.type === "embed") target = String(p.url ?? "");
      else if (block.type === "video" || block.type === "audio" || block.type === "file") {
        target = String(p.url ?? "");
        label = String((block.type === "file" ? p.name : p.caption) ?? "");
      }
      const skip = ["pageId", "url", block.type === "file" ? "name" : "caption", ...(block.type === "database" ? ["database", "workspace"] : [])];
      const body = `::${name}${label ? `[${label.replace(/[[\]]/g, "")}]` : ""}${target ? `(${target.replace(/[()\s]/g, (c) => encodeURIComponent(c))})` : ""}`;
      return [`${body}${attrsOf(block, skip, out.ids)}`];
    }
  }
}

const LIST_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);

function blocksToLines(blocks: Block[], out: Out): string[] {
  const lines: string[] = [];
  let number = 0;
  let prev: Block | null = null;
  for (const block of blocks) {
    if (block.type === "numberedListItem") number = prev?.type === "numberedListItem" ? number + 1 : Number(block.props.start ?? 1);
    const tight = prev && LIST_TYPES.has(prev.type) && LIST_TYPES.has(block.type) && prev.type === block.type;
    if (prev && !tight) lines.push("");
    lines.push(...blockToLines(block, out, number));
    prev = block;
  }
  return lines;
}

export function blocksToMarkdown(blocks: Block[], options: { ids?: boolean; pageOf?: PageRef } = {}): string {
  const lines = blocksToLines(blocks, { lines: [], ids: options.ids === true, pageOf: options.pageOf ?? (() => null) });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

type Ctx = { styles: Styles; link?: string };

function pushText(out: Inline[], text: string, ctx: Ctx) {
  if (!text) return;
  const styles = { ...ctx.styles };
  if (ctx.link) {
    const last = out[out.length - 1];
    const piece: StyledText = { type: "text", text, styles };
    if (last && last.type === "link" && last.href === ctx.link) {
      const tail = last.content[last.content.length - 1];
      if (tail && JSON.stringify(tail.styles) === JSON.stringify(styles)) tail.text += text;
      else last.content.push(piece);
    } else out.push({ type: "link", href: ctx.link, content: [piece] });
    return;
  }
  const last = out[out.length - 1];
  if (last && last.type === "text" && JSON.stringify(last.styles) === JSON.stringify(styles)) last.text += text;
  else out.push({ type: "text", text, styles });
}

function findClose(src: string, from: number, token: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "`") {
      const tick = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(tick, i + tick.length);
      if (end > 0) i = end + tick.length - 1;
      continue;
    }
    if (src.startsWith(token, i)) {
      if (token === "*" && src[i + 1] === "*") {
        const after = findClose(src, i + 2, "**");
        if (after > 0) {
          i = after + 1;
          continue;
        }
      }
      return i;
    }
  }
  return -1;
}

function bracketEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

const PAGE_LINK = /^ardia:\/\/notes\/(?:[^/?#]*-)?([0-9a-f]{12})(?:[?#].*)?$/;

function parseInlineInto(src: string, out: Inline[], ctx: Ctx) {
  let i = 0;
  let buf = "";
  const flush = () => {
    pushText(out, buf, ctx);
    buf = "";
  };
  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);
    if (c === "\\" && i + 1 < src.length && /[\\`*_[\]~$<>@#|!(){}+\-.:]/.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const tick = /^`+/.exec(rest)![0];
      const end = src.indexOf(tick, i + tick.length);
      if (end > 0) {
        flush();
        let code = src.slice(i + tick.length, end);
        if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        pushText(out, code, { ...ctx, styles: { ...ctx.styles, code: true } });
        i = end + tick.length;
        continue;
      }
    }
    if (c === "$" && src[i + 1] !== "$" && src[i + 1] !== " ") {
      const end = findClose(src, i + 1, "$");
      if (end > i + 1) {
        flush();
        out.push({ type: "inlineEquation", content: src.slice(i + 1, end).replace(/\\\$/g, "$") });
        i = end + 1;
        continue;
      }
    }
    const mention = /^@(user|date|page)\(([^)]*)\)/.exec(rest);
    if (mention) {
      flush();
      const [, kind, arg] = mention;
      if (kind === "date") out.push({ type: "mention", props: { kind: "date", date: arg!.trim() } });
      else if (kind === "page") out.push({ type: "mention", props: { kind: "page", pageId: arg!.trim() } });
      else {
        const m = /^(.*?)(?:\s+(#[0-9a-fA-F]{6}))?$/.exec(arg!.trim())!;
        out.push({ type: "mention", props: { kind: "user", name: m[1]!.trim(), ...(m[2] ? { color: m[2] } : {}) } });
      }
      i += mention[0].length;
      continue;
    }
    if (c === "[") {
      const close = bracketEnd(src, i + 1);
      if (close > 0 && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end > 0) {
          const label = src.slice(i + 1, close);
          const href = decodeHref(src.slice(close + 2, end).trim().replace(/\s+"[^"]*"$/, ""));
          const page = PAGE_LINK.exec(href);
          flush();
          if (page && label.startsWith("@")) out.push({ type: "mention", props: { kind: "page", pageId: page[1]! } });
          else if (!safeHref(href)) parseInlineInto(label, out, ctx);
          else parseInlineInto(label, out, { ...ctx, link: href });
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "<") {
      const u = /^<u>/i.exec(rest);
      const span = /^<span((?:\s+(?:color|bg)="[a-z]+")+)\s*>/i.exec(rest);
      const br = /^<br\s*\/?>/i.exec(rest);
      if (br) {
        buf += "\n";
        i += br[0].length;
        continue;
      }
      if (u || span) {
        const closeTag = u ? "</u>" : "</span>";
        const open = (u ?? span)![0];
        const end = findTag(src, i + open.length, u ? "u" : "span");
        if (end > 0) {
          flush();
          const styles: Styles = { ...ctx.styles };
          if (u) styles.underline = true;
          else {
            const color = /color="([a-z]+)"/i.exec(span![1]!)?.[1];
            const bg = /bg="([a-z]+)"/i.exec(span![1]!)?.[1];
            if (color && (COLOR_NAMES as readonly string[]).includes(color)) styles.textColor = color;
            if (bg && (COLOR_NAMES as readonly string[]).includes(bg)) styles.backgroundColor = bg;
          }
          parseInlineInto(src.slice(i + open.length, end), out, { ...ctx, styles });
          i = end + closeTag.length;
          continue;
        }
      }
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest);
      if (auto) {
        flush();
        pushText(out, auto[1]!, { ...ctx, link: auto[1]! });
        i += auto[0].length;
        continue;
      }
    }
    const emph: [string, keyof Styles][] = [
      ["**", "bold"],
      ["__", "bold"],
      ["~~", "strike"],
      ["*", "italic"],
      ["_", "italic"],
    ];
    let matched = false;
    for (const [token, style] of emph) {
      if (!rest.startsWith(token)) continue;
      if (token === "_" || token === "__") {
        const before = src[i - 1];
        if (before && /[A-Za-z0-9]/.test(before)) continue;
      }
      const end = findClose(src, i + token.length, token);
      if (end > i + token.length) {
        if (token.startsWith("_") && src[end + token.length] && /[A-Za-z0-9]/.test(src[end + token.length]!)) continue;
        flush();
        parseInlineInto(src.slice(i + token.length, end), out, { ...ctx, styles: { ...ctx.styles, [style]: true } });
        i = end + token.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    buf += c;
    i++;
  }
  flush();
}

function findTag(src: string, from: number, tag: string): number {
  let depth = 0;
  const open = new RegExp(`^<${tag}[\\s>]`, "i");
  const close = `</${tag}>`;
  for (let i = from; i < src.length; i++) {
    if (open.test(src.slice(i, i + tag.length + 2))) depth++;
    else if (src.slice(i, i + close.length).toLowerCase() === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function decodeHref(href: string) {
  try {
    return href.replace(/%28|%29|%20/gi, (m) => decodeURIComponent(m));
  } catch {
    return href;
  }
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  parseInlineInto(src, out, { styles: {} });
  return out;
}

const ATTRS = /\s*\{((?:#[A-Za-z0-9_-]{1,64})?(?:\s*[A-Za-z]+=(?:"[^"]*"|[^\s}"]+))*)\}\s*$/;

function takeAttrs(line: string): { line: string; id?: string; props: Record<string, unknown> } {
  const m = ATTRS.exec(line);
  if (!m || !m[1]!.trim()) return { line, props: {} };
  const props: Record<string, unknown> = {};
  let id: string | undefined;
  const body = m[1]!;
  const idm = /^#([A-Za-z0-9_-]{1,64})/.exec(body.trim());
  if (idm) id = idm[1];
  for (const pm of body.matchAll(/([A-Za-z]+)=("[^"]*"|[^\s}"]+)/g)) {
    const raw = pm[2]!.startsWith('"') ? pm[2]!.slice(1, -1) : pm[2]!;
    props[pm[1]!] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return { line: line.slice(0, m.index), ...(id ? { id } : {}), props };
}

type Raw = { id?: string; type: string; props: Record<string, unknown>; content?: unknown; children: Raw[] };

type Line = { text: string; indent: number };

function toLines(md: string): Line[] {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n")
    .map((t) => {
      const indent = /^ */.exec(t)![0].length;
      return { text: t.slice(indent), indent };
    });
}

const blank = (l: Line | undefined) => !l || l.text.trim() === "";

class Parser {
  i = 0;
  constructor(readonly lines: Line[], readonly path: string) {}

  parse(base: number, stop?: (l: Line) => boolean): Raw[] {
    const out: Raw[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (blank(line)) {
        this.i++;
        continue;
      }
      if (line.indent < base) break;
      if (stop && stop(line)) break;
      const block = this.block(line, base);
      if (block) {
        if (Array.isArray(block)) out.push(...block);
        else out.push(block);
      }
    }
    return out;
  }

  childrenAt(indent: number): Raw[] {
    const save = this.i;
    while (this.i < this.lines.length && blank(this.lines[this.i])) this.i++;
    if (this.i < this.lines.length && this.lines[this.i]!.indent >= indent) return this.parse(indent);
    this.i = save;
    return [];
  }

  withAttrs(raw: Raw, text: string): string {
    const a = takeAttrs(text);
    if (a.id) raw.id = a.id;
    Object.assign(raw.props, a.props);
    return a.line;
  }

  block(line: Line, base: number): Raw | Raw[] | null {
    const t = line.text;
    const fence = /^(`{3,}|~{3,})\s*([^\s{]*)\s*(\{.*\})?\s*$/.exec(t);
    if (fence) {
      this.i++;
      const raw: Raw = { type: "codeBlock", props: {}, children: [] };
      if (fence[2]) raw.props.language = fence[2];
      if (fence[3]) this.withAttrs(raw, fence[3]);
      const body: string[] = [];
      const closer = new RegExp(`^\\${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      while (this.i < this.lines.length) {
        const l = this.lines[this.i]!;
        if (closer.test(l.text)) {
          this.i++;
          break;
        }
        body.push(" ".repeat(Math.max(0, l.indent - line.indent)) + l.text);
        this.i++;
      }
      raw.content = body.join("\n");
      return raw;
    }
    if (/^\$\$/.test(t)) {
      const raw: Raw = { type: "equation", props: {}, children: [] };
      const first = this.withAttrs(raw, t).slice(2);
      this.i++;
      if (first.trim().endsWith("$$") && first.trim().length > 2) {
        raw.content = first.trim().slice(0, -2);
        return raw;
      }
      const body: string[] = first.trim() ? [first] : [];
      while (this.i < this.lines.length) {
        const l = this.lines[this.i]!;
        this.i++;
        if (l.text.trim() === "$$") break;
        body.push(l.text);
      }
      raw.content = body.join("\n");
      return raw;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*(\{.*\})?$/.test(t)) {
      this.i++;
      const raw: Raw = { type: "divider", props: {}, children: [] };
      this.withAttrs(raw, t);
      return raw;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t);
    if (heading) {
      this.i++;
      const raw: Raw = { type: "heading", props: { level: Math.min(4, heading[1]!.length) }, children: [] };
      raw.content = parseInline(this.withAttrs(raw, heading[2]!.replace(/\s+#+\s*$/, "")));
      raw.children = this.childrenAt(line.indent + 2);
      return raw;
    }
    if (/^<details>/i.test(t)) return this.details(line);
    if (/^:::columns\b/.test(t)) return this.columns(line);
    const directive = /^::([a-z]+)(?:\[([^\]]*)\])?(?:\(([^)]*)\))?\s*(\{.*\})?\s*$/.exec(t);
    if (directive && (DIRECTIVES as readonly string[]).includes(directive[1]!)) {
      this.i++;
      const type = DIRECTIVE_TYPE[directive[1]!]!;
      const raw: Raw = { type, props: {}, children: [] };
      if (directive[4]) this.withAttrs(raw, directive[4]);
      const label = directive[2] ?? "";
      const target = decodeHref((directive[3] ?? "").trim());
      if (type === "subpage" || type === "linkToPage") raw.props.pageId = target;
      else if (type === "database") raw.props.database = target;
      else if (type === "bookmark" || type === "embed") raw.props.url = target;
      else if (type === "video" || type === "audio" || type === "file" || type === "image") {
        raw.props.url = target;
        if (label) raw.props[type === "file" ? "name" : "caption"] = label;
      }
      return raw;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)\s*(\{.*\})?\s*$/.exec(t);
    if (image) {
      this.i++;
      const raw: Raw = { type: "image", props: { url: decodeHref(image[2]!) }, children: [] };
      if (image[3] || image[1]) raw.props.caption = image[3] ?? image[1];
      if (image[4]) this.withAttrs(raw, image[4]);
      return raw;
    }
    if (t.startsWith(">")) return this.quote(line);
    const list = /^([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(t) ?? (/^([-*+])$/.test(t) ? [t, t, ""] : null);
    if (list) return this.listItem(line, list[1]!, list[2] ?? "");
    if (t.startsWith("|") && this.lines[this.i + 1] && /^\|?\s*:?-{2,}/.test(this.lines[this.i + 1]!.text)) return this.table(line);
    if (t === "&nbsp;") {
      this.i++;
      return { type: "paragraph", props: {}, content: "", children: this.childrenAt(line.indent + 2) };
    }
    return this.paragraph(line, base);
  }

  paragraph(line: Line, base: number): Raw {
    const texts: string[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (blank(l) || l.indent !== line.indent) break;
      if (texts.length && this.startsBlock(l.text)) break;
      texts.push(l.text);
      this.i++;
    }
    const raw: Raw = { type: "paragraph", props: {}, children: [] };
    const joined = texts.map((x, k) => (k === texts.length - 1 ? x : x.replace(/(\\| {2,})$/, ""))).join("\n");
    raw.content = parseInline(this.withAttrs(raw, joined));
    raw.children = this.childrenAt(Math.max(base, line.indent) + 2);
    return raw;
  }

  startsBlock(t: string) {
    return /^(#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|```|~~~|\$\$|<details>|:::|::[a-z]+|!\[|\||-{3,}\s*$)/i.test(t);
  }

  listItem(line: Line, marker: string, first: string): Raw {
    this.i++;
    const numbered = /\d/.test(marker);
    const check = !numbered ? /^\[([ xX])\]\s?(.*)$/.exec(first) : null;
    const raw: Raw = { type: numbered ? "numberedListItem" : check ? "checkListItem" : "bulletListItem", props: {}, children: [] };
    if (check) raw.props.checked = check[1] !== " ";
    if (numbered) raw.props.__number = parseInt(marker, 10);
    const pad = line.indent + marker.length + 1;
    const texts = [check ? check[2]! : first];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (blank(l) || l.indent < pad || this.startsBlock(l.text)) break;
      if (l.indent >= pad + 2) break;
      texts.push(l.text);
      this.i++;
    }
    raw.content = parseInline(this.withAttrs(raw, texts.join("\n")));
    raw.children = this.childrenAt(Math.min(pad, line.indent + 2));
    return raw;
  }

  quote(line: Line): Raw {
    const texts: string[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (l.indent !== line.indent || !l.text.startsWith(">")) break;
      texts.push(l.text.replace(/^>\s?/, ""));
      this.i++;
    }
    let body = texts.join("\n");
    const raw: Raw = { type: "quote", props: {}, children: [] };
    const alert = /^\[!([^\]\s]{1,16})\]\s?/.exec(body);
    if (alert) {
      raw.type = "callout";
      raw.props.icon = ALERTS[alert[1]!.toUpperCase()] ?? alert[1]!;
      body = body.slice(alert[0].length);
    }
    raw.content = parseInline(this.withAttrs(raw, body));
    raw.children = this.childrenAt(line.indent + 2);
    return raw;
  }

  details(line: Line): Raw {
    const m = /^<details>\s*(?:<summary>(.*?)<\/summary>)?(.*)$/i.exec(line.text)!;
    this.i++;
    let summary = m[1] ?? "";
    if (!m[1]) {
      const next = this.lines[this.i];
      const s = next ? /^<summary>(.*?)<\/summary>\s*$/i.exec(next.text) : null;
      if (s) {
        summary = s[1]!;
        this.i++;
      }
    }
    const raw: Raw = { type: "toggleListItem", props: {}, children: [] };
    const heading = /^(#{1,4})\s+(.*)$/.exec(summary);
    if (heading) {
      raw.type = "heading";
      raw.props.level = heading[1]!.length;
      raw.props.isToggleable = true;
      summary = heading[2]!;
    }
    raw.content = parseInline(this.withAttrs(raw, summary));
    raw.children = this.parse(line.indent, (l) => /^<\/details>/i.test(l.text) && l.indent === line.indent);
    if (this.i < this.lines.length && /^<\/details>/i.test(this.lines[this.i]!.text)) this.i++;
    return raw;
  }

  columns(line: Line): Raw {
    const raw: Raw = { type: "columnList", props: {}, children: [] };
    this.withAttrs(raw, line.text.slice(9));
    this.i++;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (blank(l)) {
        this.i++;
        continue;
      }
      if (l.text.trim() === ":::") {
        this.i++;
        break;
      }
      if (/^:::column\b/.test(l.text)) {
        const column: Raw = { type: "column", props: {}, children: [] };
        this.withAttrs(column, l.text.slice(8));
        this.i++;
        column.children = this.parse(0, (x) => x.text.trim() === ":::" || /^:::column\b/.test(x.text));
        if (this.i < this.lines.length && this.lines[this.i]!.text.trim() === ":::") this.i++;
        raw.children.push(column);
        continue;
      }
      throw new ToolError(`${this.path}: line ${this.i + 1} is inside :::columns but isn't a :::column.`);
    }
    return raw;
  }

  table(line: Line): Raw {
    const split = (t: string) => {
      const cells: string[] = [];
      let cur = "";
      const body = t.trim().replace(/^\|/, "").replace(/\|$/, "");
      for (let k = 0; k < body.length; k++) {
        if (body[k] === "\\" && body[k + 1] === "|") {
          cur += "|";
          k++;
        } else if (body[k] === "|") {
          cells.push(cur.trim());
          cur = "";
        } else cur += body[k];
      }
      cells.push(cur.trim());
      return cells;
    };
    const rows: string[][] = [split(line.text)];
    this.i += 2;
    while (this.i < this.lines.length && this.lines[this.i]!.text.startsWith("|")) rows.push(split(this.lines[this.i++]!.text));
    const raw: Raw = { type: "table", props: {}, children: [] };
    let headerRows = 1;
    let headerCols = 0;
    const next = this.lines[this.i];
    if (next && /^\{[^}]*\}\s*$/.test(next.text.trim())) {
      const a = takeAttrs(` ${next.text.trim()}`);
      if (a.id) raw.id = a.id;
      for (const [k, v] of Object.entries(a.props)) {
        if (k === "headerRows" && typeof v === "number") headerRows = v;
        else if (k === "headerCols" && typeof v === "number") headerCols = v;
        else raw.props[k] = v;
      }
      this.i++;
    }
    raw.content = { type: "tableContent", headerRows, headerCols, rows: rows.map((r) => ({ cells: r.map((c) => parseInline(c)) })) };
    return raw;
  }
}

function finish(raws: Raw[]): unknown[] {
  let prevNumber: number | null = null;
  return raws.map((r) => {
    const props = { ...r.props };
    if (r.type === "numberedListItem") {
      const n = props.__number as number;
      delete props.__number;
      if (prevNumber === null && n !== 1 && props.start === undefined) props.start = n;
      prevNumber = n;
    } else prevNumber = null;
    const out: Record<string, unknown> = { type: r.type, props, children: finish(r.children) };
    if (r.id) out.id = r.id;
    if (r.content !== undefined) out.content = r.content;
    return out;
  });
}

export function markdownToBlocks(md: string, path = "markdown"): Block[] {
  if (md.length > 900_000) throw new ToolError(`${path} is longer than 900000 characters.`);
  const parser = new Parser(toLines(md), path);
  const raws = parser.parse(0);
  const budget = { blocks: 0, ids: new Set<string>() };
  return finish(raws).map((item, i) => {
    try {
      return cleanBlock(item, `${path} block ${i + 1}`, { budget });
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(`${path} block ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

export function titleFromMarkdown(blocks: Block[]): { title: string; icon: string } | null {
  const first = blocks[0];
  if (!first || first.type !== "heading" || first.props.level !== 1 || first.children.length) return null;
  const text = Array.isArray(first.content) ? (first.content as Inline[]).map((i) => (i.type === "text" ? i.text : i.type === "link" ? i.content.map((t) => t.text).join("") : "")).join("") : "";
  const m = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s+(.*)$/u.exec(text);
  return m ? { icon: m[1]!, title: m[2]! } : { icon: "", title: text };
}

export const MARKDOWN_GUIDE = {
  blocks: {
    paragraph: "plain lines; consecutive lines are one paragraph with line breaks; a blank line starts a new block",
    heading: "# H1, ## H2, ### H3 (#### and deeper become H3)",
    bulletListItem: "- item (nest by indenting 2 spaces)",
    numberedListItem: "1. item",
    checkListItem: "- [ ] to do / - [x] done",
    toggleListItem: "<details><summary>Title</summary> … blocks … </details>",
    toggleHeading: "<details><summary>## Title</summary> … </details>",
    quote: "> text",
    callout: "> [!💡] text  (also GitHub alerts > [!NOTE], [!TIP], [!WARNING], [!IMPORTANT], [!CAUTION])",
    codeBlock: "```language … ``` (mermaid for diagrams)",
    equation: "$$ … $$ on their own lines",
    divider: "---",
    table: "GFM pipe table; the first row is the header; a line {headerRows=0 headerCols=1} right after the table changes that",
    image: "![caption](url)",
    media: "::video[caption](url), ::audio[caption](url), ::file[name](url), ::bookmark(url), ::embed(url)",
    pages: "::page[Title](<pageId>) child page block, ::link[Title](<pageId>) link to page, ::database[Title](<databaseId>) inline database",
    other: "::toc, ::breadcrumb",
    columns: ":::columns / :::column {width=1} … ::: / ::: (each ::: closes the innermost)",
    attributes: "end a block's first line with {#blockId key=value …} to keep a block id or set props (textColor=red backgroundColor=yellow textAlignment=center isToggleable=true)",
    children: "indent child blocks by 2 spaces (or the list marker width) under their parent",
  },
  inline: {
    bold: "**text**",
    italic: "*text* or _text_",
    strike: "~~text~~",
    underline: "<u>text</u>",
    code: "`text`",
    color: '<span color="red" bg="yellow">text</span> with colours ' + COLOR_NAMES.join(", "),
    link: "[text](https://…)",
    pageMention: "@page(<pageId>) or [@Title](ardia://notes/<slug>-<pageId>)",
    userMention: "@user(Name) or @user(Name #rrggbb)",
    dateMention: "@date(YYYY-MM-DD)",
    inlineEquation: "$x^2$",
    lineBreak: "a new line inside a paragraph, or <br>",
    escape: "backslash before a markdown character: \\*",
  },
};

export function defaultBlockFor(type: string): Block {
  return cleanBlock({ type, ...(BLOCKS[type]?.content === "table" ? {} : {}) }, "block");
}

export { newBlockId };
