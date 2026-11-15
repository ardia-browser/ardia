import { callMain } from "../../bridge";
import { addNativeListener, emitNativeEvent, type EventSubscription } from "../../events";
import { appWindowDocument } from "../../windows/appWindows";
import { currentPointer, watchPointer, type PointerSample } from "../../reactNative/pointer";

const REACH = 24;
const HOLDING_CLASS = "ardia-pointer-hold";

type Watch = { hold: number; right: boolean };

const watched = new Map<string, Watch>();
const over = new Set<string>();
const unreported = new Set<string>();
const polled = new Map<string, [number, number]>();
let stopWatching: (() => void) | null = null;
let polledEvents: EventSubscription | null = null;

function isOverAt(doc: Document | null, x: number, y: number, { hold, right }: Watch) {
  if (!doc || doc.fullscreenElement) return false;
  const width = doc.documentElement.clientWidth;
  const height = doc.documentElement.clientHeight;
  if (y < 0 || y >= height) return false;
  if (right) return x < width && x >= width - Math.max(hold, REACH / 2);
  return x >= 0 && x < Math.max(hold, REACH / 2);
}

function pointerIn(doc: Document | null, id: string, pointer: PointerSample | null): [number, number] | null {
  if (doc && pointer && pointer.doc === doc) return [pointer.clientX, pointer.clientY];
  return polled.get(id) ?? null;
}

function check(pointer: PointerSample | null = currentPointer()) {
  for (const [id, watch] of [...watched]) {
    if (!watched.has(id)) continue;
    const doc = appWindowDocument(id);
    const at = pointerIn(doc, id, pointer);
    const polledAt = polled.get(id);
    const now = (!!at && isOverAt(doc, at[0], at[1], watch)) || (!!polledAt && isOverAt(doc, polledAt[0], polledAt[1], watch));
    const fresh = unreported.delete(id);
    if (!fresh && now === over.has(id)) continue;
    if (now) over.add(id);
    else over.delete(id);
    const point: [number, number] = at ?? [-1, -1];
    emitNativeEvent("ArdiaAppWindows", "onWindowEvent", { type: "sidebarEdge", id, over: now, point });
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

function notePolled(payload: unknown) {
  const { id, point } = (payload ?? {}) as { id?: unknown; point?: unknown };
  if (typeof id !== "string" || !watched.has(id)) return;
  if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") polled.set(id, [point[0], point[1]]);
  else polled.delete(id);
  check();
}

function listen(on: boolean) {
  if (on === !!stopWatching) return;
  if (on) {
    stopWatching = watchPointer(check);
    polledEvents = addNativeListener("ArdiaLinuxEdgePointer", "point", notePolled);
  } else {
    stopWatching?.();
    stopWatching = null;
    polledEvents?.remove();
    polledEvents = null;
    polled.clear();
  }
}

export function watchSidebarEdge(id: string, on: boolean, hold: number, right: boolean) {
  if (on) {
    watched.set(id, { hold: Math.max(0, hold), right });
    unreported.add(id);
  } else {
    watched.delete(id);
    over.delete(id);
    polled.delete(id);
  }
  listen(watched.size > 0);
  void callMain("ArdiaLinuxEdgePointer", "watch", id, on).catch(() => undefined);
  holdPagePointer(id);
  if (watched.size) check();
}
