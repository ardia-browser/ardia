import type { BlockNoteEditor } from "@blocknote/core";
import { animateHeight, EASE, ghostOut, MOTION, reducedMotion } from "../ui/motion";

type AnyEditor = BlockNoteEditor<any, any, any>;
type Rects = Map<string, DOMRect>;

const OUTER = ".bn-block-outer[data-id]";

function root(editor: AnyEditor): HTMLElement | null {
  try {
    const dom = editor.prosemirrorView?.dom as HTMLElement | undefined;
    return dom?.isConnected ? dom : null;
  } catch {
    return null;
  }
}

export function snapshotBlocks(editor: AnyEditor): Rects {
  const out: Rects = new Map();
  root(editor)?.querySelectorAll<HTMLElement>(OUTER).forEach((el) => {
    const id = el.getAttribute("data-id");
    if (id && !out.has(id)) out.set(id, el.getBoundingClientRect());
  });
  return out;
}

export function playBlocks(editor: AnyEditor, before: Rects, options: { enter?: boolean } = {}) {
  const dom = root(editor);
  if (!dom || !before.size) return;
  const reduced = reducedMotion();
  const moved = new Set<Element>();
  dom.querySelectorAll<HTMLElement>(OUTER).forEach((el) => {
    const parent = el.parentElement?.closest(OUTER);
    if (parent && moved.has(parent)) return;
    const id = el.getAttribute("data-id")!;
    const prev = before.get(id);
    const next = el.getBoundingClientRect();
    if (!prev) {
      if (options.enter) {
        moved.add(el);
        el.animate([{ opacity: 0, transform: reduced ? "none" : "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: MOTION.base, easing: EASE.out });
      }
      return;
    }
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    moved.add(el);
    if (reduced) el.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: MOTION.fast, easing: EASE.out });
    else el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOTION.base, easing: EASE.out });
  });
}

export function withBlockMotion<T>(editor: AnyEditor, action: () => T, removing: string[] = []): T {
  const dom = root(editor);
  for (const id of removing) {
    const el = dom?.querySelector(`.bn-block-outer[data-id="${id}"]`);
    if (el) ghostOut(el, "is-row-leaving", MOTION.base);
  }
  const before = snapshotBlocks(editor);
  const result = action();
  requestAnimationFrame(() => playBlocks(editor, before, { enter: true }));
  return result;
}

export function fadeBlockIn(editor: AnyEditor, id: string) {
  requestAnimationFrame(() => {
    const el = root(editor)?.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"] > .bn-block > .bn-block-content`);
    el?.animate([{ opacity: 0, transform: reducedMotion() ? "none" : "translateY(-3px)" }, { opacity: 1, transform: "none" }], { duration: MOTION.base, easing: EASE.out });
  });
}

const CONTENT = ".bn-block-content[data-content-type]";

function contentKey(el: Element): string {
  return `${el.getAttribute("data-content-type")}:${el.getAttribute("data-level") ?? ""}`;
}

function watchTypeChanges(dom: HTMLElement): () => void {
  const kinds = new WeakMap<Element, string>();
  const remember = (scope: ParentNode) => scope.querySelectorAll(OUTER).forEach((outer) => {
    const content = outer.querySelector(`:scope > .bn-block > ${CONTENT}, :scope > ${CONTENT}`);
    if (content) kinds.set(outer, contentKey(content));
  });
  remember(dom);
  const observer = new MutationObserver((records) => {
    const changed = new Set<HTMLElement>();
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as HTMLElement;
        if (target.matches(CONTENT)) changed.add(target);
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.matches(CONTENT)) changed.add(node);
      });
    }
    for (const content of changed) {
      const outer = content.closest(OUTER);
      if (!outer) continue;
      const next = contentKey(content);
      const before = kinds.get(outer);
      kinds.set(outer, next);
      if (before && before !== next) content.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: MOTION.fast, easing: EASE.out });
    }
    for (const record of records) record.addedNodes.forEach((node) => node instanceof HTMLElement && node.matches(OUTER) && remember(node.parentElement ?? node));
  });
  observer.observe(dom, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-content-type", "data-level"] });
  return () => observer.disconnect();
}

export function installBlockMotion(editor: AnyEditor): () => void {
  const dom = root(editor);
  if (!dom) return () => {};
  const stopTypes = watchTypeChanges(dom);
  let dragBefore: Rects | null = null;
  const onDragStart = () => {
    dragBefore = snapshotBlocks(editor);
  };
  const onDrop = () => {
    const before = dragBefore;
    dragBefore = null;
    if (before) requestAnimationFrame(() => requestAnimationFrame(() => playBlocks(editor, before)));
  };
  const onToggle = (event: MouseEvent) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".bn-toggle-button");
    if (!button || button.dataset.motionPass === "1") return;
    const frame = button.closest(".bn-toggle-frame");
    const group = frame?.querySelector<HTMLElement>(":scope > .bn-toggle-slot > .bn-block-group");
    const expanded = button.getAttribute("aria-expanded") === "true";
    if (expanded && group) {
      event.preventDefault();
      event.stopImmediatePropagation();
      animateHeight(group, false, () => {
        button.dataset.motionPass = "1";
        button.click();
        delete button.dataset.motionPass;
      });
      return;
    }
    requestAnimationFrame(() => {
      const opened = frame?.querySelector<HTMLElement>(":scope > .bn-toggle-slot > .bn-block-group");
      if (opened && button.getAttribute("aria-expanded") === "true") animateHeight(opened, true);
    });
  };
  document.addEventListener("dragstart", onDragStart, true);
  dom.addEventListener("drop", onDrop, true);
  dom.addEventListener("click", onToggle, true);
  return () => {
    stopTypes();
    document.removeEventListener("dragstart", onDragStart, true);
    dom.removeEventListener("drop", onDrop, true);
    dom.removeEventListener("click", onToggle, true);
  };
}
