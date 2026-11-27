import { errorCode, type FileStore } from "../files";
import { IMPORT_LIMITS, ImportError } from "./limits";
import { isZip, ZipReader, type RandomAccess, type ZipEntry } from "./zip";
import { TarReader } from "./tar";
import { ReadAhead } from "./readAhead";

export type VFile = { path: string; size: number };

export interface Vfs {
  readonly files: VFile[];
  read(path: string, max: number): Promise<Uint8Array>;
  range?(path: string): RandomAccess | null;
  fingerprint?(path: string): string | null;
  prefetch?(paths: Iterable<string>): void;
}

export async function rangeOf(vfs: Vfs, path: string, size: number, max: number): Promise<RandomAccess> {
  const direct = vfs.range?.(path);
  if (direct) return direct;
  const bytes = await vfs.read(path, max);
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)) };
}

export type Spool = { create(): Promise<{ append(chunk: Uint8Array): Promise<void>; done(): Promise<RandomAccess> }>; clear(): Promise<void> };

export const extOf = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export function storeAccess(store: FileStore, path: string, size: number): RandomAccess {
  return {
    size,
    async read(offset, length) {
      if (length === 0) return new Uint8Array(0);
      const res = await store.read(path, { offset, length });
      if (!res.found) throw new ImportError(`${path} went away while it was being read.`);
      return res.data;
    },
  };
}

const hidden = (path: string) => path.split("/").some((p) => p.startsWith("."));

async function listAll(store: FileStore): Promise<{ files: VFile[]; placeholders: number }> {
  const files: VFile[] = [];
  let placeholders = 0;
  const take = (entries: { path: string; kind: string; size: number; placeholder: boolean }[], dirs: string[] | null) => {
    for (const e of entries) {
      if (hidden(e.path)) continue;
      if (e.kind === "dir") {
        dirs?.push(e.path);
        continue;
      }
      if (e.placeholder) placeholders++;
      if (files.length >= IMPORT_LIMITS.files) throw new ImportError(`That folder holds more than ${IMPORT_LIMITS.files.toLocaleString("en-US")} files.`);
      files.push({ path: e.path, size: e.size });
    }
  };
  try {
    take(await store.list("", { recursive: true }), null);
  } catch (error) {
    if (errorCode(error) !== "too_large") throw error;
    files.length = 0;
    placeholders = 0;
    const dirs = [""];
    for (let i = 0; i < dirs.length; i++) {
      if (dirs[i]!.split("/").length > 32) continue;
      take(await store.list(dirs[i]!), dirs);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, placeholders };
}

export async function storeVfs(store: FileStore): Promise<Vfs & { placeholders: number }> {
  const { files, placeholders } = await listAll(store);
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    files,
    placeholders,
    async read(path, max) {
      const found = byPath.get(path);
      if (!found) throw new ImportError(`${path} isn't in the export.`);
      if (found.size > max) throw new ImportError(`${path} is too big to import.`);
      const res = await store.read(path);
      if (!res.found) throw new ImportError(`${path} went away while it was being read.`);
      return res.data;
    },
  };
}

export function singleVfs(store: FileStore, name: string, size: number): Vfs {
  return {
    files: [{ path: name, size }],
    async read(path, max) {
      if (path !== name) throw new ImportError(`${path} isn't in the export.`);
      if (size > max) throw new ImportError(`${path} is too big to import.`);
      const res = await store.read(name);
      if (!res.found) throw new ImportError(`${name} went away while it was being read.`);
      return res.data;
    },
  };
}

type Source = { kind: "base"; vfs: Vfs; path: string } | { kind: "zip"; zip: ZipReader; entry: ZipEntry } | { kind: "tar"; tar: TarReader; at: number; size: number };

export class LayeredVfs implements Vfs {
  readonly files: VFile[] = [];
  private readonly where = new Map<string, Source>();
  private readonly sizes = new Map<string, number>();
  refused = 0;
  private nested = 0;
  private readonly ahead = new ReadAhead<string>(
    (path) => this.readNow(path, Math.max(IMPORT_LIMITS.attachmentBytes, IMPORT_LIMITS.textBytes)),
    (path) => this.sizes.get(path) ?? 0,
  );

  constructor(private readonly access: (path: string, size: number) => RandomAccess | null, private readonly spool: Spool | null) {}

  static async build(base: Vfs, access: (path: string, size: number) => RandomAccess | null, spool: Spool | null, onFile?: (path: string) => void): Promise<LayeredVfs> {
    const layered = new LayeredVfs(access, spool);
    for (const f of base.files) await layered.add(f.path, f.size, { kind: "base", vfs: base, path: f.path }, "", onFile);
    return layered;
  }

