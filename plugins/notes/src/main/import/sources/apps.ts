import { parseHtml } from "../html";
import { para, type Block, type ImportNode, type Inline } from "../ir";
import { IMPORT_LIMITS, ImportError } from "../limits";
import { parseInline, parseMarkdown } from "../markdown";
import { baseOf, dirOf, fixEmbeds, LinkIndex, propertiesBlock, stemOf } from "../resolve";
import { decodeText, extOf, type Vfs } from "../vfs";
import type { Plan } from "../write";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");

async function readJson(vfs: Vfs, path: string): Promise<unknown> {
  const text = decodeText(await vfs.read(path, IMPORT_LIMITS.jsonBytes));
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError(`${baseOf(path)} isn't valid JSON.`);
  }
}

const empty = (message: string): ImportNode[] => [{ key: "empty", parent: null, title: "Nothing to import", kind: "page", blocks: [para(message)] }];

const noAssets = { asset: () => null, readAsset: async () => new Uint8Array(0) };

function roamText(raw: string): string {
  return raw
    .replace(/\{\{\[\[TODO\]\]\}\}\s*/g, "[ ] ")
    .replace(/\{\{\[\[DONE\]\]\}\}\s*/g, "[x] ")
    .replace(/\{\{(?:\[\[)?embed(?:\]\])?:\s*(\[\[[^\]]+\]\])\s*\}\}/g, "$1")
    .replace(/#\[\[([^\]]+)\]\]/g, "[[$1]]")
    .replace(/(^|\s)#([\w/-]+)/g, "$1[[$2]]")
    .replace(/\^\^([^^]+)\^\^/g, "==$1==")
    .replace(/(^|[^_])__([^_\n]+)__(?!_)/g, "$1*$2*")
    .replace(/\{\{[^}]*\}\}/g, "");
}

