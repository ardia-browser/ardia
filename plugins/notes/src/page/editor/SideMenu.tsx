import { SideMenuExtension, SuggestionMenu } from "@blocknote/core/extensions";
import { useBlockNoteEditor, useExtension, useExtensionState } from "@blocknote/react";
import { useState } from "react";
import { offset } from "@floating-ui/react";
import { Icon } from "../ui/icons";
import { BlockMenu } from "./BlockMenu";
import { useNotesEnv } from "./env";
import { contentKind, selectBlocks, selectedBlockIds } from "./ops";
import type { NotesEditor } from "./schema";
import { exitRef, MOTION } from "../ui/motion";

const sideMenuExit = exitRef<HTMLDivElement>("is-fading", MOTION.exit);

const SIDE_MENU_HEIGHT = 24;
const FIRST_LINE = ".db-inline-title, .bn-inline-content";

export function firstLineOffset(target: unknown): number {
  const context = target && typeof target === "object" && "contextElement" in target ? (target as { contextElement?: unknown }).contextElement : target;
  const reference = context instanceof Element ? context : null;
  if (!reference) return 0;
  const content = reference.matches(".bn-block-content") ? reference : reference.querySelector(".bn-block-content");
  if (!content) return 0;
  const line = content.querySelector<HTMLElement>(FIRST_LINE) ?? (content as HTMLElement);
  const style = getComputedStyle(line);
  const fontSize = parseFloat(style.fontSize) || 16;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
  const top = line.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
  const offset = top + lineHeight / 2 - SIDE_MENU_HEIGHT / 2 - reference.getBoundingClientRect().top;
  return Math.max(0, Math.round(offset * 2) / 2);
}

export const sideMenuFloating = {
  useTransitionStylesProps: { duration: { open: 120, close: 90 } },
  useFloatingOptions: { middleware: [offset(({ elements }) => ({ crossAxis: firstLineOffset(elements.reference) }))] },
};

type AnyBlock = { id: string; type: string; props: Record<string, any>; content: any; children: any[] };

export const sideMenuEvents = { onComment: (_blocks: AnyBlock[]) => {} };

export function NotesSideMenu() {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const env = useNotesEnv();
  const sideMenu = useExtension(SideMenuExtension);
  const suggestions = useExtension(SuggestionMenu);
  const block = useExtensionState(SideMenuExtension, { selector: (s) => s?.block }) as AnyBlock | undefined;
  const [menu, setMenu] = useState<{ anchor: HTMLElement; blocks: AnyBlock[] } | null>(null);
  if (!block || env.readOnly) return null;
  const add = (above: boolean) => {
    const empty = Array.isArray(block.content) && block.content.length === 0;
    if (empty && !above) {
      editor.setTextCursorPosition(block.id);
    } else {
      const inserted = editor.insertBlocks([{ type: "paragraph" }] as never, block.id, above ? "before" : "after")[0]!;
      editor.setTextCursorPosition(inserted);
    }
    editor.focus();
    suggestions.openSuggestionMenu("/");
  };
  return (
    <div ref={sideMenuExit} className="n-sidemenu" data-testid="side-menu">
      <button
        type="button"
        className="n-sidemenu-button"
        aria-label="Add a block below"
        title="Click to add below&#10;⌥-click to add a block above"
        data-testid="side-add"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => add(e.altKey)}
      >
        <Icon name="plus" size={16} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="n-sidemenu-button is-drag"
        aria-label="Drag to move, click to open the block menu"
        title="Drag to move&#10;Click to open menu"
        data-testid="drag-handle"
        draggable
        onDragStart={(e) => {
          dragState.blocks = selectedBlockIds(editor).includes(block.id) ? selectedBlockIds(editor) : [block.id];
          sideMenu.blockDragStart(e, block as never);
        }}
        onDragEnd={() => {
          sideMenu.blockDragEnd();
          dragState.blocks = [];
        }}
        onClick={(e) => {
          const ids = selectedBlockIds(editor);
          const blocks = ids.length > 1 && ids.includes(block.id) ? (ids.map((id) => editor.getBlock(id)).filter(Boolean) as unknown as AnyBlock[]) : [block];
          if (blocks.length === 1) selectBlocks(editor, [block.id]);
          sideMenu.freezeMenu();
          setMenu({ anchor: e.currentTarget, blocks });
        }}
      >
        <Icon name="drag" size={16} />
      </button>
      {menu ? (
        <BlockMenu
          anchor={menu.anchor}
          editor={editor}
          env={env}
          blocks={menu.blocks}
          onComment={(blocks) => sideMenuEvents.onComment(blocks)}
          onClose={() => {
            setMenu(null);
            sideMenu.unfreezeMenu();
            if (contentKind(editor, block.type) !== "none" && editor.getBlock(block.id)) editor.focus();
          }}
        />
      ) : null}
    </div>
  );
}

export const dragState: { blocks: string[] } = { blocks: [] };
