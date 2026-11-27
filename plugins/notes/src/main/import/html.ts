import { parseInline, parseMarkdown, calloutIcon } from "./markdown";
import { isExternal, safeUrl, type Block, type Inline, type Marks } from "./ir";

export type HNode = { tag: string; attrs: Record<string, string>; children: (HNode | string)[]; start: number; end: number };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "en-media", "en-todo", "en-crypt"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "head", "title", "noscript", "template", "svg", "math", "canvas", "form", "button", "select", "textarea", "video", "audio", "frame", "frameset", "applet", "base", "link", "meta"]);
const AUTO_CLOSE: Record<string, string[]> = { p: ["p"], li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"], option: ["option"] };
const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "table", "details", "summary", "aside", "figure", "section", "article", "header", "footer", "main", "nav", "en-note", "body", "html", "dl", "dt", "dd", "figcaption", "center"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", laquo: "«", raquo: "»" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(raw)) && n++ < 64) {
    const name = m[1]!.toLowerCase();
    if (name === "__proto__") continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function parseDom(html: string, maxNodes = 200_000): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [], start: 0, end: html.length };
  const stack: HNode[] = [root];
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<!?[^>]*>|<\?[\s\S]*?\?>|[^<]+|</g;
  let m: RegExpExecArray | null;
  let nodes = 0;
  let dropping: { tag: string; depth: number } | null = null;
  while ((m = re.exec(html))) {
    const token = m[0];
    const top = stack[stack.length - 1]!;
    if (token.startsWith("<!--") || token.startsWith("<?") || /^<!(?!\[CDATA)/i.test(token)) continue;
    if (token.startsWith("<![CDATA[")) {
      if (!dropping) top.children.push(m[1] ?? "");
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!tag) {
      if (!dropping) top.children.push(decodeEntities(token));
      continue;
    }
    const name = tag[2]!.toLowerCase();
    if (dropping) {
      if (name === dropping.tag) dropping.depth += tag[1] ? -1 : tag[4] ? 0 : 1;
      if (dropping.depth <= 0) dropping = null;
      continue;
    }
    if (tag[1]) {
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i]!.tag === name) {
          for (let j = stack.length - 1; j >= i; j--) stack[j]!.end = m.index;
          stack.length = i;
          break;
        }
      continue;
    }
    if (DROP.has(name)) {
      if (!tag[4] && !VOID.has(name)) dropping = { tag: name, depth: 1 };
      continue;
    }
    if (++nodes > maxNodes) break;
    const closes = AUTO_CLOSE[name];
    if (closes && closes.includes(top.tag)) {
      top.end = m.index;
      stack.pop();
    }
    const node: HNode = { tag: name, attrs: parseAttrs(tag[3] ?? ""), children: [], start: m.index + token.length, end: html.length };
    stack[stack.length - 1]!.children.push(node);
    if (!VOID.has(name) && !tag[4] && stack.length < 256) stack.push(node);
  }
  return root;
}

export function findAll(node: HNode, test: (n: HNode) => boolean, out: HNode[] = []): HNode[] {
  for (const c of node.children) {
    if (typeof c === "string") continue;
    if (test(c)) out.push(c);
    findAll(c, test, out);
  }
  return out;
}

export const find = (node: HNode, test: (n: HNode) => boolean): HNode | null => findAll(node, test)[0] ?? null;

export function textContent(node: HNode | string): string {
  if (typeof node === "string") return node;
  if (node.tag === "br") return "\n";
  return node.children.map(textContent).join("");
}

const hasClass = (n: HNode, name: string) => (n.attrs.class ?? "").split(/\s+/).includes(name);

export type HtmlOptions = { markdownInside?: boolean; wikilinks?: boolean; raw?: string };

