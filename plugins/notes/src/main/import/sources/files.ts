import { htmlBlocks, htmlTitle, parseDom } from "../html";
import { para, type Block, type ImportNode } from "../ir";
import { IMPORT_LIMITS } from "../limits";
import { parseMarkdown, splitFrontmatter } from "../markdown";
import { baseOf, dirOf, fixEmbeds, isNoteFile, LinkIndex, propertiesBlock, stemOf } from "../resolve";
import type { Plan } from "../write";
import { decodeText, extOf, type Vfs } from "../vfs";

export type Flavor = "markdown" | "obsidian" | "bear" | "logseq" | "craft" | "apple-notes";

const BUNDLE = /\.(textbundle|textpack)(\/|$)/i;

function commonTop(paths: string[]): string {
  if (!paths.length) return "";
  const first = paths[0]!.split("/");
  if (first.length < 2) return "";
  const top = first[0]!;
  return paths.every((p) => p.startsWith(`${top}/`)) ? top : "";
}

const strip = (path: string, top: string) => (top ? path.slice(top.length + 1) : path);

function logseqTitle(path: string): string {
  const stem = stemOf(path);
  const journal = /^(\d{4})_(\d{2})_(\d{2})$/.exec(stem);
  if (journal) return `${journal[1]}-${journal[2]}-${journal[3]}`;
  let title = stem.replace(/___/g, "/").replace(/\./g, "/");
  try {
    title = decodeURIComponent(title);
  } catch {}
  return title;
}

export function logseqToMarkdown(text: string): { body: string; props: Record<string, unknown> } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const props: Record<string, unknown> = Object.create(null);
  let i = 0;
  while (i < lines.length && /^[A-Za-z][\w-]*::/.test(lines[i]!)) {
    const [k, ...v] = lines[i]!.split("::");
    const key = k!.trim();
    if (key !== "__proto__") props[key] = v.join("::").trim();
    i++;
  }
  const out: string[] = [];
  for (const raw of lines.slice(i)) {
    if (/^\s*-?\s*(id|collapsed|heading)::/.test(raw)) continue;
    let line = raw
      .replace(/^(\s*-\s+)(TODO|DOING|NOW|LATER|WAITING|IN-PROGRESS)\s+/, "$1[ ] ")
      .replace(/^(\s*-\s+)(DONE|CANCELED|CANCELLED)\s+/, "$1[x] ")
      .replace(/\{\{embed\s+(\[\[[^\]]+\]\])\s*\}\}/g, "$1")
      .replace(/\{\{embed\s+\(\([^)]+\)\)\s*\}\}/g, "")
      .replace(/\(\([0-9a-f-]{36}\)\)/g, "")
      .replace(/#\[\[([^\]]+)\]\]/g, "[[$1]]")
      .replace(/\s+SCHEDULED: <[^>]+>|\s+DEADLINE: <[^>]+>/g, "");
    const prop = /^(\s*)([A-Za-z][\w-]*):: (.*)$/.exec(line);
    if (prop) line = `${prop[1]}  ${prop[2]}: ${prop[3]}`;
    out.push(line);
  }
  return { body: out.join("\n"), props };
}

function obsidianClean(text: string): string {
  return text.replace(/%%[\s\S]*?%%/g, "").replace(/ \^[A-Za-z0-9-]+$/gm, "");
}

