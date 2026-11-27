import * as Y from "yjs";
import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { blocksOf, pagePath, getPage } from "../../shared/model";
import { pageDocId } from "../../shared/protocol";
import type { NotesClient } from "../client/types";
import { schema, type NotesEditor } from "./schema";
import type { BlockKind } from "./blockTypes";
import { withBlockMotion } from "./blockMotion";

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = { id: string; type: string; props: Record<string, any>; content: any; children: AnyBlock[] };

let headless: NotesEditor | null = null;
export function headlessEditor(): NotesEditor {
  headless ??= BlockNoteEditor.create({ schema }) as NotesEditor;
  return headless;
}

export function blockText(block: AnyBlock): string {
  const content = block.content;
  if (!content) return "";
  if (Array.isArray(content))
    return content
      .map((c: any) => {
        if (typeof c.text === "string") return c.text;
        if (c.type === "link") return (c.content ?? []).map((t: any) => t.text).join("");
        if (typeof c.content === "string") return c.content;
        return "";
      })
      .join("");
  return "";
}

export function contentKind(editor: AnyEditor, type: string): string {
  return (editor.schema.blockSchema as Record<string, { content: string }>)[type]?.content ?? "none";
}

export function turnInto(editor: AnyEditor, blocks: AnyBlock[], kind: Pick<BlockKind, "type" | "props">) {
  editor.transact(() => {
    for (const block of blocks) {
      const from = contentKind(editor, block.type);
      const to = contentKind(editor, kind.type);
      const update: Record<string, unknown> = { type: kind.type, props: kind.props ?? {} };
      if (from !== to) {
        if (to === "plain" || to === "inline") update.content = blockText(block);
        else update.content = undefined;
      }
      editor.updateBlock(block, update as never);
    }
  });
}

function stripIds(block: AnyBlock): Record<string, unknown> {
  return { type: block.type, props: block.props, content: block.content, children: (block.children ?? []).map(stripIds) };
}

export function duplicateBlocks(editor: AnyEditor, blocks: AnyBlock[]) {
  if (!blocks.length) return;
  const inserted = withBlockMotion(editor, () => editor.insertBlocks(blocks.map(stripIds) as never, blocks.at(-1)!, "after"));
  const last = inserted.at(-1);
  if (last && contentKind(editor, last.type) !== "none") editor.setTextCursorPosition(last, "end");
}

export function removeBlocks(editor: AnyEditor, blocks: AnyBlock[]) {
  if (blocks.length) withBlockMotion(editor, () => editor.removeBlocks(blocks), blocks.map((b) => b.id));
}

export function selectBlocks(editor: AnyEditor, ids: string[]) {
  if (!ids.length) return;
  const view = editor.prosemirrorView;
  if (!view) return;
  const doc = view.state.doc;
  if (ids.length === 1) {
    const found = getNodeById(ids[0]!, doc);
    if (!found) return;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, found.posBeforeNode)));
    view.focus();
    return;
  }
  editor.setSelection(ids[0]!, ids.at(-1)!);
  view.focus();
}

export function selectedBlockIds(editor: AnyEditor): string[] {
  const view = editor.prosemirrorView;
  if (!view) return [];
  const { selection } = view.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "blockContainer") return [String(selection.node.attrs.id)];
  const blocks = editor.getSelection()?.blocks;
  if (blocks?.length) return blocks.map((b) => b.id);
  return [editor.getTextCursorPosition().block.id];
}

export function isBlockSelection(editor: AnyEditor): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;
  const { selection } = view.state;
  return selection instanceof NodeSelection || (!(selection instanceof TextSelection) && !selection.empty);
}

export function blockLink(tree: Y.Doc, page: string, blockId: string): string {
  const meta = getPage(tree, page);
  return `ardia://notes${meta ? pagePath(meta) : `/${page}`}?block=${blockId}`;
}

export async function appendBlocksToPage(client: NotesClient, workspace: string, page: string, blocks: AnyBlock[]) {
  const opened = client.open(workspace, pageDocId(page));
  try {
    await opened.synced;
    const temp = new Y.Doc();
    const fragment = temp.getXmlFragment("blocks");
    blocksToYXmlFragment(headlessEditor(), blocks.map(stripIds) as never, fragment);
    const target = blocksOf(opened.doc);
    opened.doc.transact(() => {
      const group = target.get(0);
      const sourceGroup = fragment.get(0);
      if (group instanceof Y.XmlElement && sourceGroup instanceof Y.XmlElement) {
        group.insert(group.length, sourceGroup.toArray().map((n) => (n as Y.XmlElement).clone()) as Y.XmlElement[]);
      } else {
        target.insert(target.length, fragment.toArray().map((n) => (n as Y.XmlElement).clone()) as Y.XmlElement[]);
      }
    });
  } finally {
    setTimeout(() => opened.release(), 500);
  }
}

export function fragmentBlocks(fragment: Y.XmlFragment) {
  return yXmlFragmentToBlocks(headlessEditor(), fragment) as unknown as AnyBlock[];
}

export function writeBlocks(fragment: Y.XmlFragment, blocks: unknown[]) {
  blocksToYXmlFragment(headlessEditor(), blocks as never, fragment);
}
