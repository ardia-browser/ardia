import { IMPORT_LIMITS, ImportError } from "./limits";
import { cleanEntryName, type RandomAccess } from "./zip";

export type TarEntry = { name: string; offset: number; size: number };

const text = (b: Uint8Array, at: number, len: number) => {
  let end = at;
  while (end < at + len && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(at, end));
};

const octal = (b: Uint8Array, at: number, len: number) => {
  const s = text(b, at, len).trim();
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : s === "" ? 0 : -1;
};

export class TarReader {
  private constructor(readonly entries: TarEntry[], readonly refused: number, private readonly source: RandomAccess) {}

  static looksLike(head: Uint8Array): boolean {
    return head.length >= 512 && text(head, 257, 5) === "ustar";
  }

  static async open(source: RandomAccess): Promise<TarReader> {
    const entries: TarEntry[] = [];
    let refused = 0;
    let at = 0;
    let longName: string | null = null;
    while (at + 512 <= source.size) {
      const head = await source.read(at, 512);
      if (head.every((b) => b === 0)) break;
      const size = octal(head, 124, 12);
      if (size < 0) throw new ImportError("That archive is damaged.");
      const type = String.fromCharCode(head[156] || 48);
      const prefix = text(head, 345, 155);
      let name = longName ?? (prefix ? `${prefix}/${text(head, 0, 100)}` : text(head, 0, 100));
      longName = null;
      const data = at + 512;
      if (data + size > source.size) throw new ImportError("That archive is cut short.");
      if (type === "L") {
        longName = new TextDecoder().decode(await source.read(data, Math.min(size, 4096))).replace(/\u0000+$/, "");
      } else if (type === "0" || type === "\u0000") {
        const clean = cleanEntryName(name);
        if (!clean) refused++;
        else {
          if (entries.length >= IMPORT_LIMITS.files) throw new ImportError("That archive holds too many files.");
          entries.push({ name: clean, offset: data, size });
        }
      } else if (type !== "5" && type !== "x" && type !== "g") refused++;
      name = "";
      at = data + Math.ceil(size / 512) * 512;
    }
    return new TarReader(entries, refused, source);
  }

  readRange(offset: number, length: number): Promise<Uint8Array> {
    return this.source.read(offset, length);
  }
}
