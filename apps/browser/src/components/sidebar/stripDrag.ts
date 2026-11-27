import { AppState } from "react-native";
import type { DragController } from "./dragController";
import { boxed, measure, type Item } from "./dragModel";
import { handoffPoint } from "./iconStripGeometry";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import { consentToken } from "../../state/telemetry/client";
import type { ConsentToken } from "../../state/telemetry/choice";

const controllers = new Map<string, () => DragController | null>();

export function registerSidebarDrag(windowId: string, controller: () => DragController | null): () => void {
  controllers.set(windowId, controller);
  return () => void (controllers.get(windowId) === controller && controllers.delete(windowId));
}

export const sidebarDragOf = (windowId: string): DragController | null => controllers.get(windowId)?.() ?? null;

export type StripDragTarget = { press: () => void; begin: (x: number, y: number) => void; move: (x: number, y: number) => void; end: (commit: boolean) => void; cancel: () => void };

type Handoff = Pick<DragController, "begin" | "move" | "end" | "interrupt"> & { items: Map<string, Pick<Item, "kind" | "view" | "header">> };

export const grabbedView = (item: Pick<Item, "kind" | "view" | "header">) => (boxed(item as Item) ? (item.header ?? item.view) : item.view);

let handoffs = 0;

type Run = { id: number; phase: "waiting" | "handed" | "ended"; pointer: { x: number; y: number }; consent: ConsentToken | null; handed: Handoff | null; timer?: ReturnType<typeof setTimeout>; release: () => void };

export function stripDragHandoff(
  windowId: string,
  key: string,
  reveal: () => void,
  settleMs: number,
  controllerOf: (windowId: string) => Handoff | null = sidebarDragOf,
  right = false,
): StripDragTarget {
  let run: Run | null = null;
  let pressed: { consent: ConsentToken | null } | null = null;
  const live = (r: Run) => run === r && r.phase !== "ended";
  const stop = (r: Run) => {
    r.phase = "ended";
    r.release();
  };
  const start = async (r: Run) => {
    if (!live(r) || r.phase !== "waiting") return;
    const controller = controllerOf(windowId);
    const item = controller?.items.get(key);
    if (!controller || !item) return stop(r);
    const frame = await measure(grabbedView(item));
    if (!live(r) || r.phase !== "waiting" || controllerOf(windowId) !== controller || controller.items.get(key) !== item) return stop(r);
    r.phase = "handed";
    r.handed = controller;
    const at = handoffPoint(frame, r.pointer, right);
    await controller.begin(key, at.x, at.y, r.consent);
    if (live(r) && r.handed === controller) controller.move(r.pointer.x, r.pointer.y);
  };
  const stopWaiting = (r: Run) => {
    if (run !== r || r.phase !== "waiting") return;
    run = null;
    pressed = null;
    stop(r);
  };
  const cancel = () => {
    const r = run;
    run = null;
    pressed = null;
    if (!r || r.phase === "ended") return;
    const was = r.handed;
    stop(r);
    was?.interrupt();
  };
  return {
    press() {
      pressed = { consent: consentToken() };
    },
    begin(x, y) {
      const consent = pressed ? pressed.consent : consentToken();
      cancel();
      const id = ++handoffs;
      const owner = `stripDrag:${windowId}:${id}`;
      const r: Run = { id, phase: "waiting", pointer: { x, y }, consent, handed: null, release: () => {} };
      run = r;
      captureEscape(owner, true);
      const escape = onAppEvent((e) => e.type === "dragEscape" && stopWaiting(r));
      const active = AppState.addEventListener("change", (state) => state !== "active" && stopWaiting(r));
      r.release = () => {
        clearTimeout(r.timer);
        escape.remove();
        active.remove();
        captureEscape(owner, false);
      };
      reveal();
      r.timer = setTimeout(() => void start(r), settleMs);
    },
    move(x, y) {
      const r = run;
      if (!r) return;
      r.pointer = { x, y };
      if (r.phase === "handed") r.handed?.move(x, y);
    },
    end(commit) {
      const r = run;
      run = null;
      pressed = null;
      if (!r || r.phase === "ended") return;
      const controller = r.phase === "handed" ? r.handed : null;
      stop(r);
      if (!controller) return;
      if (commit) void controller.end(true);
      else controller.interrupt();
    },
    cancel,
  };
}
