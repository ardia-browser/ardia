import { displayTitle, type PageMeta } from "../../shared/model";
import type { NotesClient } from "../client/types";
import type { NotesEditor } from "../editor/schema";
import { toast } from "../ui/toast";

type Inline = { type: string; text?: string; href?: string; styles?: Record<string, unknown>; content?: unknown; props?: Record<string, unknown> };
type ExportBlock = { content?: unknown; children?: ExportBlock[] } & Record<string, unknown>;
export type PageLookup = (id: string) => Pick<PageMeta, "id" | "title" | "kind"> | null;

function plainInline(item: Inline, pageOf: PageLookup): Inline | Inline[] {
  if (item.type !== "mention") return item;
  const props = item.props ?? {};
  const kind = String(props.kind ?? "");
  if (kind === "page") {
    const page = pageOf(String(props.pageId ?? ""));
    if (!page) return { type: "text", text: "@Unknown page", styles: {} };
    return { type: "text", text: displayTitle(page), styles: {} };
  }
  if (kind === "date") return { type: "text", text: `@${String(props.date ?? "")}`, styles: {} };
  return { type: "text", text: `@${String(props.name ?? "")}`, styles: {} };
}

export function exportableBlocks<T extends ExportBlock>(blocks: T[], pageOf: PageLookup): T[] {
  return blocks.map((block) => ({
    ...block,
    content: Array.isArray(block.content) ? (block.content as Inline[]).flatMap((item) => plainInline(item, pageOf)) : block.content,
    children: exportableBlocks(block.children ?? [], pageOf),
  }));
}

export function exportMarkdown(editor: NotesEditor, meta: PageMeta, pageOf: PageLookup = () => null): string {
  const body = editor.blocksToMarkdownLossy(exportableBlocks(editor.document as never, pageOf) as never);
  return `# ${meta.icon && !meta.icon.startsWith("file:") ? `${meta.icon} ` : ""}${displayTitle(meta)}\n\n${body}`;
}

export function exportHtml(editor: NotesEditor, meta: PageMeta, pageOf: PageLookup = () => null): string {
  const body = editor.blocksToHTMLLossy(exportableBlocks(editor.document as never, pageOf) as never);
  const title = displayTitle(meta).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:708px;margin:48px auto;padding:0 24px}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

export const lastExport: { name: string; type: string; text: string } = { name: "", type: "", text: "" };

export async function exportText(client: NotesClient, name: string, type: string, text: string) {
  if (!client.canExportFiles) return downloadText(name, type, text);
  lastExport.name = name;
  lastExport.type = type;
  lastExport.text = text;
  try {
    const saved = await client.call("exportFile", { name, text });
    if (saved) toast(`Exported ${saved.name} to ${saved.folder}`);
  } catch (e) {
    toast(`Couldn't export: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function downloadText(name: string, type: string, text: string) {
  lastExport.name = name;
  lastExport.type = type;
  lastExport.text = text;
  const safe = name.replace(/[\\/:*?"<>|]+/g, "-");
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = safe;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {}
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast(`Exported ${safe} — also copied to the clipboard`))
    .catch(() => toast(`Exported ${safe}`));
}

export function importMarkdown(editor: NotesEditor): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve();
      insertMarkdown(editor, await file.text());
      toast(`Imported ${file.name}`);
      resolve();
    };
    input.click();
  });
}

export function insertMarkdown(editor: NotesEditor, markdown: string) {
  const blocks = editor.tryParseMarkdownToBlocks(markdown);
  if (!blocks.length) return;
  const doc = editor.document;
  const last = doc.at(-1) as { id: string; type: string; content?: unknown[] } | undefined;
  if (doc.length === 1 && last && last.type === "paragraph" && !last.content?.length) editor.replaceBlocks([last.id], blocks as never);
  else if (last) editor.insertBlocks(blocks as never, last.id, "after");
}