export async function filesPlan(vfs: Vfs, flavor: Flavor): Promise<Plan> {
  const all = vfs.files.filter((f) => !f.path.split("/").some((p) => p === ".obsidian" || p === ".trash" || p === "logseq" || p === "bak" || p === ".git"));
  const bundleText = new Map<string, string>();
  for (const f of all) {
    const m = /^(.*\.(?:textbundle|textpack))\/text\.(md|markdown|txt)$/i.exec(f.path);
    if (m) bundleText.set(m[1]!, f.path);
  }
  const notes = all.filter((f) => {
    if (BUNDLE.test(f.path)) return [...bundleText.values()].includes(f.path);
    if (!isNoteFile(f.path)) return false;
    if (flavor === "logseq" && !/(^|\/)(pages|journals)\//.test(f.path)) return false;
    return true;
  });
  const top = commonTop(all.map((f) => f.path));
  const index = new LinkIndex(all);
  const nodes: ImportNode[] = [];
  const dirs = new Map<string, ImportNode>();
  const byPath = new Map<string, ImportNode>();
  const notePathOf = (path: string) => {
    const bundle = /^(.*\.(?:textbundle|textpack))\//i.exec(path);
    return bundle ? bundle[1]! : path;
  };
  const folderNote = new Map<string, string>();
  for (const f of notes) {
    const p = notePathOf(f.path);
    const d = dirOf(p);
    const stem = stemOf(p);
    if (baseOf(d) === stem) folderNote.set(d, f.path);
  }
  const noteDirs = new Set<string>();
  for (const f of notes) for (let d = dirOf(notePathOf(f.path)); d; d = dirOf(d)) noteDirs.add(d);
  for (const f of notes) {
    const p = notePathOf(f.path);
    const d = dirOf(p);
    const stem = stemOf(p);
    const sibling = d ? `${d}/${stem}` : stem;
    if (!folderNote.has(sibling) && noteDirs.has(sibling)) folderNote.set(sibling, f.path);
  }
  const holderDir = new Map([...folderNote.entries()].map(([dir, file]) => [file, dir]));
  const ensureDir = (dir: string): string | null => {
    if (!dir || dir === top) return null;
    if (flavor === "logseq") return null;
    const holder = folderNote.get(dir);
    if (holder) return `file:${holder}`;
    let node = dirs.get(dir);
    if (!node) {
      node = { key: `dir:${dir}`, parent: ensureDir(dirOf(dir)), title: baseOf(dir), kind: "page", path: dir, blocks: [] };
      dirs.set(dir, node);
      nodes.push(node);
    }
    return node.key;
  };
  const journals: ImportNode | null = flavor === "logseq" && notes.some((f) => /(^|\/)journals\//.test(f.path)) ? { key: "logseq:journals", parent: null, title: "Journals", icon: "📅", kind: "page", blocks: [] } : null;
  if (journals) nodes.push(journals);
  const sorted = flavor === "logseq" ? [...notes].sort((a, b) => (/journals\//.test(a.path) && /journals\//.test(b.path) ? (a.path < b.path ? 1 : -1) : a.path < b.path ? -1 : 1)) : notes;
  for (const f of sorted.slice(0, IMPORT_LIMITS.pages)) {
    const p = notePathOf(f.path);
    const holderOf = holderDir.get(f.path);
    const parentDir = holderOf !== undefined ? dirOf(holderOf) : dirOf(p);
    const title = flavor === "logseq" ? logseqTitle(p) : stemOf(p).replace(/\.(textbundle|textpack)$/i, "");
    const node: ImportNode = {
      key: `file:${f.path}`,
      parent: flavor === "logseq" ? (/(^|\/)journals\//.test(f.path) ? journals!.key : null) : ensureDir(parentDir),
      title,
      kind: "page",
      path: strip(f.path, top),
    };
    nodes.push(node);
    byPath.set(f.path, node);
  }
  if (flavor === "logseq") {
    const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n]));
    for (const n of [...nodes]) {
      if (!n.key.startsWith("file:") || n.parent || !n.title.includes("/")) continue;
      const parts = n.title.split("/");
      let parentKey: string | null = null;
      for (let i = 1; i < parts.length; i++) {
        const name = parts.slice(0, i).join("/");
        let holder = byTitle.get(name.toLowerCase());
        if (!holder) {
          holder = { key: `ns:${name}`, parent: parentKey, title: parts[i - 1]!, kind: "page", blocks: [] };
          nodes.push(holder);
          byTitle.set(name.toLowerCase(), holder);
          index.addPage(holder, []);
        }
        parentKey = holder.key;
      }
      n.parent = parentKey;
      n.aliases = [n.title];
      n.title = parts.at(-1)!;
    }
  }
  for (const n of nodes) if (n.key.startsWith("file:")) index.addPage(n, [n.key.slice(5), notePathOf(n.key.slice(5))]);
    else if (n.key.startsWith("dir:")) index.addPage(n, [n.key.slice(4)]);
  for (const [path, file] of byPath) {
    const node = file;
    node.load = async () => {
      const bytes = await vfs.read(path, IMPORT_LIMITS.textBytes);
      const raw = decodeText(bytes);
      const ext = extOf(path);
      let blocks: Block[];
      const lead: Block[] = [];
      if (ext === "html" || ext === "htm") {
        const dom = parseDom(raw);
        const t = htmlTitle(dom);
        if (t && flavor !== "obsidian") node.title = node.title || t;
        blocks = htmlBlocks(dom, raw);
        if (blocks[0]?.type === "heading" && t && blocks[0].content?.map((c) => (c.t === "text" ? c.text : "")).join("").trim() === t) blocks.shift();
      } else if (ext === "txt") {
        blocks = raw.split(/\n{2,}/).map((chunk) => ({ type: "paragraph" as const, content: chunk.split("\n").flatMap((line, i) => (i ? [{ t: "break" as const }, { t: "text" as const, text: line }] : [{ t: "text" as const, text: line }])) }));
      } else {
        let body = raw;
        let data: Record<string, unknown> = {};
        if (flavor === "logseq") {
          const converted = logseqToMarkdown(raw);
          body = converted.body;
          data = converted.props;
        } else {
          const split = splitFrontmatter(raw);
          body = split.body;
          data = split.data;
        }
        if (flavor === "obsidian") body = obsidianClean(body);
        if (flavor === "bear") body = body.replace(/::([^:\n]+)::/g, "==$1==");
        blocks = fixEmbeds(parseMarkdown(body, { wikilinks: flavor !== "markdown" || /\[\[/.test(body), hardBreaks: flavor === "obsidian" || flavor === "logseq" || flavor === "apple-notes" }));
        const first = blocks[0];
        const firstText = first?.type === "heading" ? (first.content ?? []).map((c) => (c.t === "text" ? c.text : "")).join("").trim() : "";
        if (firstText && (firstText === node.title || flavor === "bear" || flavor === "apple-notes" || flavor === "craft") && Number(first!.props?.level) === 1) {
          node.title = firstText;
          blocks.shift();
        }
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "";
        if (title) node.title = title;
        const props = propertiesBlock(data, ["title", "alias", "aliases"]);
        if (props) lead.push(props);
      }
      return [...lead, ...blocks];
    };
  }
  if (flavor === "obsidian" || flavor === "logseq") {
    for (const [path, node] of byPath) {
      if (!path.endsWith(".md")) continue;
      try {
        const head = decodeText(await vfs.read(path, IMPORT_LIMITS.textBytes)).slice(0, 4000);
        const data = flavor === "logseq" ? logseqToMarkdown(head).props : splitFrontmatter(head).data;
        const aliases = data.aliases ?? data.alias;
        if (Array.isArray(aliases)) node.aliases = [...(node.aliases ?? []), ...aliases.map(String)];
        else if (typeof aliases === "string" && aliases) node.aliases = [...(node.aliases ?? []), ...aliases.split(",").map((s) => s.trim().replace(/^\[\[|\]\]$/g, ""))];
        if (node.aliases?.length) index.addPage(node, []);
      } catch {}
    }
  }
  const pathOfNode = (n: ImportNode) => (n.key.startsWith("file:") ? notePathOf(n.key.slice(5)) : n.key.startsWith("dir:") ? `${n.key.slice(4)}/` : "");
  return {
    nodes: nodes.length ? nodes : [{ key: "empty", parent: null, title: "Nothing to import", kind: "page", blocks: [para("No notes were found in what you chose.")] }],
    link: (target, from) => index.page(target, from.key.startsWith("file:") ? from.key.slice(5) : pathOfNode(from)),
    asset: (src, from) => {
      const fromPath = from.key.startsWith("file:") ? from.key.slice(5) : pathOfNode(from);
      const hit = index.asset(src, fromPath);
      if (hit) return hit;
      const bundle = /^(.*\.(?:textbundle|textpack))\//i.exec(fromPath);
      return bundle ? index.asset(src, `${bundle[1]}/assets/x`) : null;
    },
    readAsset: (path) => vfs.read(path, IMPORT_LIMITS.attachmentBytes),
    assetSize: (path) => index.size(path),
  };
}