  private async add(path: string, size: number, source: Source, prefix: string, onFile?: (path: string) => void): Promise<void> {
    const full = prefix ? `${prefix}/${path}` : path;
    const ext = extOf(path);
    if (ext === "zip" || ext === "jex" || ext === "textpack") {
      const opened = await this.openArchive(full, size, source, ext);
      if (opened) {
        onFile?.(full);
        const stem = ext === "textpack" ? full : full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
        if (opened.kind === "zip") for (const e of opened.zip.entries) await this.add(e.name, e.size, { kind: "zip", zip: opened.zip, entry: e }, stem, onFile);
        else for (const e of opened.tar.entries) await this.add(e.name, e.size, { kind: "tar", tar: opened.tar, at: e.offset, size: e.size }, stem, onFile);
        return;
      }
    }
    if (this.files.length >= IMPORT_LIMITS.files) throw new ImportError(`That export holds more than ${IMPORT_LIMITS.files.toLocaleString("en-US")} files.`);
    if (this.where.has(full)) return;
    this.where.set(full, source);
    this.sizes.set(full, size);
    this.files.push({ path: full, size });
  }

  private async openArchive(path: string, size: number, source: Source, ext: string): Promise<{ kind: "zip"; zip: ZipReader } | { kind: "tar"; tar: TarReader } | null> {
    if (++this.nested > IMPORT_LIMITS.nestedZips) throw new ImportError("That export nests too many archives.");
    const access = await this.randomAccess(path, size, source);
    if (!access) return null;
    const head = await access.read(0, Math.min(access.size, 512));
    if (isZip(head)) {
      const zip = await ZipReader.open(access);
      this.refused += zip.refused;
      return { kind: "zip", zip };
    }
    if (ext === "jex" && TarReader.looksLike(head)) {
      const tar = await TarReader.open(access);
      this.refused += tar.refused;
      return { kind: "tar", tar };
    }
    return null;
  }

  private async randomAccess(path: string, size: number, source: Source): Promise<RandomAccess | null> {
    if (source.kind === "base") return this.access(source.path, size);
    if (source.kind === "tar") {
      const { tar, at } = source;
      return { size, read: (offset, length) => tar.readRange(at + offset, Math.min(length, size - offset)) };
    }
    const { zip, entry } = source;
    if (!this.spool) return null;
    const file = await this.spool.create();
    let written = 0;
    await zip.stream(entry, async (chunk) => {
      written += chunk.length;
      if (written > IMPORT_LIMITS.spoolBytes) throw new ImportError(`${path} is too big to unpack.`);
      await file.append(chunk);
    });
    return file.done();
  }

  range(path: string): RandomAccess | null {
    const source = this.where.get(path);
    if (!source) return null;
    if (source.kind === "base") return this.access(source.path, this.sizes.get(path) ?? 0);
    if (source.kind === "tar") {
      const { tar, at, size } = source;
      return { size, read: (offset, length) => tar.readRange(at + offset, Math.max(0, Math.min(length, size - offset))) };
    }
    return null;
  }

  has(path: string): boolean {
    return this.where.has(path);
  }

  fingerprint(path: string): string | null {
    const source = this.where.get(path);
    return source?.kind === "zip" ? `${path}:${source.entry.size}:${source.entry.crc >>> 0}` : null;
  }

  prefetch(paths: Iterable<string>): void {
    const known: string[] = [];
    for (const path of paths) if (this.where.has(path) && (this.sizes.get(path) ?? 0) <= Math.max(IMPORT_LIMITS.attachmentBytes, IMPORT_LIMITS.textBytes)) known.push(path);
    this.ahead.want(known);
  }

  async read(path: string, max: number): Promise<Uint8Array> {
    if (!this.ahead.has(path)) return this.readNow(path, max);
    const data = await this.ahead.take(path);
    if (data.length > max) throw new ImportError(`${path} is too big to import.`);
    return data;
  }

  private async readNow(path: string, max: number): Promise<Uint8Array> {
    const source = this.where.get(path);
    if (!source) throw new ImportError(`${path} isn't in the export.`);
    if (source.kind === "base") return source.vfs.read(source.path, max);
    if (source.kind === "tar") {
      if (source.size > max) throw new ImportError(`${path} is too big to import.`);
      return source.tar.readRange(source.at, source.size);
    }
    return source.zip.read(source.entry, max);
  }
}

export const decodeText = (bytes: Uint8Array): string => {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};
