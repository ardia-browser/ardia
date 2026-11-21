import { pluginWebUrl } from "./pluginWebUrl";

export type MarkdownSpan = { text: string; bold?: boolean; italic?: boolean; code?: boolean; url?: string };

export type MarkdownListItem = { marker: string; depth: number; spans: MarkdownSpan[] };

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: MarkdownSpan[] }
  | { kind: "paragraph"; spans: MarkdownSpan[] }
  | { kind: "code"; text: string; language?: string }
  | { kind: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  | { kind: "rule" };

type SpanStyle = Omit<MarkdownSpan, "text">;

const INLINE_START = /[\\`[*_]/g;
const ESCAPABLE = "\\`*_[]()#>!+.-";
const LINK_TAIL = /\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/y;
const LINE_END = /[\n\r\u2028\u2029]/g;
const SPACE = /\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const MAX_DEPTH = 4;
const MAX_INLINE_DEPTH = 16;

export function markdownLink(raw: string): string | undefined {
  const checked = pluginWebUrl(raw);
  return "url" in checked ? checked.url : undefined;
}

type InlineToken = { end: number; text: string; extra: SpanStyle; nested: boolean; href?: string };

function forwardSearch(find: (from: number) => number) {
  let asked = -1;
  let found = -1;
  return (from: number) => {
    if (asked >= 0 && from >= asked && (found === -1 || found >= from)) return found;
    asked = from;
    found = find(from);
    return found;
  };
}

function inlineScanner(source: string) {
  const charAfter = (char: string) => forwardSearch((from) => source.indexOf(char, from));
  const doubledClose = (mark: string) =>
    forwardSearch((from) => {
      for (let at = source.indexOf(mark + mark, from); at !== -1; at = source.indexOf(mark + mark, at + 1)) if (source[at + 2] !== mark) return at;
      return -1;
    });
  const nextTick = charAfter("`");
  const nextBracket = charAfter("]");
  const nextStar = charAfter("*");
  const strongClose = { "*": doubledClose("*"), _: doubledClose("_") };
  const nextLineEnd = forwardSearch((from) => {
    LINE_END.lastIndex = from;
    return LINE_END.exec(source)?.index ?? -1;
  });
  const tails = new Map<number, RegExpExecArray | null>();
  const tailAt = (at: number) => {
    if (!tails.has(at)) {
      LINK_TAIL.lastIndex = at;
      tails.set(at, LINK_TAIL.exec(source));
    }
    return tails.get(at)!;
  };
  const isSpace = (char: string | undefined) => char === undefined || SPACE.test(char);

  const doubled = (at: number, mark: "*" | "_"): InlineToken | null => {
    if (source[at + 1] !== mark) return null;
    const close = strongClose[mark](at + 3);
    if (close === -1) return null;
    const lineEnd = nextLineEnd(at + 2);
    if (lineEnd !== -1 && lineEnd < close) return null;
    return { end: close + 2, text: source.slice(at + 2, close), extra: { bold: true }, nested: true };
  };

  return (at: number): InlineToken | null => {
    const char = source[at];
    if (char === "\\") {
      const next = source[at + 1];
      return next !== undefined && ESCAPABLE.includes(next) ? { end: at + 2, text: next, extra: {}, nested: false } : null;
    }
    if (char === "`") {
      const close = nextTick(at + 1);
      return close > at + 1 ? { end: close + 1, text: source.slice(at + 1, close), extra: { code: true }, nested: false } : null;
    }
    if (char === "[") {
      const close = nextBracket(at + 1);
      if (close <= at + 1) return null;
      const tail = tailAt(close + 1);
      return tail ? { end: close + 1 + tail[0].length, text: source.slice(at + 1, close), extra: {}, nested: true, href: tail[1]! } : null;
    }
    if (char === "_") return doubled(at, "_");
    if (char !== "*") return null;
    const strong = doubled(at, "*");
    if (strong) return strong;
    if (isSpace(source[at + 1]) || source[at + 1] === "*") return null;
    const close = nextStar(at + 2);
    if (close === -1 || isSpace(source[close - 1])) return null;
    return { end: close + 1, text: source.slice(at + 1, close), extra: { italic: true }, nested: true };
  };
}

export function parseInline(source: string, style: SpanStyle = {}, depth = 0): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  const push = (text: string, extra: SpanStyle = {}) => {
    if (!text) return;
    const next: MarkdownSpan = { text };
    if (extra.bold ?? style.bold) next.bold = true;
    if (extra.italic ?? style.italic) next.italic = true;
    if (extra.code ?? style.code) next.code = true;
    const url = extra.url ?? style.url;
    if (url) next.url = url;
    const last = spans[spans.length - 1];
    if (last && last.bold === next.bold && last.italic === next.italic && last.code === next.code && last.url === next.url) last.text += text;
    else spans.push(next);
  };
  const tokenAt = inlineScanner(source);
  const starts = new RegExp(INLINE_START);
  let textFrom = 0;
  for (let found = starts.exec(source); found; found = starts.exec(source)) {
    const token = tokenAt(found.index);
    if (!token) continue;
    push(source.slice(textFrom, found.index));
    if (!token.nested) push(token.text, token.extra);
    else if (depth >= MAX_INLINE_DEPTH) push(token.text, token.href === undefined ? token.extra : { url: style.url ?? markdownLink(token.href) });
    else {
      const inner = token.href === undefined ? { ...style, ...token.extra } : { ...style, url: style.url ?? markdownLink(token.href) };
      for (const span of parseInline(token.text, inner, depth + 1)) push(span.text, span);
    }
    textFrom = starts.lastIndex = token.end;
  }
  push(source.slice(textFrom));
  return spans;
}

const indentOf = (lead: string) => Math.min(MAX_DEPTH, Math.floor(lead.replace(/\t/g, "    ").length / 2));

function listMatch(line: string) {
  const bullet = BULLET.exec(line);
  if (bullet) return { ordered: false, depth: indentOf(bullet[1]!), marker: "•", text: bullet[3]! };
  const ordered = ORDERED.exec(line);
  if (ordered) return { ordered: true, depth: indentOf(ordered[1]!), marker: `${Number(ordered[2])}.`, text: ordered[3]! };
  return null;
}

function startsBlock(line: string, quotes: boolean): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || (quotes && QUOTE.test(line)) || listMatch(line) !== null;
}