function styleMarks(n: HNode): Marks {
  const style = (n.attrs.style ?? "").toLowerCase();
  const out: Marks = {};
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(style)) out.bold = true;
  if (/font-style\s*:\s*italic/.test(style)) out.italic = true;
  if (/text-decoration[^;]*underline/.test(style)) out.underline = true;
  if (/text-decoration[^;]*line-through/.test(style)) out.strike = true;
  if (/background(-color)?\s*:\s*(?!transparent|none|#fff|white)/.test(style) && hasClass(n, "highlight")) out.highlight = true;
  return out;
}

class HtmlConverter {
  constructor(private readonly options: HtmlOptions, private readonly html: string) {}

  private pushText(out: Inline[], text: string, marks: Marks) {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.t === "text" && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks)) last.text += text;
    else out.push(Object.keys(marks).length ? { t: "text", text, marks: { ...marks } } : { t: "text", text });
  }

  inline(nodes: (HNode | string)[], marks: Marks, out: Inline[], images: Block[], depth = 0): Inline[] {
    if (depth > 64) return out;
    for (const n of nodes) {
      if (typeof n === "string") {
        const text = n.replace(/[\t\n\r ]+/g, " ");
        if (this.options.markdownInside && /[*_`[\]$~=]/.test(text)) for (const part of parseInline(text, { wikilinks: this.options.wikilinks, images }, Object.keys(marks).length ? marks : undefined)) out.push(part);
        else this.pushText(out, text, marks);
        continue;
      }
      const tag = n.tag;
      if (tag === "br") {
        out.push({ t: "break" });
        continue;
      }
      if (tag === "img") {
        if (n.attrs.src) images.push({ type: "image", src: n.attrs.src, props: { caption: n.attrs.alt ?? "" } });
        continue;
      }
      if (tag === "en-media") {
        if (n.attrs.hash) images.push({ type: /^image\//.test(n.attrs.type ?? "") ? "image" : "file", src: `enmedia:${n.attrs.hash.toLowerCase()}` });
        continue;
      }
      if (tag === "en-todo" || tag === "input") continue;
      if (hasClass(n, "notion-text-equation-token") || (tag === "span" && hasClass(n, "katex"))) {
        const tex = find(n, (x) => x.tag === "annotation");
        out.push({ t: "math", text: tex ? textContent(tex).trim() : textContent(n).trim() });
        continue;
      }
      if (tag === "time") {
        out.push({ t: "text", text: textContent(n).replace(/^@/, "") });
        continue;
      }
      if (tag === "a") {
        const href = (n.attrs.href ?? "").trim();
        const label: Inline[] = [];
        this.inline(n.children, marks, label, images, depth + 1);
        if (href && !isExternal(href) && !href.startsWith("#")) {
          let target = href.replace(/[?#].*$/, "");
          try {
            target = decodeURIComponent(target);
          } catch {}
          out.push({ t: "ref", target: `path:${target}`, text: label.map((l) => (l.t === "text" || l.t === "ref" ? l.text : "")).join("") || target, ...(Object.keys(marks).length ? { marks: { ...marks } } : {}) });
          continue;
        }
        if (href.startsWith("evernote:")) {
          out.push({ t: "ref", target: `title:${textContent(n).trim()}`, text: textContent(n).trim() });
          continue;
        }
        const safe = safeUrl(href);
        for (const part of label) out.push(safe && part.t === "text" ? { ...part, marks: { ...(part.marks ?? {}), link: safe } } : part);
        continue;
      }
      const extra: Marks =
        tag === "b" || tag === "strong"
          ? { bold: true }
          : tag === "i" || tag === "em" || tag === "cite"
            ? { italic: true }
            : tag === "u" || tag === "ins"
              ? { underline: true }
              : tag === "s" || tag === "del" || tag === "strike"
                ? { strike: true }
                : tag === "code" || tag === "kbd" || tag === "tt"
                  ? { code: true }
                  : tag === "mark"
                    ? { highlight: true }
                    : styleMarks(n);
      this.inline(n.children, { ...marks, ...extra }, out, images, depth + 1);
    }
    return out;
  }

  private trimInline(parts: Inline[]): Inline[] {
    while (parts[0]?.t === "break") parts.shift();
    while (parts.at(-1)?.t === "break") parts.pop();
    const first = parts[0];
    if (first?.t === "text") first.text = first.text.replace(/^\s+/, "");
    const last = parts.at(-1);
    if (last?.t === "text") last.text = last.text.replace(/\s+$/, "");
    return parts.filter((p) => !(p.t === "text" && !p.text));
  }

  private isBlocky(n: HNode | string): boolean {
    return typeof n !== "string" && (BLOCK_TAGS.has(n.tag) || n.tag === "img" || n.tag === "en-media" || n.tag === "hr" || n.tag === "table" || (n.tag === "a" && n.children.some((c) => this.isBlocky(c))));
  }

  blocks(nodes: (HNode | string)[], out: Block[], depth = 0): Block[] {
    if (depth > 48) return out;
    let run: (HNode | string)[] = [];
    const flushRun = () => {
      if (!run.length) return;
      const images: Block[] = [];
      const content = this.trimInline(this.inline(run, {}, [], images));
      run = [];
      if (content.length) {
        const checkbox = content.length && content[0]?.t === "text" ? /^\[( |x)\]\s/.exec(content[0].text) : null;
        if (checkbox && content[0]?.t === "text") {
          content[0].text = content[0].text.slice(checkbox[0].length);
          out.push({ type: "checkListItem", props: { checked: checkbox[1] === "x" }, content });
        } else out.push({ type: "paragraph", content });
      }
      for (const img of images) out.push(img);
    };
    for (const n of nodes) {
      if (typeof n === "string" || !this.isBlocky(n)) {
        if (typeof n !== "string" && n.tag === "en-todo") {
          flushRun();
          run.push(`[${n.attrs.checked === "true" ? "x" : " "}] `);
          continue;
        }
        run.push(n);
        continue;
      }
      flushRun();
      this.block(n, out, depth);
    }
    flushRun();
    return out;
  }

  private markdownOf(n: HNode, from = n.start): Block[] {
    const raw = this.html.slice(from, Math.min(n.end, this.html.length));
    return parseMarkdown(raw, { wikilinks: this.options.wikilinks });
  }

  private block(n: HNode, out: Block[], depth: number) {
    const tag = n.tag;
    const images: Block[] = [];
    const inlineOf = (nodes: (HNode | string)[]) => this.trimInline(this.inline(nodes, {}, [], images));
    if (/^h[1-6]$/.test(tag)) {
      if (hasClass(n, "page-title")) return;
      out.push({ type: "heading", props: { level: Math.min(3, Number(tag[1])) }, content: inlineOf(n.children) });
    } else if (tag === "hr") out.push({ type: "divider" });
    else if (tag === "img") {
      if (n.attrs.src) out.push({ type: "image", src: n.attrs.src, props: { caption: n.attrs.alt ?? "" } });
    } else if (tag === "en-media") {
      if (n.attrs.hash) out.push({ type: /^image\//.test(n.attrs.type ?? "") ? "image" : "file", src: `enmedia:${n.attrs.hash.toLowerCase()}` });
    } else if (tag === "pre") {
      const code = find(n, (x) => x.tag === "code");
      const lang = /language-([\w+#-]+)/.exec((code ?? n).attrs.class ?? "")?.[1] ?? "text";
      out.push({ type: "codeBlock", text: textContent(n).replace(/\n$/, ""), props: { language: lang.toLowerCase() } });
    } else if (tag === "blockquote") {
      const inner = this.blocks(n.children, [], depth + 1);
      const first = inner[0];
      if (first?.type === "paragraph") out.push({ type: "quote", content: first.content ?? [], children: inner.slice(1) });
      else for (const b of inner) out.push(b);
    } else if (tag === "ul" || tag === "ol") {
      const todo = hasClass(n, "to-do-list");
      const toggle = hasClass(n, "toggle");
      for (const li of n.children) {
        if (typeof li === "string" || li.tag !== "li") {
          if (typeof li !== "string") this.block(li, out, depth + 1);
          continue;
        }
        if (toggle) {
          const details = find(li, (x) => x.tag === "details");
          if (details) {
            this.block(details, out, depth + 1);
            continue;
          }
        }
        const head = li.children.filter((c) => !this.isBlocky(c) || (typeof c !== "string" && (c.tag === "p" || c.tag === "div") && !c.children.some((x) => typeof x !== "string" && (x.tag === "ul" || x.tag === "ol"))));
        const rest = li.children.filter((c) => !head.includes(c));
        const checkbox = find(li, (x) => (x.tag === "input" && (x.attrs.type ?? "") === "checkbox") || hasClass(x, "checkbox") || x.tag === "en-todo");
        const checked = !!checkbox && (checkbox.attrs.checked !== undefined && checkbox.attrs.checked !== "false" ? true : hasClass(checkbox, "checkbox-on"));
        const flatHead: (HNode | string)[] = [];
        for (const h of head) if (typeof h !== "string" && (h.tag === "p" || h.tag === "div")) flatHead.push(...h.children, " ");
          else flatHead.push(h);
        const children = this.blocks(rest, [], depth + 1);
        out.push({ type: todo || checkbox ? "checkListItem" : tag === "ol" ? "numberedListItem" : "bulletListItem", ...(todo || checkbox ? { props: { checked } } : {}), content: inlineOf(flatHead), children: [...images.splice(0), ...children] });
      }
    } else if (tag === "details") {
      const summary = n.children.find((c): c is HNode => typeof c !== "string" && c.tag === "summary");
      const rest = n.children.filter((c) => c !== summary);
      const children = this.options.markdownInside && summary ? this.markdownOf(n, summary.end + "</summary>".length) : this.blocks(rest, [], depth + 1);
      out.push({ type: "toggleListItem", content: summary ? inlineOf(summary.children) : [], children });
    } else if (tag === "aside" || (tag === "figure" && hasClass(n, "callout"))) {
      const iconNode = find(n, (x) => hasClass(x, "icon"));
      const icon = iconNode ? textContent(iconNode).trim() : "";
      const body = this.options.markdownInside ? this.markdownOf(n) : this.blocks(n.children.filter((c) => c !== iconNode && !(typeof c !== "string" && iconNode && findAll(c, (x) => x === iconNode).length)), [], depth + 1);
      const leading = /^(\p{Extended_Pictographic}️?)\s*/u.exec(body[0]?.content?.[0]?.t === "text" ? body[0].content[0].text : "");
      const first = body[0];
      if (leading && first?.content?.[0]?.t === "text") first.content[0].text = first.content[0].text.slice(leading[0].length);
      const iconText = icon || leading?.[1] || "💡";
      if (first && (first.type === "paragraph" || first.type === "heading")) out.push({ type: "callout", props: { icon: iconText }, content: first.content ?? [], children: body.slice(1) });
      else out.push({ type: "callout", props: { icon: iconText }, content: [], children: body });
    } else if (tag === "figure" && hasClass(n, "equation")) {
      const tex = find(n, (x) => x.tag === "annotation");
      out.push({ type: "equation", text: (tex ? textContent(tex) : textContent(n)).trim() });
    } else if (tag === "figure" && hasClass(n, "link-to-page")) {
      const a = find(n, (x) => x.tag === "a");
      const href = a?.attrs.href ?? "";
      if (href && !isExternal(href)) {
        let target = href.replace(/[?#].*$/, "");
        try {
          target = decodeURIComponent(target);
        } catch {}
        out.push({ type: "pageRef", target: `path:${target}` });
      }
    } else if (tag === "figure" && hasClass(n, "bookmark")) {
      const a = find(n, (x) => x.tag === "a");
      const url = safeUrl(a?.attrs.href ?? "");
      if (url) out.push({ type: "bookmark", props: { url } });
    } else if (tag === "table") {
      const rows = findAll(n, (x) => x.tag === "tr").slice(0, 2000);
      const grid = rows.map((r) => r.children.filter((c): c is HNode => typeof c !== "string" && (c.tag === "td" || c.tag === "th")).map((c) => inlineOf(c.children)));
      const width = Math.min(64, Math.max(0, ...grid.map((r) => r.length)));
      if (width) out.push({ type: "table", rows: grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? [])), props: { header: !!find(n, (x) => x.tag === "th" || x.tag === "thead") } });
    } else if (tag === "a") {
      this.blocks(n.children, out, depth + 1);
    } else if (tag === "p" || tag === "summary" || tag === "dt" || tag === "dd" || tag === "figcaption") {
      if (n.children.some((c) => this.isBlocky(c))) this.blocks(n.children, out, depth + 1);
      else {
        const content = inlineOf(n.children);
        if (content.length) out.push({ type: "paragraph", content });
      }
    } else if (tag === "div" && n.children.length && n.children.every((c) => !this.isBlocky(c))) {
      const todo = n.children.find((c): c is HNode => typeof c !== "string" && c.tag === "en-todo");
      const content = inlineOf(n.children);
      if (todo) out.push({ type: "checkListItem", props: { checked: todo.attrs.checked === "true" }, content });
      else if (content.length) out.push({ type: "paragraph", content });
    } else this.blocks(n.children, out, depth + 1);
    for (const img of images) out.push(img);
  }
}

export function parseHtml(html: string, options: HtmlOptions = {}): Block[] {
  const dom = parseDom(html);
  const body = find(dom, (n) => n.tag === "body" || n.tag === "en-note") ?? dom;
  return new HtmlConverter(options, html).blocks(body.children, []);
}

export function htmlTitle(dom: HNode): string {
  const title = find(dom, (n) => n.tag === "h1" && hasClass(n, "page-title")) ?? find(dom, (n) => n.tag === "title");
  return title ? textContent(title).trim() : "";
}

export function htmlBlocks(dom: HNode, html: string, options: HtmlOptions = {}): Block[] {
  const body = find(dom, (n) => n.tag === "article" && hasClass(n, "page")) ?? find(dom, (n) => n.tag === "body" || n.tag === "en-note") ?? dom;
  const inner = find(body, (n) => hasClass(n, "page-body"));
  return new HtmlConverter(options, html).blocks((inner ?? body).children, []);
}
