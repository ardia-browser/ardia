export type PointerSample = { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

type Watcher = (sample: PointerSample | null) => void;

const watchers = new Set<Watcher>();
let last: PointerSample | null = null;
let installed = false;
let frame = 0;

const publish = () => {
  if (frame) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
  }
  for (const watcher of [...watchers]) watcher(last);
};

const schedulePublish = () => {
  if (!watchers.size || !last) return;
  if (typeof requestAnimationFrame !== "function") return publish();
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    publish();
  });
};

function sample(e: MouseEvent): PointerSample {
  return { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
}

function move(e: MouseEvent) {
  last = sample(e);
  publish();
}

function out(e: MouseEvent) {
  const to = e.relatedTarget;
  if (to && !(to instanceof HTMLIFrameElement)) return;
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
  window.addEventListener("scroll", schedulePublish, true);
  window.addEventListener("resize", schedulePublish);
}

install();

export function watchPointer(watcher: Watcher) {
  install();
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

export const currentPointer = () => last;
