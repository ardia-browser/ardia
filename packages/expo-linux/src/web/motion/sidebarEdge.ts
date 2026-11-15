import { callMain, mainModules } from "../../bridge";
import { emitNativeEvent } from "../../events";
import { appWindowDocument } from "../../windows/appWindows";
import { currentPointer, watchPointer, type PointerSample } from "../../reactNative/pointer";

const ENGINE_MODULE = "ArdiaLinuxEdgePointer";
const ENGINE_WATCH = "watchSidebarEdge";
const LEAST_BAND = 12;
const HOLDING_CLASS = "ardia-pointer-hold";

type Watch = { hold: number; right: boolean; whilePressed: boolean };

const watched = new Map<string, Watch>();
const over = new Set<string>();
const unreported = new Set<string>();
let stopWatching: (() => void) | null = null;

const engineDecides = () => !!mainModules()[ENGINE_MODULE]?.async.includes(ENGINE_WATCH);

function isOverAt(doc: Document | null, x: number, y: number, { hold, right }: Watch) {
  if (!doc || doc.fullscreenElement) return false;
  const width = doc.documentElement.clientWidth;
  const height = doc.documentElement.clientHeight;
  if (y < 0 || y >= height) return false;
  if (right) return x < width && x >= width - Math.max(hold, LEAST_BAND);
  return x >= 0 && x < Math.max(hold, LEAST_BAND);
}

function check(pointer: PointerSample | null = currentPointer()) {
  for (const [id, watch] of [...watched]) {
    if (!watched.has(id)) continue;
    const doc = appWindowDocument(id);
    const at: [number, number] | null = doc && pointer && pointer.doc === doc ? [pointer.clientX, pointer.clientY] : null;
    const now = !!at && isOverAt(doc, at[0], at[1], watch);
    const fresh = unreported.delete(id);
    if (!fresh && now === over.has(id)) continue;
    if (now) over.add(id);
    else over.delete(id);
    emitNativeEvent("ArdiaAppWindows", "onWindowEvent", { type: "sidebarEdge", id, over: now, point: at ?? [-1, -1] });
  }
}

function holdPagePointer(id: string) {
  const doc = appWindowDocument(id);
  if (!doc) return;
  const holding = (watched.get(id)?.hold ?? 0) > 0;
  if (holding && !doc.getElementById(HOLDING_CLASS)) {
    const style = doc.createElement("style");
    style.id = HOLDING_CLASS;
    style.textContent = `.${HOLDING_CLASS} iframe { pointer-events: none !important; }`;
    doc.head.append(style);
  }
  doc.documentElement.classList.toggle(HOLDING_CLASS, holding);
}

function listen(on: boolean) {
  if (on === !!stopWatching) return;
  if (on) stopWatching = watchPointer(check);
  else {
    stopWatching?.();
    stopWatching = null;
  }
}

export function watchSidebarEdge(id: string, on: boolean, hold: number, right: boolean, whilePressed: boolean) {
  if (on) watched.set(id, { hold: Math.max(0, hold), right, whilePressed });
  else watched.delete(id);
  holdPagePointer(id);
  if (engineDecides()) {
    listen(false);
    over.clear();
    unreported.clear();
    void callMain(ENGINE_MODULE, ENGINE_WATCH, id, on, hold, right, whilePressed).catch(() => undefined);
    return;
  }
  if (on) unreported.add(id);
  else over.delete(id);
  listen(watched.size > 0);
  if (watched.size) check();
}
