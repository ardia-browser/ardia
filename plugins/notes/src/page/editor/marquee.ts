import type { BlockNoteEditor } from "@blocknote/core";
import { selectBlocks } from "./ops";

const INTERACTIVE = "button, input, textarea, a, [contenteditable='true'] .bn-block-content, .n-page-header, .n-popover, .n-side-panel, .n-peek, .bn-side-menu, .n-sidemenu";

export function installMarquee(editor: BlockNoteEditor<any, any, any>, scroller: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null;
  let box: HTMLDivElement | null = null;
  let picked: string[] = [];

  const topBlocks = () => {
    const dom = editor.domElement;
    const root = dom?.classList.contains("bn-editor") ? dom : (dom?.querySelector<HTMLElement>(".bn-editor") ?? scroller.querySelector<HTMLElement>(".n-page-column .bn-editor"));
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>(":scope > .bn-block-group > .bn-block-outer")];
  };

  const onMove = (event: PointerEvent) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!box && Math.hypot(dx, dy) < 5) return;
    event.preventDefault();
    if (!box) {
      box = document.createElement("div");
      box.className = "n-marquee";
      document.body.append(box);
      window.getSelection()?.removeAllRanges();
    }
    const left = Math.min(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY);
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    const hits = topBlocks().filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > top && r.top < top + height;
    });
    picked = hits.map((el) => el.getAttribute("data-id") ?? "").filter(Boolean);
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    if (box) {
      box.remove();
      box = null;
      if (picked.length) {
        editor.focus();
        selectBlocks(editor, picked);
      }
    }
    start = null;
    picked = [];
  };

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || !editor.isEditable) return;
    const target = event.target as HTMLElement;
    if (target.closest(INTERACTIVE)) return;
    if (target.closest(".bn-block-content") || target.closest(".n-title")) return;
    start = { x: event.clientX, y: event.clientY };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  };

  scroller.addEventListener("pointerdown", onDown);
  return () => {
    scroller.removeEventListener("pointerdown", onDown);
    onUp();
  };
}
