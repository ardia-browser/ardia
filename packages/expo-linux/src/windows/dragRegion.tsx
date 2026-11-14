import { forwardRef, useCallback, useEffect, useRef, type ComponentType, type ForwardedRef } from "react";
import { View, type ViewProps } from "react-native";
import { callMain } from "../bridge";
import { addNativeListener } from "../events";
import { appWindowDocument, windowIdOfNode } from "./appWindows";
import { INTERACTIVE, markAppDragRegion, markSystemDragRegion, openContextMenuAt } from "./dragCover";

type Props = ViewProps & {
  titleBarDoubleClick?: boolean;
  onRegionDoubleClick?: () => void;
  clickable?: boolean;
  onRegionClick?: () => void;
};

const MODULE = "ArdiaAppWindows";
const CLICK_SLOP = 4;

type SystemContextMenu = { id?: string; x?: number; y?: number };

addNativeListener(MODULE, "onSystemContextMenu", (payload) => {
  const event = payload as SystemContextMenu | null;
  const doc = event?.id ? appWindowDocument(event.id) : null;
  if (doc && typeof event?.x === "number" && typeof event.y === "number") openContextMenuAt(doc, event.x, event.y);
});

function assign<Value>(ref: ForwardedRef<Value>, value: Value | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

const pressedOnControl = (region: HTMLElement, target: EventTarget | null) => {
  const hit = target as Element | null;
  const control = hit?.closest?.(INTERACTIVE);
  return !!control && control !== region && region.contains(control);
};

export const WindowDragRegion = forwardRef<unknown, Props>(function WindowDragRegion({ titleBarDoubleClick = true, onRegionDoubleClick, clickable, onRegionClick, ...props }, ref) {
  const node = useRef<HTMLElement | null>(null);
  const latest = useRef({ titleBarDoubleClick, onRegionDoubleClick, clickable, onRegionClick });
  latest.current = { titleBarDoubleClick, onRegionDoubleClick, clickable, onRegionClick };
  const appMoves = !!clickable || !!onRegionDoubleClick || !titleBarDoubleClick;

  useEffect(() => {
    const region = node.current;
    if (!region || appMoves) return;
    return markSystemDragRegion(region);
  }, [appMoves]);

  useEffect(() => {
    const region = node.current;
    if (!region || !appMoves) return;
    const unmark = markAppDragRegion(region);
    let pressed: { x: number; y: number; pointer: number } | null = null;
    let dragging = false;
    const windowId = () => windowIdOfNode(region);
    const stop = () => {
      if (dragging) void callMain(MODULE, "endWindowDrag");
      dragging = false;
      pressed = null;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.detail > 1 || pressedOnControl(region, e.target)) return;
      pressed = { x: e.screenX, y: e.screenY, pointer: e.pointerId };
      dragging = false;
      region.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!pressed || dragging || e.pointerId !== pressed.pointer) return;
      if (Math.abs(e.screenX - pressed.x) < CLICK_SLOP && Math.abs(e.screenY - pressed.y) < CLICK_SLOP) return;
      dragging = true;
      void callMain(MODULE, "beginWindowDrag", windowId(), pressed.x, pressed.y);
    };
    const up = (e: PointerEvent) => {
      if (!pressed || e.pointerId !== pressed.pointer) return;
      const clicked = !dragging;
      stop();
      if (clicked && latest.current.clickable) latest.current.onRegionClick?.();
    };
    const double = (e: MouseEvent) => {
      if (e.button !== 0 || pressedOnControl(region, e.target)) return;
      stop();
      latest.current.onRegionDoubleClick?.();
      if (latest.current.titleBarDoubleClick) void callMain(MODULE, "toggleMaximizeWindow", windowId());
    };
    region.addEventListener("pointerdown", down);
    region.addEventListener("pointermove", move);
    region.addEventListener("pointerup", up);
    region.addEventListener("pointercancel", stop);
    region.addEventListener("lostpointercapture", stop);
    region.addEventListener("dblclick", double);
    return () => {
      stop();
      unmark();
      region.removeEventListener("pointerdown", down);
      region.removeEventListener("pointermove", move);
      region.removeEventListener("pointerup", up);
      region.removeEventListener("pointercancel", stop);
      region.removeEventListener("lostpointercapture", stop);
      region.removeEventListener("dblclick", double);
    };
  }, [appMoves]);

  const attach = useCallback(
    (value: HTMLElement | null) => {
      node.current = value;
      assign(ref, value);
    },
    [ref],
  );
  const Region = View as unknown as ComponentType<Record<string, unknown>>;
  return <Region {...props} ref={attach} />;
});
