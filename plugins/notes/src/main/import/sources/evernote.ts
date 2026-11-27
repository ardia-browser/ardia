import { fromBase64 } from "../../../shared/bytes";
import { decodeEntities, parseHtml } from "../html";
import { para, type Block, type ImportNode } from "../ir";
import { IMPORT_LIMITS, ImportError } from "../limits";
import { md5Hex } from "../md5";
import { propertiesBlock, stemOf } from "../resolve";
import { extOf, rangeOf, type Vfs } from "../vfs";
import type { Plan } from "../write";

const OPEN = new TextEncoder().encode("<note>");
const CLOSE = new TextEncoder().encode("</note>");
const NOTE_MAX = 128 * 1024 * 1024;

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]!;
  outer: for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function enexDate(raw: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw.trim());
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : undefined;
}

const tagText = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeEntities(m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : "";
};

type Resource = { bytes: Uint8Array; name: string };

export async function enexRanges(vfs: Vfs, path: string, size: number): Promise<{ start: number; end: number }[]> {
  const access = await rangeOf(vfs, path, size, 512 * 1024 * 1024);
  const ranges: { start: number; end: number }[] = [];
  const step = 4 * 1024 * 1024;
  let open = -1;
  let carry = new Uint8Array(0);
  let carryAt = 0;
  for (let at = 0; at < access.size; at += step) {
    const fresh = await access.read(at, Math.min(step, access.size - at));
    const chunk = new Uint8Array(carry.length + fresh.length);
    chunk.set(carry);
    chunk.set(fresh, carry.length);
    const base = carryAt;
    let pos = 0;
    for (;;) {
      if (open < 0) {
        const i = indexOf(chunk, OPEN, pos);
        if (i < 0) break;
        open = base + i;
        pos = i + OPEN.length;
      } else {
        const j = indexOf(chunk, CLOSE, Math.max(pos, open - base));
        if (j < 0) break;
        ranges.push({ start: open, end: base + j + CLOSE.length });
        if (ranges.length > IMPORT_LIMITS.pages) throw new ImportError("That .enex holds too many notes.");
        open = -1;
        pos = j + CLOSE.length;
      }
    }
    const keep = Math.min(chunk.length, 8);
    carry = chunk.slice(chunk.length - keep);
    carryAt = base + chunk.length - keep;
    if (open >= 0 && base + chunk.length - open > NOTE_MAX) open = -1;
  }
  return ranges;
}

export async function evernotePlan(vfs: Vfs): Promise<Plan> {
  const enexes = vfs.files.filter((f) => extOf(f.path) === "enex");
  const nodes: ImportNode[] = [];
  const resources = new Map<string, Resource>();
  const titles = new Map<string, string>();
  let warnings = 0;
  for (const file of enexes) {
    const notebook: ImportNode | null = enexes.length > 1 ? { key: `nb:${file.path}`, parent: null, title: stemOf(file.path), icon: "📓", kind: "page", blocks: [] } : null;
    if (notebook) nodes.push(notebook);
    let ranges: { start: number; end: number }[];
    try {
      ranges = await enexRanges(vfs, file.path, file.size);
    } catch (error) {
      if (error instanceof ImportError) throw error;
      warnings++;
      continue;
    }
    const access = await rangeOf(vfs, file.path, file.size, 512 * 1024 * 1024);
    for (const [n, range] of ranges.entries()) {
      const head = new TextDecoder().decode(await access.read(range.start, Math.min(4096, range.end - range.start)));
      const title = tagText(head, "title") || "Untitled";
      const key = `${file.path}#${n}`;
      const node: ImportNode = { key, parent: notebook?.key ?? null, title, kind: "page", path: key, createdAt: enexDate(tagText(head, "created")) };
      titles.set(title.toLowerCase(), key);
      node.load = async () => {
        resources.clear();
        if (range.end - range.start > NOTE_MAX) return [para("This note was too big to import.")];
        const xml = new TextDecoder().decode(await access.read(range.start, range.end - range.start));
        const content = /<content>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content>/.exec(xml)?.[1] ?? "";
        const tags = [...xml.matchAll(/<tag>([\s\S]*?)<\/tag>/g)].map((m) => decodeEntities(m[1]!).trim()).filter(Boolean);
        const source = tagText(/<note-attributes>[\s\S]*?<\/note-attributes>/.exec(xml)?.[0] ?? "", "source-url");
        for (const m of xml.matchAll(/<resource>([\s\S]*?)<\/resource>/g)) {
          const body = m[1]!;
          const data = /<data[^>]*>([\s\S]*?)<\/data>/.exec(body)?.[1] ?? "";
          let bytes: Uint8Array;
          try {
            bytes = fromBase64(data);
          } catch {
            warnings++;
            continue;
          }
          const mime = tagText(body, "mime");
          const fileName = tagText(body, "file-name") || `attachment.${(mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin"}`;
          resources.set(md5Hex(bytes), { bytes, name: fileName.replace(/[\/\\]/g, "-").slice(0, 200) });
        }
        const lead: Block[] = [];
        const props = propertiesBlock({ ...(tags.length ? { Tags: tags } : {}), ...(source ? { Source: source } : {}) });
        if (props) lead.push(props);
        return [...lead, ...parseHtml(content)];
      };
      nodes.push(node);
    }
  }
  return {
    nodes: nodes.length ? nodes : [{ key: "empty", parent: null, title: "Nothing to import", kind: "page", blocks: [para("No notes were found. Choose an .enex file exported from Evernote.")] }],
    link: (target) => (target.startsWith("title:") ? (titles.get(target.slice(6).toLowerCase()) ?? null) : null),
    asset: (src) => {
      if (!src.startsWith("enmedia:")) return null;
      const hash = src.slice(8);
      const found = resources.get(hash);
      return found ? `enex:${hash}/${found.name}` : null;
    },
    readAsset: async (path) => {
      const hash = /^enex:([0-9a-f]{32})\//.exec(path)?.[1] ?? "";
      const found = resources.get(hash);
      if (!found) throw new ImportError("That attachment isn't in the note.");
      return found.bytes;
    },
    assetSize: (path) => resources.get(/^enex:([0-9a-f]{32})\//.exec(path)?.[1] ?? "")?.bytes.length ?? 0,
    warnings,
  };
}
