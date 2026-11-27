import { parseHtml } from "./html";
import { isExternal, safeUrl, type Block, type Inline, type Marks } from "./ir";

export type MarkdownOptions = { wikilinks?: boolean; hardBreaks?: boolean; fileLink?: (url: string) => boolean };

const CALLOUT_ICONS: Record<string, string> = {
  note: "📝",
  abstract: "📋",
  summary: "📋",
  tldr: "📋",
  info: "ℹ️",
  todo: "☑️",
  tip: "💡",
  hint: "💡",
  important: "❗",
  success: "✅",
  check: "✅",
  done: "✅",
  question: "❓",
  help: "❓",
  faq: "❓",
  warning: "⚠️",
  caution: "⚠️",
  attention: "⚠️",
  failure: "❌",
  fail: "❌",
  missing: "❌",
  danger: "⛔",
  error: "⛔",
  bug: "🐞",
  example: "🧪",
  quote: "💬",
  cite: "💬",
};

export const calloutIcon = (kind: string) => CALLOUT_ICONS[kind.toLowerCase()] ?? "💡";

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: parseYaml(m[1]!), body: text.slice(m[0].length) };
}

function yamlScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"');
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (v === "true" || v === "false") return v === "true";
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v))
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => yamlScalar(s))
      .filter((s) => s !== "");
  return v;
}

export function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  let list: unknown[] | null = null;
  for (const line of text.split(/\r?\n/).slice(0, 500)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s*(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && list) {
      list.push(yamlScalar(item[1]!));
      continue;
    }
    const kv = /^([^:\s][^:]{0,120}):(?:\s+(.*))?$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.trim();
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const value = kv[2] ?? "";
    if (value.trim() === "") {
      list = [];
      out[key] = list;
    } else {
      list = null;
      out[key] = yamlScalar(value);
    }
  }
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v) && v.length === 0) out[k] = "";
  return out;
}

const addMark = (marks: Marks | undefined, extra: Marks): Marks => ({ ...(marks ?? {}), ...extra });

function pushText(out: Inline[], text: string, marks?: Marks) {
  if (!text) return;
  const last = out.at(-1);
  if (last && last.t === "text" && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks ?? {})) last.text += text;
  else out.push(marks && Object.keys(marks).length ? { t: "text", text, marks } : { t: "text", text });
}

