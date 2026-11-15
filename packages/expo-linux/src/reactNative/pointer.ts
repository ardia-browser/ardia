export type PointerSample = { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; doc?: Document | null };

type Watcher = (sample: PointerSample | null) => void;

const watchers = new Set<Watcher>();
let last: PointerSample | null = null;
let installed = false;

const publish = () => {
  for (const watcher of [...watchers]) watcher(last);
};

function sample(e: MouseEvent): PointerSample {
  const doc = (e.target as Node | null)?.ownerDocument ?? ((e.target as Document | null)?.nodeType === 9 ? (e.target as Document) : null);
  return { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, doc };
}

function move(e: MouseEvent) {
  last = sample(e);
  publish();
}

function out(e: MouseEvent) {
  const to = e.relatedTarget;
  if (to && (to as Node).nodeName !== "IFRAME") return;
  last = null;
  publish();
}

function install() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerdown", move, true);
  window.addEventListener("pointerup", move, true);
  document.addEventListener("mouseout", out, true);
  window.addEventListener("scroll", publish, true);
  window.addEventListener("resize", publish);
}

export function watchPointer(watcher: Watcher) {
  install();
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

export const currentPointer = () => last;

install();
