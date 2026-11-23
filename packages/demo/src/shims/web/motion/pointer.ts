export type PointerSample = { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

type Watcher = (sample: PointerSample | null) => void;

const DRAG_CLASS = "ardia-pointer-drag";
const watchers = new Set<Watcher>();
let last: PointerSample | null = null;
let installed = false;
let dragging = false;

const publish = () => {
  for (const watcher of [...watchers]) watcher(last);
};

function setDragging(active: boolean) {
  if (dragging === active) return;
  dragging = active;
  document.documentElement.classList.toggle(DRAG_CLASS, active);
}

function sample(e: MouseEvent): PointerSample {
  return { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
}

function move(e: MouseEvent) {
  if (dragging && e.buttons === 0) setDragging(false);
  last = sample(e);
  publish();
}

function down(e: PointerEvent) {
  if (e.button === 0) setDragging(true);
  last = sample(e);
  publish();
}

function up(e: PointerEvent) {
  setDragging(false);
  last = sample(e);
  publish();
}

function cancel() {
  setDragging(false);
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
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", cancel);
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