export async function roamPlan(vfs: Vfs): Promise<Plan> {
  const files = vfs.files.filter((f) => extOf(f.path) === "json");
  const nodes: ImportNode[] = [];
  const titles = new Map<string, string>();
  const blockText = new Map<string, string>();
  for (const file of files) {
    const data = await readJson(vfs, file.path);
    if (!Array.isArray(data)) continue;
    const walkUids = (children: unknown, depth: number) => {
      if (!Array.isArray(children) || depth > 64) return;
      for (const c of children) if (isObject(c)) {
        if (typeof c.uid === "string") blockText.set(c.uid, str(c.string, 2000));
        walkUids(c.children, depth + 1);
      }
    };
    for (const page of data.slice(0, IMPORT_LIMITS.pages)) {
      if (!isObject(page) || typeof page.title !== "string") continue;
      walkUids(page.children, 0);
      const key = `roam:${nodes.length}`;
      const node: ImportNode = { key, parent: null, title: page.title.slice(0, 2000) || "Untitled", kind: "page", createdAt: typeof page["create-time"] === "number" ? page["create-time"] : undefined };
      titles.set(node.title.toLowerCase(), key);
      const children = page.children;
      node.load = async () => {
        const toBlocks = (list: unknown, depth: number): Block[] => {
          if (!Array.isArray(list) || depth > IMPORT_LIMITS.depth) return [];
          const out: Block[] = [];
          for (const c of list) {
            if (!isObject(c)) continue;
            const text = roamText(str(c.string).replace(/\(\(([\w-]{6,})\)\)/g, (_, uid: string) => blockText.get(uid) ?? ""));
            const images: Block[] = [];
            const task = /^\[( |x)\]\s/.exec(text);
            const content = parseInline(task ? text.slice(task[0].length) : text, { wikilinks: true, images });
            const heading = typeof c.heading === "number" && c.heading >= 1 && c.heading <= 3 ? c.heading : 0;
            const kids = [...images, ...toBlocks(c.children, depth + 1)];
            if (heading) out.push({ type: "heading", props: { level: heading }, content }, ...kids);
            else out.push({ type: task ? "checkListItem" : "bulletListItem", ...(task ? { props: { checked: task[1] === "x" } } : {}), content, children: kids });
          }
          return out;
        };
        return toBlocks(children, 0);
      };
      nodes.push(node);
    }
  }
  return {
    nodes: nodes.length ? nodes : empty("No Roam pages were found. Choose the JSON from Export All."),
    link: (target) => (target.startsWith("wiki:") || target.startsWith("title:") ? (titles.get(target.replace(/^(wiki|title):/, "").replace(/#.*$/, "").toLowerCase()) ?? null) : null),
    ...noAssets,
  };
}

const usec = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v / 1000) : undefined);

export async function keepPlan(vfs: Vfs): Promise<Plan> {
  const jsons = vfs.files.filter((f) => extOf(f.path) === "json");
  const index = new LinkIndex(vfs.files);
  const nodes: ImportNode[] = [];
  let archived: ImportNode | null = null;
  for (const file of jsons.slice(0, IMPORT_LIMITS.pages)) {
    let note: unknown;
    try {
      note = await readJson(vfs, file.path);
    } catch {
      continue;
    }
    if (!isObject(note) || note.isTrashed === true || !("textContent" in note || "listContent" in note || "title" in note)) continue;
    if (note.isArchived === true && !archived) {
      archived = { key: "keep:archived", parent: null, title: "Archived", icon: "🗄️", kind: "page", blocks: [] };
      nodes.push(archived);
    }
    const title = str(note.title, 2000).trim() || str(note.textContent, 80).split("\n")[0]!.trim() || stemOf(file.path);
    const labels = Array.isArray(note.labels) ? note.labels.map((l) => (isObject(l) ? str(l.name, 200) : "")).filter(Boolean) : [];
    const blocks: Block[] = [];
    const props = propertiesBlock({ ...(labels.length ? { Labels: labels } : {}), ...(note.isPinned === true ? { Pinned: "Yes" } : {}) });
    if (props) blocks.push(props);
    if (typeof note.textContentHtml === "string" && note.textContentHtml) blocks.push(...parseHtml(note.textContentHtml));
    else if (typeof note.textContent === "string")
      for (const line of note.textContent.split("\n")) blocks.push({ type: "paragraph", content: parseInline(line) });
    if (Array.isArray(note.listContent))
      for (const item of note.listContent) if (isObject(item)) blocks.push({ type: "checkListItem", props: { checked: item.isChecked === true }, content: [{ t: "text", text: str(item.text, 10_000) }] });
    if (Array.isArray(note.annotations))
      for (const a of note.annotations) if (isObject(a) && typeof a.url === "string") blocks.push({ type: "bookmark", props: { url: a.url } });
    if (Array.isArray(note.attachments))
      for (const a of note.attachments) if (isObject(a) && typeof a.filePath === "string") blocks.push({ type: /^image\//.test(str(a.mimetype)) ? "image" : "file", src: a.filePath });
    nodes.push({ key: `keep:${file.path}`, parent: note.isArchived === true ? archived!.key : null, title, kind: "page", path: file.path, createdAt: usec(note.createdTimestampUsec), blocks });
  }
  return {
    nodes: nodes.length ? nodes : empty("No Keep notes were found. Choose the Keep folder from Google Takeout."),
    link: () => null,
    asset: (src, from) => {
      const fromPath = from.path ?? "";
      const hit = index.asset(src, fromPath);
      if (hit) return hit;
      const stem = stemOf(src).toLowerCase();
      return vfs.files.find((f) => dirOf(f.path) === dirOf(fromPath) && stemOf(f.path).toLowerCase() === stem && extOf(f.path) !== "json")?.path ?? null;
    },
    readAsset: (path) => vfs.read(path, IMPORT_LIMITS.attachmentBytes),
    assetSize: (path) => index.size(path),
  };
}

type JoplinItem = { id: string; type: number; title: string; body: string; parent: string; meta: Record<string, string>; path: string };

function parseJoplin(text: string, path: string): JoplinItem | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const meta: Record<string, string> = Object.create(null);
  let i = lines.length - 1;
  while (i >= 0 && /^[a-z_]+: ?/.test(lines[i]!)) {
    const [k, ...v] = lines[i]!.split(":");
    if (k !== "__proto__") meta[k!] = v.join(":").trim();
    i--;
  }
  if (!meta.id || !meta.type_) return null;
  const content = lines.slice(0, i + 1);
  while (content.length && !content.at(-1)!.trim()) content.pop();
  const title = content[0] ?? "";
  const body = content.slice(2).join("\n");
  return { id: meta.id, type: Number(meta.type_), title, body, parent: meta.parent_id ?? "", meta, path };
}

export async function joplinPlan(vfs: Vfs): Promise<Plan> {
  const items = new Map<string, JoplinItem>();
  for (const f of vfs.files) {
    if (extOf(f.path) !== "md") continue;
    if (items.size >= IMPORT_LIMITS.pages * 2) break;
    const item = parseJoplin(decodeText(await vfs.read(f.path, IMPORT_LIMITS.textBytes)), f.path);
    if (item) items.set(item.id, item);
  }
  const resources = new Map<string, string>();
  for (const f of vfs.files) {
    const m = /(?:^|\/)resources\/([0-9a-f]{32})(\.[A-Za-z0-9]+)?$/.exec(f.path);
    if (m) resources.set(m[1]!, f.path);
  }
  const names = new Map<string, string>();
  for (const it of items.values()) if (it.type === 4) names.set(it.id, it.meta.title || it.title || it.id);
  const nodes: ImportNode[] = [];
  for (const it of items.values()) {
    if (it.type !== 1 && it.type !== 2) continue;
    const node: ImportNode = { key: it.id, parent: items.has(it.parent) ? it.parent : null, title: it.title.slice(0, 2000) || "Untitled", kind: "page", path: it.path, icon: it.type === 2 ? "📁" : undefined };
    if (it.type === 2) node.blocks = [];
    else {
      const created = Date.parse(it.meta.user_created_time ?? it.meta.created_time ?? "");
      if (Number.isFinite(created)) node.createdAt = created;
      node.load = async () => fixEmbeds(parseMarkdown(it.body.replace(/(!?)\[([^\]]*)\]\(:\/([0-9a-f]{32})\)/g, (_, bang: string, label: string, id: string) => (bang ? `![${label}](joplin:${id})` : `[${label}](joplin-note-${id})`))));
    }
    nodes.push(node);
  }
  const sizes = new Map(vfs.files.map((f) => [f.path, f.size]));
  return {
    nodes: nodes.length ? nodes : empty("No Joplin notes were found. Choose a .jex export."),
    link: (target) => {
      const m = /^path:joplin-note-([0-9a-f]{32})$/.exec(target);
      return m && items.has(m[1]!) && items.get(m[1]!)!.type !== 4 ? m[1]! : null;
    },
    asset: (src) => {
      const m = /^joplin:([0-9a-f]{32})$/.exec(src);
      return m ? (resources.get(m[1]!) ?? null) : null;
    },
    readAsset: (path) => vfs.read(path, IMPORT_LIMITS.attachmentBytes),
    assetSize: (path) => sizes.get(path) ?? 0,
  };
}

export async function simplenotePlan(vfs: Vfs): Promise<Plan> {
  const nodes: ImportNode[] = [];
  for (const f of vfs.files) {
    if (extOf(f.path) === "json") {
      let data: unknown;
      try {
        data = await readJson(vfs, f.path);
      } catch {
        continue;
      }
      if (!isObject(data) || !Array.isArray(data.activeNotes)) continue;
      for (const note of data.activeNotes.slice(0, IMPORT_LIMITS.pages)) {
        if (!isObject(note)) continue;
        const content = str(note.content, IMPORT_LIMITS.textBytes);
        const [first = "", ...rest] = content.split("\n");
        const tags = Array.isArray(note.tags) ? note.tags.map((t) => str(t, 200)).filter(Boolean) : [];
        const created = Date.parse(str(note.creationDate, 64));
        const lead: Block[] = [];
        const props = propertiesBlock(tags.length ? { Tags: tags } : {});
        if (props) lead.push(props);
        const body = rest.join("\n").replace(/^\n+/, "");
        nodes.push({ key: `sn:${nodes.length}`, parent: null, title: first.replace(/^#+\s*/, "").trim().slice(0, 2000) || "Untitled", kind: "page", createdAt: Number.isFinite(created) ? created : undefined, blocks: [...lead, ...(note.markdown === true ? parseMarkdown(body) : body.split("\n").map((line): Block => ({ type: "paragraph", content: parseInline(line) })))] });
      }
    }
  }
  if (!nodes.length) {
    const txt = vfs.files.filter((f) => extOf(f.path) === "txt");
    for (const f of txt.slice(0, IMPORT_LIMITS.pages)) {
      const node: ImportNode = { key: `sn:${f.path}`, parent: null, title: stemOf(f.path), kind: "page", path: f.path };
      node.load = async () => decodeText(await vfs.read(f.path, IMPORT_LIMITS.textBytes)).split("\n").map((line): Block => ({ type: "paragraph", content: [{ t: "text", text: line } as Inline] }));
      nodes.push(node);
    }
  }
  return { nodes: nodes.length ? nodes : empty("No Simplenote notes were found. Choose the .zip from Export notes."), link: () => null, ...noAssets };
}