function findClose(text: string, from: number, delim: string): number {
  for (let i = from; i <= text.length - delim.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (text.startsWith(delim, i) && i > from && !/\s/.test(text[i - 1]!)) {
      if (delim.length === 1 && text[i + 1] === delim) {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function matchingBracket(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

function linkTarget(text: string, at: number): { url: string; end: number } | null {
  if (text[at] !== "(") return null;
  if (text[at + 1] === "<") {
    const close = text.indexOf(">", at + 2);
    if (close < 0) return null;
    const end = text.indexOf(")", close);
    return end < 0 ? null : { url: text.slice(at + 2, close), end };
  }
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) {
      const inner = text.slice(at + 1, i).trim();
      const url = inner.replace(/\s+("[^"]*"|'[^']*')$/, "");
      return { url, end: i };
    }
  }
  return null;
}

export type InlineContext = { wikilinks?: boolean; images?: Block[]; fileLink?: (url: string) => boolean };

const decodeTarget = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const linkPath = (raw: string) => decodeTarget(raw.replace(/[?#].*$/, ""));

const LOCAL_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico|pdf|mp3|wav|m4a|aac|ogg|flac|mp4|m4v|mov|webm|mkv|avi|zip|rar|7z|gz|tar|docx?|rtf|odt|xlsx?|ods|pptx?|odp|key|pages|numbers|epub|json|xml|ya?ml|log|excalidraw|sketch|fig|psd|ai)$/i;

export const isLocalFileLink = (url: string) => LOCAL_FILE.test(linkPath(url));

export function parseInline(text: string, ctx: InlineContext = {}, marks?: Marks, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth > 12) {
    pushText(out, text, marks);
    return out;
  }
  let i = 0;
  let plain = "";
  const flush = () => {
    pushText(out, plain, marks);
    plain = "";
  };
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);
    if (c === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        pushText(out, text.slice(i + ticks.length, end).replace(/^ (.+) $/, "$1"), addMark(marks, { code: true }));
        i = end + ticks.length;
        continue;
      }
    }
    if (c === "$" && text[i + 1] !== "$" && text[i + 1] !== " ") {
      const end = text.indexOf("$", i + 1);
      if (end > i + 1 && text[end - 1] !== " " && !/\d/.test(text[end + 1] ?? "")) {
        flush();
        out.push({ t: "math", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ctx.wikilinks && rest.startsWith("![[")) {
      const end = text.indexOf("]]", i + 3);
      if (end > 0) {
        flush();
        const [target = "", alias] = text.slice(i + 3, end).split("|");
        ctx.images?.push({ type: "image", src: `wiki:${target.trim()}`, props: alias && !/^\d+(x\d+)?$/.test(alias) ? { caption: alias.trim() } : {} });
        i = end + 2;
        continue;
      }
    }
    if (ctx.wikilinks && rest.startsWith("[[")) {
      const end = text.indexOf("]]", i + 2);
      if (end > 0) {
        flush();
        const inner = text.slice(i + 2, end);
        const bar = inner.indexOf("|");
        const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
        const label = (bar >= 0 ? inner.slice(bar + 1) : target.replace(/#.*$/, "")).trim();
        out.push({ t: "ref", target: `wiki:${target}`, text: label || target, ...(marks ? { marks } : {}) });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("![")) {
      const close = matchingBracket(text, i + 1);
      const target = close > 0 ? linkTarget(text, close + 1) : null;
      if (target) {
        flush();
        ctx.images?.push({ type: "image", src: target.url.trim(), props: { caption: text.slice(i + 2, close) } });
        i = target.end + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = matchingBracket(text, i);
      const target = close > 0 ? linkTarget(text, close + 1) : null;
      if (target) {
        flush();
        const label = text.slice(i + 1, close);
        const url = target.url.trim();
        if (isExternal(url)) {
          const safe = safeUrl(url);
          for (const part of parseInline(label, ctx, safe ? addMark(marks, { link: safe }) : marks, depth + 1)) out.push(part);
        } else if (url.startsWith("#") || !url) {
          for (const part of parseInline(label, ctx, marks, depth + 1)) out.push(part);
        } else if (ctx.images && (ctx.fileLink ?? isLocalFileLink)(url)) {
          const name = label.replace(/[*_`]/g, "").trim();
          const alone = depth === 0 && !text.slice(0, i).trim() && !text.slice(target.end + 1).trim();
          if (!alone && name) pushText(out, name, marks);
          const base = linkPath(url).split("/").pop() ?? "";
          ctx.images.push({ type: "file", src: url, props: name && name !== base ? { caption: name } : {} });
        } else out.push({ t: "ref", target: `path:${linkPath(url)}`, text: label.replace(/[*_`]/g, ""), ...(marks ? { marks } : {}) });
        i = target.end + 1;
        continue;
      }
    }
    if (c === "<") {
      const auto = /^<((?:https?|mailto):[^\s>]+)>/i.exec(rest);
      if (auto) {
        flush();
        const safe = safeUrl(auto[1]!);
        pushText(out, auto[1]!, safe ? addMark(marks, { link: safe }) : marks);
        i += auto[0].length;
        continue;
      }
      const tag = /^<(\/?)(b|strong|i|em|u|s|del|strike|mark|code|br|sup|sub|span|font)\b[^>]*?(\/?)>/i.exec(rest);
      if (tag) {
        const name = tag[2]!.toLowerCase();
        if (name === "br") {
          flush();
          out.push({ t: "break" });
          i += tag[0].length;
          continue;
        }
        if (tag[1]) {
          i += tag[0].length;
          continue;
        }
        const closeTag = new RegExp(`</${name}\\s*>`, "i").exec(text.slice(i + tag[0].length));
        if (closeTag) {
          flush();
          const inner = text.slice(i + tag[0].length, i + tag[0].length + closeTag.index);
          const mark: Marks =
            name === "b" || name === "strong" ? { bold: true } : name === "i" || name === "em" ? { italic: true } : name === "u" ? { underline: true } : name === "mark" ? { highlight: true } : name === "code" ? { code: true } : name === "s" || name === "del" || name === "strike" ? { strike: true } : {};
          for (const part of parseInline(inner, ctx, addMark(marks, mark), depth + 1)) out.push(part);
          i += tag[0].length + closeTag.index + closeTag[0].length;
          continue;
        }
      }
    }
    const pairs: [string, Marks][] = [
      ["**", { bold: true }],
      ["__", { bold: true }],
      ["~~", { strike: true }],
      ["==", { highlight: true }],
      ["*", { italic: true }],
      ["_", { italic: true }],
    ];
    let matched = false;
    for (const [delim, mark] of pairs) {
      if (!rest.startsWith(delim) || /\s/.test(text[i + delim.length] ?? " ")) continue;
      if (delim === "_" || delim === "__") {
        const before = text[i - 1];
        if (before && /[A-Za-z0-9]/.test(before)) continue;
      }
      const end = findClose(text, i + delim.length, delim);
      if (end < 0) continue;
      if ((delim === "_" || delim === "__") && /[A-Za-z0-9]/.test(text[end + delim.length] ?? "")) continue;
      flush();
      for (const part of parseInline(text.slice(i + delim.length, end), ctx, addMark(marks, mark), depth + 1)) out.push(part);
      i = end + delim.length;
      matched = true;
      break;
    }
    if (matched) continue;
    const bare = /^https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/.exec(rest);
    if (bare && !/[A-Za-z0-9]/.test(text[i - 1] ?? "")) {
      flush();
      const safe = safeUrl(bare[0]);
      pushText(out, bare[0], safe ? addMark(marks, { link: safe }) : marks);
      i += bare[0].length;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

type Line = { indent: number; text: string };

const indentOf = (line: string) => {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
};

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX\-/])\]\s+(.*)$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)?.*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const splitRow = (line: string) => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
};

export function parseMarkdown(source: string, options: MarkdownOptions = {}): Block[] {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^[\t ]+/, (ws) => ws.replace(/\t/g, "    ")));
  return new BlockParser(lines, options).blocks(0, lines.length, 0);
}

class BlockParser {
  constructor(private readonly lines: string[], private readonly options: MarkdownOptions) {}

  private inline(text: string, extra: Block[]): Inline[] {
    const images: Block[] = [];
    const parts: Inline[] = [];
    const rows = text.split("\n");
    rows.forEach((row, n) => {
      const line = this.options.hardBreaks ? row : row.replace(/(\s{2,}|\\)$/, "\u0000");
      const hard = line.endsWith("\u0000");
      for (const part of parseInline(hard ? line.slice(0, -1) : line, { wikilinks: this.options.wikilinks, images, ...(this.options.fileLink ? { fileLink: this.options.fileLink } : {}) })) parts.push(part);
      if (n < rows.length - 1) {
        if (hard || this.options.hardBreaks) parts.push({ t: "break" });
        else parts.push({ t: "text", text: " " });
      }
    });
    for (const img of images) extra.push(img);
    return parts;
  }

  private withImages(block: Block, images: Block[], out: Block[]) {
    const empty = (block.content ?? []).every((p) => p.t === "text" && !p.text.trim());
    if (!(empty && images.length && block.type === "paragraph")) out.push(block);
    for (const img of images) out.push(img);
  }

  blocks(from: number, to: number, depth: number): Block[] {
    const out: Block[] = [];
    if (depth > 24) {
      out.push({ type: "paragraph", content: [{ t: "text", text: this.lines.slice(from, to).join("\n") }] });
      return out;
    }
    let i = from;
    while (i < to) {
      const line = this.lines[i]!;
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const marker = fence[2]!;
        let end = i + 1;
        while (end < to && !this.lines[end]!.trim().startsWith(marker[0]!.repeat(marker.length))) end++;
        const body = this.lines
          .slice(i + 1, end)
          .map((l) => l.slice(Math.min(indentOf(l), fence[1]!.length)))
          .join("\n");
        const lang = (fence[3] ?? "").toLowerCase();
        if (lang === "math" || lang === "latex") out.push({ type: "equation", text: body });
        else out.push({ type: "codeBlock", text: body, props: { language: lang || "text" } });
        i = end + 1;
        continue;
      }
      if (line.trim() === "$$" || (line.trim().startsWith("$$") && !line.trim().endsWith("$$"))) {
        let end = i + 1;
        while (end < to && !this.lines[end]!.trim().endsWith("$$")) end++;
        const first = line.trim().slice(2);
        const last = end < to ? this.lines[end]!.trim().slice(0, -2) : "";
        out.push({ type: "equation", text: [first, ...this.lines.slice(i + 1, end), last].filter((s) => s.trim()).join("\n") });
        i = end + 1;
        continue;
      }
      const oneLineMath = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (oneLineMath) {
        out.push({ type: "equation", text: oneLineMath[1]!.trim() });
        i++;
        continue;
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const extra: Block[] = [];
        const block: Block = { type: "heading", props: { level: Math.min(3, heading[1]!.length) }, content: this.inline(heading[2]!, extra) };
        this.withImages(block, extra, out);
        i++;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push({ type: "divider" });
        i++;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        let end = i;
        while (end < to && /^\s{0,3}>/.test(this.lines[end]!)) end++;
        const inner = this.lines.slice(i, end).map((l) => l.replace(/^\s{0,3}>\s?/, ""));
        const callout = /^\[!([A-Za-z-]+)\][+-]?\s*(.*)$/.exec(inner[0] ?? "");
        const sub = new BlockParser(inner, this.options);
        if (callout) {
          const extra: Block[] = [];
          const title = callout[2]!.trim();
          const body = sub.blocks(1, inner.length, depth + 1);
          const content = title ? this.inline(title, extra) : [{ t: "text" as const, text: callout[1]!.charAt(0).toUpperCase() + callout[1]!.slice(1).toLowerCase() }];
          if (!title && body[0]?.type === "paragraph") {
            const first = body.shift()!;
            out.push({ type: "callout", props: { icon: calloutIcon(callout[1]!) }, content: first.content ?? [], children: [...extra, ...body] });
          } else out.push({ type: "callout", props: { icon: calloutIcon(callout[1]!) }, content, children: [...extra, ...body] });
        } else {
          const body = sub.blocks(0, inner.length, depth + 1);
          const first = body[0];
          if (first && first.type === "paragraph" && body.length === 1) out.push({ type: "quote", content: first.content ?? [] });
          else if (first && first.type === "paragraph") out.push({ type: "quote", content: first.content ?? [], children: body.slice(1) });
          else for (const b of body) out.push(b.type === "paragraph" ? { ...b, type: "quote" } : b);
        }
        i = end;
        continue;
      }
      if (line.includes("|") && i + 1 < to && TABLE_SEP.test(this.lines[i + 1]!)) {
        const rows: string[][] = [splitRow(line)];
        let end = i + 2;
        while (end < to && this.lines[end]!.includes("|") && this.lines[end]!.trim()) rows.push(splitRow(this.lines[end++]!));
        const width = Math.min(64, Math.max(...rows.map((r) => r.length)));
        const extra: Block[] = [];
        out.push({ type: "table", rows: rows.slice(0, 2000).map((r) => Array.from({ length: width }, (_, n) => this.inline(r[n] ?? "", extra))), props: { header: true } });
        for (const b of extra) out.push(b);
        i = end;
        continue;
      }
      const list = LIST.exec(line);
      if (list) {
        i = this.list(i, to, depth, out);
        continue;
      }
      if (/^\s*<(details|aside|div|table|p|ul|ol|h[1-6]|figure|blockquote|pre|img|hr|script|style|iframe|object|embed|noscript|template|svg|form)\b/i.test(line)) {
        let end = i + 1;
        const tag = /^\s*<([a-z0-9]+)/i.exec(line)![1]!.toLowerCase();
        const selfClosing = tag === "img" || tag === "hr" || tag === "embed" || new RegExp(`</${tag}>\\s*$`, "i").test(line);
        if (!selfClosing) {
          let open = 0;
          for (end = i; end < to; end++) {
            const l = this.lines[end]!;
            open += (l.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length - (l.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
            if (open <= 0) {
              end++;
              break;
            }
          }
        }
        for (const b of parseHtml(this.lines.slice(i, end).join("\n"), { markdownInside: true, wikilinks: this.options.wikilinks })) out.push(b);
        i = Math.max(end, i + 1);
        continue;
      }
      let end = i + 1;
      while (end < to) {
        const next = this.lines[end]!;
        if (!next.trim() || FENCE.test(next) || /^\s{0,3}(#{1,6}\s|>)/.test(next) || LIST.test(next) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(next)) break;
        if (/^\s{0,3}(=+|-+)\s*$/.test(next)) break;
        end++;
      }
      const setext = end < to ? /^\s{0,3}(=+|-+)\s*$/.exec(this.lines[end]!) : null;
      const extra: Block[] = [];
      const text = this.lines
        .slice(i, end)
        .map((l) => l.replace(/^\s+/, ""))
        .join("\n");
      if (setext && end - i >= 1) {
        this.withImages({ type: "heading", props: { level: setext[1]![0] === "=" ? 1 : 2 }, content: this.inline(text, extra) }, extra, out);
        i = end + 1;
      } else {
        this.withImages({ type: "paragraph", content: this.inline(text, extra) }, extra, out);
        i = end;
      }
    }
    return out;
  }

  private list(from: number, to: number, depth: number, out: Block[]): number {
    const first = LIST.exec(this.lines[from]!)!;
    const base = indentOf(first[1]!);
    let i = from;
    while (i < to) {
      const m = LIST.exec(this.lines[i]!);
      if (!m || indentOf(m[1]!) !== base) break;
      const marker = m[2]!;
      const contentIndent = indentOf(m[1]!) + marker.length + 1;
      const bodyLines = [m[3]!];
      let end = i + 1;
      while (end < to) {
        const l = this.lines[end]!;
        if (!l.trim()) {
          const next = this.lines[end + 1];
          if (next !== undefined && next.trim() && indentOf(next) > base) {
            bodyLines.push("");
            end++;
            continue;
          }
          break;
        }
        const ind = indentOf(l);
        if (ind <= base) break;
        bodyLines.push(l.slice(Math.min(ind, contentIndent)));
        end++;
      }
      const head: string[] = [];
      let k = 0;
      while (k < bodyLines.length && bodyLines[k]!.trim() && !LIST.test(bodyLines[k]!) && !FENCE.test(bodyLines[k]!) && (k === 0 || indentOf(bodyLines[k]!) === 0)) head.push(bodyLines[k++]!);
      const extra: Block[] = [];
      const task = TASK.exec(head[0] ?? "");
      let text = head.join("\n");
      let type: Block["type"] = /^\d/.test(marker) ? "numberedListItem" : "bulletListItem";
      const props: Record<string, string | number | boolean> = {};
      if (task) {
        type = "checkListItem";
        props.checked = task[1] !== " ";
        text = [task[2]!, ...head.slice(1)].join("\n");
      }
      const children = new BlockParser(bodyLines, this.options).blocks(k, bodyLines.length, depth + 1);
      out.push({ type, ...(Object.keys(props).length ? { props } : {}), content: this.inline(text, extra), children: [...extra, ...children] });
      i = end;
    }
    return i;
  }
}
