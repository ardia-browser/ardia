import { useMemo } from "react";
import { allPages, ancestorsOf, displayTitle, isArchivedDeep } from "../../shared/model";
import { PageIcon } from "../ui/icons";
import { Menu, type MenuEntry } from "../ui/Menu";
import type { Anchor } from "../ui/Popover";
import { NOTION_COLORS, TEXT_KINDS, colorLabel, kindOfBlock } from "./blockTypes";
import type { NotesEnv } from "./env";
import { appendBlocksToPage, blockLink, duplicateBlocks, removeBlocks, turnInto } from "./ops";
import type { NotesEditor } from "./schema";
import { toast } from "../ui/toast";

type AnyBlock = { id: string; type: string; props: Record<string, any>; content: any; children: any[] };

export function colorEntries(editor: NotesEditor, blocks: AnyBlock[]): MenuEntry[] {
  const first = blocks[0];
  const set = (props: Record<string, string>) => editor.transact(() => blocks.forEach((b) => editor.updateBlock(b.id, { props } as never)));
  return [
    { kind: "heading", label: "Text color" },
    ...NOTION_COLORS.map((c): MenuEntry => ({
      id: `text-${c}`,
      label: c === "default" ? "Default text" : `${colorLabel(c)} text`,
      icon: <span className={`n-color-chip n-swatch-${c}`}>A</span>,
      checked: (first?.props.textColor ?? "default") === c,
      onSelect: () => set({ textColor: c }),
    })),
    { kind: "heading", label: "Background color" },
    ...NOTION_COLORS.map((c): MenuEntry => ({
      id: `bg-${c}`,
      label: c === "default" ? "Default background" : `${colorLabel(c)} background`,
      icon: <span className={`n-color-chip n-swatch-${c}-bg`}>A</span>,
      checked: (first?.props.backgroundColor ?? "default") === c,
      onSelect: () => set({ backgroundColor: c }),
    })),
  ];
}

export function turnIntoEntries(editor: NotesEditor, env: NotesEnv, blocks: AnyBlock[]): MenuEntry[] {
  const current = blocks[0] ? kindOfBlock(blocks[0]) : undefined;
  return [
    ...TEXT_KINDS.map((kind): MenuEntry => ({ id: `turn-${kind.key}`, label: kind.title, icon: kind.icon, checked: current?.key === kind.key, onSelect: () => turnInto(editor, blocks, kind) })),
    {
      id: "turn-page",
      label: "Page",
      icon: "page",
      onSelect: () => {
        void (async () => {
          const title = blocks.length === 1 ? String((blocks[0]?.content ?? []).map((c: any) => c.text ?? "").join("")) : "";
          const id = await env.createChildPage({ title });
          const rest = blocks.length === 1 ? (blocks[0]?.children ?? []) : blocks;
          if (rest.length) await appendBlocksToPage(env.client, env.workspace, id, rest as never);
          editor.replaceBlocks(blocks.map((b) => b.id), [{ type: "subpage", props: { pageId: id } }] as never);
        })();
      },
    },
  ];
}

export function moveToEntries(env: NotesEnv, exclude: string, onPick: (page: string) => void): MenuEntry[] {
  const pages = allPages(env.tree)
    .filter((p) => !isArchivedDeep(env.tree, p.id) && p.id !== exclude && p.kind === "page")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return pages.map((p) => ({
    id: `move-${p.id}`,
    label: displayTitle(p),
    detail: ancestorsOf(env.tree, p.id).map((a) => displayTitle(a)).join(" / ") || undefined,
    icon: <PageIcon icon={p.icon} />,
    onSelect: () => onPick(p.id),
  }));
}

export function BlockMenu({ anchor, onClose, editor, env, blocks, onComment }: { anchor: Anchor; onClose: () => void; editor: NotesEditor; env: NotesEnv; blocks: AnyBlock[]; onComment: (blocks: AnyBlock[]) => void }) {
  const entries = useMemo((): MenuEntry[] => {
    const first = blocks[0];
    const out: MenuEntry[] = [];
    if (first?.type === "table") {
      const content = first.content as { headerRows?: number; headerCols?: number };
      out.push(
        { id: "header-row", label: "Header row", icon: "table", checked: !!content.headerRows, onSelect: () => editor.updateBlock(first.id, { content: { ...content, headerRows: content.headerRows ? undefined : 1 } } as never) },
        { id: "header-col", label: "Header column", icon: "table", checked: !!content.headerCols, onSelect: () => editor.updateBlock(first.id, { content: { ...content, headerCols: content.headerCols ? undefined : 1 } } as never) },
        { kind: "separator" },
      );
    }
    out.push(
      { id: "delete", label: "Delete", icon: "trash", hint: "Del", onSelect: () => removeBlocks(editor, blocks as never) },
      { id: "duplicate", label: "Duplicate", icon: "duplicate", hint: "⌘D", onSelect: () => duplicateBlocks(editor, blocks as never) },
      { id: "turn-into", label: "Turn into", icon: "turn", submenu: () => turnIntoEntries(editor, env, blocks) },
      {
        id: "copy-link",
        label: "Copy link to block",
        icon: "link",
        hint: "⌥⇧L",
        onSelect: () => {
          if (!first) return;
          void navigator.clipboard?.writeText(blockLink(env.tree, env.page, first.id)).catch(() => {});
          toast("Copied link to block");
        },
      },
      {
        id: "move-to",
        label: "Move to",
        icon: "move",
        submenu: () =>
          moveToEntries(env, env.page, (target) => {
            void appendBlocksToPage(env.client, env.workspace, target, blocks as never).then(() => {
              removeBlocks(editor, blocks as never);
              const meta = allPages(env.tree).find((p) => p.id === target);
              toast(`Moved to ${meta ? displayTitle(meta) : "page"}`);
            });
          }),
      },
      { id: "comment", label: "Comment", icon: "comment", hint: "⌘⇧M", onSelect: () => onComment(blocks) },
      { kind: "separator" },
      { id: "color", label: "Color", icon: "color", submenu: () => colorEntries(editor, blocks) },
    );
    return out;
  }, [blocks, editor, env]);
  return <Menu anchor={anchor} onClose={onClose} entries={entries} search searchPlaceholder="Search actions…" width={265} placement="left-start" testId="block-menu" />;
}