export function parseMarkdown(source: string, depth = 0): MarkdownBlock[] {
  const quotes = depth < MAX_DEPTH;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (!line.trim()) {
      at++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      at++;
      while (at < lines.length && !close.test(lines[at]!)) body.push(lines[at++]!);
      at++;
      blocks.push({ kind: "code", text: body.join("\n"), language: fence[2] || undefined });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, spans: parseInline((heading[2] ?? "").replace(/\s+#+$/, "")) });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      at++;
      continue;
    }
    if (quotes && QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at]!)) inner.push(QUOTE.exec(lines[at++]!)![1]!);
      blocks.push({ kind: "quote", blocks: parseMarkdown(inner.join("\n"), depth + 1) });
      continue;
    }
    const first = listMatch(line);
    if (first) {
      const items: MarkdownListItem[] = [];
      const texts: string[] = [];
      while (at < lines.length) {
        const current = lines[at]!;
        const item = listMatch(current);
        if (item && (item.depth > 0 || item.ordered === first.ordered)) {
          items.push({ marker: item.marker, depth: item.depth, spans: [] });
          texts.push(item.text);
        } else if (!item && current.trim() && /^\s/.test(current) && texts.length) {
          texts[texts.length - 1] += ` ${current.trim()}`;
        } else break;
        at++;
      }
      items.forEach((item, index) => (item.spans = parseInline(texts[index]!)));
      blocks.push({ kind: "list", ordered: first.ordered, items });
      continue;
    }
    const paragraph: string[] = [line.trim()];
    at++;
    while (at < lines.length && lines[at]!.trim() && !startsBlock(lines[at]!, quotes)) paragraph.push(lines[at++]!.trim());
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}
