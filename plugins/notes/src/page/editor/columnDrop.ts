import type { BlockNoteEditor } from "@blocknote/core";
import { dragState } from "./SideMenu";

type AnyEditor = BlockNoteEditor<any, any, any>;
type AnyBlock = { id: string; type: string; props: Record<string, unknown>; content: unknown; children: AnyBlock[] };

const LEFT_EDGE = 20;
const RIGHT_EDGE = 48;

function strip(block: AnyBlock): Record<string, unknown> {
  return { type: block.type, props: block.props, content: block.content, children: block.children.map(strip) };
}

function keepIds(block: AnyBlock): Record<string, unknown> {
  return { id: block.id, type: block.type, props: block.props, content: block.content, children: block.children.map(keepIds) };
}

export function installColumnDrop(editor: AnyEditor): () => void {
  let indicator: HTMLDivElement | null = null;
  let target: { id: string; side: "left" | "right" | "before" | "after" } | null = null;
  let root: HTMLElement | undefined;

  const hide = () => {
    indicator?.remove();
    indicator = null;
    target = null;
  };

  const findTarget = (event: DragEvent) => {
    if (!dragState.blocks.length || !root) return null;
    const els = document.elementsFromPoint(event.clientX, event.clientY);
    for (const el of els) {
      const outer = (el as HTMLElement).closest?.(".bn-block-outer") as HTMLElement | null;
      if (!outer || !root.contains(outer)) continue;
      const id = outer.getAttribute("data-id");
      if (!id || dragState.blocks.includes(id)) return null;
      const block = editor.getBlock(id) as AnyBlock | undefined;
      if (!block || block.type === "column" || block.type === "columnList") continue;
      const parent = editor.getParentBlock(id) as AnyBlock | undefined;
      if (parent && parent.type !== "column") continue;
      const content = outer.querySelector(".bn-block-content") as HTMLElement | null;
      const rect = (content ?? outer).getBoundingClientRect();
      if (event.clientX < rect.left + LEFT_EDGE) return { id, side: "left" as const, rect };
      if (event.clientX > rect.right - RIGHT_EDGE) return { id, side: "right" as const, rect };
      return null;
    }
    return null;
  };

  const findLine = (event: DragEvent) => {
    if (!dragState.blocks.length || !root) return null;
    const dragging = dragState.blocks.map((id) => root!.querySelector(`.bn-block-outer[data-id="${CSS.escape(id)}"]`)).filter((el): el is Element => !!el);
    for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
      const outer = (el as HTMLElement).closest?.(".bn-block-outer") as HTMLElement | null;
      if (!outer || !root.contains(outer)) continue;
      if (dragging.some((d) => d.contains(outer))) return null;
      const id = outer.getAttribute("data-id");
      const block = id ? (editor.getBlock(id) as AnyBlock | undefined) : undefined;
      if (!id || !block || block.type === "column" || block.type === "columnList") continue;
      const content = outer.querySelector(":scope > .bn-block > .bn-block-content") as HTMLElement | null;
      const rect = (content ?? outer).getBoundingClientRect();
      return { id, side: event.clientY < rect.top + rect.height / 2 ? ("before" as const) : ("after" as const), rect };
    }
    return null;
  };

  const show = (found: { side: "left" | "right" | "before" | "after"; rect: DOMRect }) => {
    if (!indicator) {
      indicator = document.createElement("div");
      document.body.append(indicator);
    }
    if (found.side === "left" || found.side === "right") {
      indicator.className = "n-column-drop";
      const x = found.side === "left" ? found.rect.left - 6 : found.rect.right + 4;
      Object.assign(indicator.style, { left: `${x}px`, top: `${found.rect.top}px`, width: "", height: `${Math.max(24, found.rect.height)}px` });
    } else {
      indicator.className = "n-line-drop";
      const y = found.side === "before" ? found.rect.top - 2 : found.rect.bottom;
      Object.assign(indicator.style, { left: `${found.rect.left}px`, top: `${y}px`, width: `${found.rect.width}px`, height: "" });
    }
  };

  const onOver = (event: DragEvent) => {
    if (dragState.blocks.length) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
    const found = findTarget(event) ?? findLine(event);
    if (!found) {
      hide();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    target = { id: found.id, side: found.side };
    show(found);
  };

  const onDrop = (event: DragEvent) => {
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const { id, side } = target;
    hide();
    const dragged = dragState.blocks.map((b) => editor.getBlock(b) as AnyBlock | undefined).filter((b): b is AnyBlock => !!b);
    const block = editor.getBlock(id) as AnyBlock | undefined;
    if (!dragged.length || !block) return;
    const parent = editor.getParentBlock(id) as AnyBlock | undefined;
    if (side === "before" || side === "after") {
      editor.transact(() => {
        editor.removeBlocks(dragged.map((b) => b.id));
        editor.insertBlocks(dragged.map(keepIds) as never, id, side);
      });
      finish();
      return;
    }
    editor.transact(() => {
      const newColumn = { type: "column", props: { width: 1 }, children: dragged.map(strip) };
      if (parent?.type === "column") {
        const list = editor.getParentBlock(parent.id) as AnyBlock | undefined;
        if (list && list.children.length >= 5) return;
        editor.insertBlocks([newColumn] as never, parent.id, side === "left" ? "before" : "after");
      } else {
        const own = { type: "column", props: { width: 1 }, children: [strip(block)] };
        editor.replaceBlocks([block.id], [{ type: "columnList", children: side === "left" ? [newColumn, own] : [own, newColumn] }] as never);
      }
      editor.removeBlocks(dragged.map((b) => b.id));
    });
    finish();
  };

  const finish = () => {
    dragState.blocks = [];
    const view = editor.prosemirrorView;
    view?.dom.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null }));
    view?.dom.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  };

  const attach = () => {
    root = editor.domElement;
    if (!root) return false;
    root.addEventListener("dragover", onOver, true);
    root.addEventListener("drop", onDrop, true);
    root.addEventListener("dragleave", (e) => {
      if (!root?.contains(e.relatedTarget as Node)) hide();
    });
    window.addEventListener("dragend", hide);
    return true;
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  if (!attach()) timer = setInterval(() => attach() && timer && clearInterval(timer), 100);
  return () => {
    if (timer) clearInterval(timer);
    hide();
    root?.removeEventListener("dragover", onOver, true);
    root?.removeEventListener("drop", onDrop, true);
    window.removeEventListener("dragend", hide);
  };
}
