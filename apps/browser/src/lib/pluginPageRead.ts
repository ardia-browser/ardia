export const PAGE_READ_LIMITS = { text: 200_000, markdown: 200_000, selection: 20_000, headings: 100, links: 200, forms: 20, fields: 40, textBytes: 300_000, markdownBytes: 300_000, selectionBytes: 40_000, urlChars: 2048, totalBytes: 760_000 } as const;

export type PageReadFlags = { markdown: boolean; metadata: boolean; selection: boolean; fullUrls: boolean };

export function pageReadScript(flags: PageReadFlags): string {
  const L = PAGE_READ_LIMITS;
  return `(() => {
  const flags = ${JSON.stringify(flags)};
  const bytes = (text, escaped = true) => {
    let n = escaped ? 2 : 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (escaped && (c === 34 || c === 92)) n += 2;
      else if (escaped && c < 32) n += 6;
      else if (c < 128) n += 1;
      else if (c < 2048) n += 2;
      else if (c >= 55296 && c <= 56319 && i + 1 < text.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  };
  const fit = (text, max) => {
    let out = String(text || "");
    let size = bytes(out);
    while (size > max && out.length) {
      let cut = Math.max(0, Math.floor(out.length * (max / size) * 0.98));
      const c = out.charCodeAt(cut - 1);
      if (c >= 55296 && c <= 56319) cut--;
      out = out.slice(0, cut);
      size = bytes(out);
    }
    return out;
  };
  const clip = (text, max) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, max);
  const shown = (url) => { const raw = String(url || ""); if (!/^https?:/i.test(raw)) return ""; return (flags.fullUrls ? raw : raw.split(/[?#]/)[0]).slice(0, ${L.urlChars}); };
  const destination = (url) => shown(url).replace(/[()<>\\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  const label = (text) => String(text).replace(/[\\[\\]]/g, (c) => "\\\\" + c);
  const meta = (name) => { const node = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]'); return node ? clip(node.getAttribute("content"), 1000) : ""; };
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "ASIDE", "FORM", "SVG", "IFRAME", "TEMPLATE", "BUTTON"]);
  const out = [];
  let size = 0;
  const push = (line) => { const cost = bytes(line); if (out.length < 20000 && size + line.length <= ${L.markdown} && size + cost <= ${L.markdownBytes}) { out.push(line); size += cost + 2; } };
  const inline = (node) => {
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1 && !skip.has(child.tagName)) {
        const tag = child.tagName;
        const inner = inline(child);
        if (tag === "A" && child.href && /^https?:/.test(child.href)) text += "[" + label(inner.trim()) + "](" + destination(child.href) + ")";
        else if (tag === "STRONG" || tag === "B") text += "**" + inner + "**";
        else if (tag === "EM" || tag === "I") text += "_" + inner + "_";
        else if (tag === "CODE") text += "\`" + inner + "\`";
        else if (tag === "BR") text += "\\n";
        else text += inner;
      }
    }
    return text;
  };
  const walk = (node) => {
    for (const child of node.children) {
      if (skip.has(child.tagName) || child.hidden || child.getAttribute("aria-hidden") === "true") continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) push("#".repeat(Number(tag[1])) + " " + clip(child.innerText, 300));
      else if (tag === "P" || tag === "BLOCKQUOTE") { const text = inline(child).replace(/\\s+/g, " ").trim(); if (text) push((tag === "BLOCKQUOTE" ? "> " : "") + text); }
      else if (tag === "PRE") push("\`\`\`\\n" + String(child.innerText).slice(0, 20000) + "\\n\`\`\`");
      else if (tag === "LI") push("- " + inline(child).replace(/\\s+/g, " ").trim());
      else if (tag === "IMG" && child.alt) { const src = destination(child.src); if (src) push("![" + label(clip(child.alt, 200)) + "](" + src + ")"); }
      else if (tag === "TABLE") push(String(child.innerText).split("\\n").map((row) => "| " + row.split("\\t").join(" | ") + " |").join("\\n").slice(0, 20000));
      else walk(child);
    }
  };
  const result = { text: fit((document.body ? document.body.innerText : "").slice(0, ${L.text}), ${L.textBytes}), lang: String(document.documentElement.lang || "").slice(0, 35) };
  if (flags.markdown && root) { walk(root); result.markdown = out.join("\\n\\n"); }
  if (flags.selection) result.selection = fit(String(window.getSelection ? window.getSelection() : "").slice(0, ${L.selection}), ${L.selectionBytes});
  if (flags.metadata) {
    const canonical = document.querySelector('link[rel="canonical"]');
    result.metadata = {
      description: meta("og:description") || meta("description"),
      siteName: meta("og:site_name"),
      author: meta("author") || meta("article:author"),
      publishedAt: meta("article:published_time"),
      image: shown(meta("og:image")),
      lang: result.lang,
      canonicalUrl: canonical ? shown(canonical.href) : "",
    };
    result.headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].slice(0, ${L.headings}).map((h) => ({ level: Number(h.tagName[1]), text: clip(h.innerText, 300) }));
    result.links = [...document.querySelectorAll("a[href]")].filter((a) => /^https?:/.test(a.href)).slice(0, ${L.links}).map((a) => ({ text: clip(a.innerText, 200), url: shown(a.href) }));
    result.forms = [...document.forms].slice(0, ${L.forms}).map((f) => ({
      fields: [...f.elements].filter((e) => e.name || e.id).slice(0, ${L.fields}).map((e) => ({ name: clip(e.name || e.id, 100), type: clip(e.type || e.tagName.toLowerCase(), 30), label: clip((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute("aria-label") || e.placeholder || "", 200) })),
    }));
  }
  const over = () => bytes(JSON.stringify(result), false) - ${L.totalBytes};
  const shrink = [
    () => result.forms && result.forms.length && ((result.forms = []), true),
    () => result.links && result.links.length > 20 && ((result.links = result.links.slice(0, 20)), true),
    () => result.headings && result.headings.length > 20 && ((result.headings = result.headings.slice(0, 20)), true),
    () => {
      if (!result.markdown) return false;
      let size = bytes(result.markdown);
      const target = size - over() - 1024;
      while (out.length && size > target) size -= bytes(out.pop()) + 2;
      result.markdown = out.join("\\n\\n");
      return true;
    },
    () => !!result.text && ((result.text = fit(result.text, Math.max(0, bytes(result.text) - over() - 1024))), true),
  ];
  for (const step of shrink) if (over() > 0) step();
  post("result", JSON.stringify(result));
})()`;
}
