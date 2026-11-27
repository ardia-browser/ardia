import type { Block, ImportNode } from "./ir";
import { extOf, type VFile } from "./vfs";

export const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const stemOf = (path: string) => {
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

export function joinPath(dir: string, rel: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const p of rel.replace(/\\/g, "/").split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join("/");
}

const fold = (s: string) => s.normalize("NFC").toLowerCase().trim();

export const NOTE_EXTS = new Set(["md", "markdown", "mdown", "txt", "html", "htm"]);

export const isNoteFile = (path: string) => NOTE_EXTS.has(extOf(path));

export class LinkIndex {
  private readonly byPath = new Map<string, string>();
  private readonly byStem = new Map<string, string[]>();
  private readonly byTitle = new Map<string, string>();
  private readonly files = new Map<string, VFile>();
  private readonly filesByBase = new Map<string, string[]>();

  constructor(files: VFile[]) {
    for (const f of files) {
      this.files.set(f.path, f);
      const key = fold(baseOf(f.path));
      (this.filesByBase.get(key) ?? this.filesByBase.set(key, []).get(key)!).push(f.path);
    }
    for (const list of this.filesByBase.values()) list.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  }

  addPage(node: ImportNode, paths: string[]) {
    for (const p of paths) {
      this.byPath.set(p, node.key);
      this.byPath.set(fold(p), node.key);
      const stem = fold(stemOf(p));
      (this.byStem.get(stem) ?? this.byStem.set(stem, []).get(stem)!).push(node.key);
    }
    const title = fold(node.title);
    if (title && !this.byTitle.has(title)) this.byTitle.set(title, node.key);
    for (const alias of node.aliases ?? []) if (alias && !this.byTitle.has(fold(alias))) this.byTitle.set(fold(alias), node.key);
  }

  page(target: string, fromPath: string): string | null {
    const colon = target.indexOf(":");
    const kind = target.slice(0, colon);
    const value = target.slice(colon + 1);
    if (kind === "key") return value;
    if (kind === "title") return this.byTitle.get(fold(value)) ?? null;
    if (kind === "path") {
      const clean = value;
      const full = joinPath(dirOf(fromPath), clean);
      for (const candidate of [full, clean]) {
        if (candidate === null) continue;
        const hit = this.byPath.get(candidate) ?? this.byPath.get(fold(candidate)) ?? this.byPath.get(candidate.replace(/\.(md|html?|csv)$/i, "")) ?? this.byPath.get(fold(candidate.replace(/\.(md|html?|csv)$/i, "")));
        if (hit) return hit;
      }
      const stem = fold(stemOf(clean));
      const stems = this.byStem.get(stem);
      if (stems?.length === 1) return stems[0]!;
      return null;
    }
    if (kind === "wiki") {
      const name = value.replace(/[#^].*$/, "").trim();
      if (!name) return null;
      if (name.includes("/")) {
        const withExt = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
        for (const [p, key] of this.byPath) if (p === withExt || p.endsWith(`/${withExt}`) || fold(p).endsWith(`/${fold(withExt)}`)) return key;
      }
      const stem = fold(stemOf(name.includes(".") && isNoteFile(name) ? name : `${name}.md`));
      const stems = this.byStem.get(stem) ?? this.byStem.get(fold(name));
      if (stems?.length) return stems[0]!;
      return this.byTitle.get(fold(name)) ?? null;
    }
    return null;
  }

  asset(src: string, fromPath: string): string | null {
    const raw = src.trim();
    if (raw.startsWith("wiki:")) {
      const name = raw.slice(5).replace(/#.*$/, "").trim();
      if (this.files.has(name)) return name;
      const list = this.filesByBase.get(fold(baseOf(name)));
      if (list?.length) {
        const sameDir = list.find((p) => dirOf(p) === dirOf(fromPath));
        return sameDir ?? list.find((p) => p.endsWith(name)) ?? list[0]!;
      }
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
    let value = raw.replace(/[?#].*$/, "");
    try {
      value = decodeURIComponent(value);
    } catch {}
    const full = joinPath(dirOf(fromPath), value);
    if (full !== null && this.files.has(full)) return full;
    if (this.files.has(value)) return value;
    const list = this.filesByBase.get(fold(baseOf(value)));
    if (list?.length === 1) return list[0]!;
    if (list?.length) return list.find((p) => full !== null && fold(p).endsWith(fold(full))) ?? list.find((p) => dirOf(p).startsWith(dirOf(fromPath))) ?? null;
    return null;
  }

  pageAt(path: string): string | null {
    return this.byPath.get(path) ?? null;
  }

  hasFile(path: string) {
    return this.files.has(path);
  }

  size(path: string) {
    return this.files.get(path)?.size ?? 0;
  }
}

const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico|pdf|mp3|wav|m4a|ogg|flac|mp4|mov|webm|mkv|zip|docx?|xlsx?|pptx?|csv|txt|json|key|pages|numbers|epub|excalidraw)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico)$/i;

export function fixEmbeds(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    const children = b.children ? fixEmbeds(b.children) : undefined;
    if (b.type === "image" && b.src?.startsWith("wiki:")) {
      const name = b.src.slice(5).replace(/#.*$/, "");
      if (!ATTACHMENT.test(name) || /\.md$/i.test(name)) return { type: "pageRef", target: b.src, ...(children ? { children } : {}) };
      if (!IMAGE.test(name)) return { ...b, type: "file", ...(children ? { children } : {}) };
    }
    if (b.type === "image" && b.src && !IMAGE.test(b.src.replace(/[?#].*$/, "")) && !/^https?:/i.test(b.src) && ATTACHMENT.test(b.src.replace(/[?#].*$/, ""))) return { ...b, type: "file", ...(children ? { children } : {}) };
    return children ? { ...b, children } : b;
  });
}

export function propertiesBlock(data: Record<string, unknown>, skip: string[] = []): Block | null {
  const entries = Object.entries(data).filter(([k, v]) => !skip.includes(k.toLowerCase()) && v !== "" && v !== null && v !== undefined);
  if (!entries.length) return null;
  return {
    type: "toggleListItem",
    content: [{ t: "text", text: "Properties", marks: { bold: true } }],
    children: entries.slice(0, 100).map(([k, v]) => ({
      type: "bulletListItem",
      content: [
        { t: "text", text: `${k}: `, marks: { bold: true } },
        { t: "text", text: (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 2000) },
      ],
    })),
  };
}
