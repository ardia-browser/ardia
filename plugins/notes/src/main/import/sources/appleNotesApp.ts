import { fromBase64 } from "../../../shared/bytes";
import { parseHtml } from "../html";
import { para, textOf, type Block, type ImportNode } from "../ir";
import { IMPORT_LIMITS, ImportError } from "../limits";
import type { Plan } from "../write";

export type AppleNotesFolder = { id: string; name: string; account: string; parent: string; count: number };
export type AppleNotesNote = { id: string; name: string; created: number; modified: number; locked: boolean; body: string };

export type AppleNotesApi = {
  folders(): Promise<AppleNotesFolder[]>;
  notes(folder: string, options: { offset: number; limit: number }): Promise<{ total: number; notes: AppleNotesNote[] }>;
};

const WINDOW = 50;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|heic|tiff|bmp);base64,/i;

const RECENTLY_DELETED = new Set(["recently deleted", "zuletzt gelöscht", "supprimés récemment", "eliminados recientemente", "eliminati di recente"]);

export async function appleNotesPlan(api: AppleNotesApi): Promise<Plan & { total: number }> {
  const folders = (await api.folders()).filter((f) => !RECENTLY_DELETED.has(f.name.trim().toLowerCase()));
  const accounts = [...new Set(folders.map((f) => f.account))];
  const nodes: ImportNode[] = [];
  const known = new Set(folders.map((f) => f.id));
  if (accounts.length > 1) for (const account of accounts) nodes.push({ key: `account:${account}`, parent: null, title: account || "Notes", icon: "🗂️", kind: "page", blocks: [] });
  const cache = new Map<string, { offset: number; notes: AppleNotesNote[] }>();
  let total = 0;
  let warnings = 0;
  const noteAt = async (folder: string, index: number): Promise<AppleNotesNote | null> => {
    let window = cache.get(folder);
    if (!window || index < window.offset || index >= window.offset + window.notes.length) {
      cache.clear();
      const page = await api.notes(folder, { offset: index, limit: WINDOW });
      window = { offset: index, notes: page.notes };
      cache.set(folder, window);
    }
    return window.notes[index - window.offset] ?? null;
  };
  for (const folder of folders) {
    const folderKey = `folder:${folder.id}`;
    const parent = folder.parent && known.has(folder.parent) ? `folder:${folder.parent}` : accounts.length > 1 ? `account:${folder.account}` : null;
    nodes.push({ key: folderKey, parent, title: folder.name || "Notes", icon: "📁", kind: "page", blocks: [] });
    const count = Math.min(folder.count, IMPORT_LIMITS.pages);
    if (count === 0) continue;
    const head = await api.notes(folder.id, { offset: 0, limit: WINDOW });
    cache.set(folder.id, { offset: 0, notes: head.notes });
    const titles: { name: string; created: number; locked: boolean }[] = [];
    for (let i = 0; i < Math.min(head.total, count); i++) {
      const n = i < head.notes.length ? head.notes[i]! : null;
      titles.push({ name: n?.name ?? "", created: n?.created ?? 0, locked: n?.locked ?? false });
    }
    for (let i = 0; i < titles.length; i++) {
      if (total >= IMPORT_LIMITS.pages) throw new ImportError(`Notes holds more than ${IMPORT_LIMITS.pages.toLocaleString("en-US")} notes; import a folder at a time.`);
      total++;
      const index = i;
      const node: ImportNode = { key: `note:${folder.id}:${index}`, parent: folderKey, title: titles[i]!.name || "Untitled", kind: "page", path: `${folder.name}/${titles[i]!.name}`, createdAt: titles[i]!.created || undefined };
      node.load = async (): Promise<Block[]> => {
        const note = await noteAt(folder.id, index);
        if (!note) return [];
        if (note.name) node.title = note.name;
        if (note.created) node.createdAt = note.created;
        if (note.locked) {
          warnings++;
          return [{ type: "callout", props: { icon: "🔒" }, content: [{ t: "text", text: "This note is locked in Apple Notes, so its text wasn't imported." }] }];
        }
        const blocks = parseHtml(note.body);
        const first = blocks[0];
        if (first && (first.type === "heading" || first.type === "paragraph") && textOf(first.content).trim() === note.name.trim()) blocks.shift();
        return blocks.length ? blocks : [para("")];
      };
      nodes.push(node);
    }
  }
  return {
    total,
    nodes: nodes.length ? nodes : [{ key: "empty", parent: null, title: "Nothing to import", kind: "page", blocks: [para("Notes has no notes to import.")] }],
    link: () => null,
    asset: (src) => (DATA_IMAGE.test(src) && src.length <= (IMPORT_LIMITS.attachmentBytes * 4) / 3 + 64 ? src : null),
    assetName: (path) => `image.${(DATA_IMAGE.exec(path)?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg")}`,
    assetSize: (path) => Math.floor(((path.length - path.indexOf(",") - 1) * 3) / 4),
    readAsset: async (path) => fromBase64(path.slice(path.indexOf(",") + 1)),
    get warnings() {
      return warnings;
    },
  };
}
