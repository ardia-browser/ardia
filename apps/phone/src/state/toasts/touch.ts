import { toastDragDismisses } from "./placement.ts";

export type ToastTouch = {
  phase: "idle" | "pressed" | "dragging" | "gone";
  startX: number;
  startY: number;
  startAt: number;
  lastY: number;
  lastAt: number;
  velocityY: number;
};

export type ToastTouchEnd = "tap" | "dismiss" | "settle" | "none";

export const TOAST_TOUCH_SLOP = 8;

export const TOAST_TAP_MAX_MS = 600;

export const IDLE_TOAST_TOUCH: ToastTouch = { phase: "idle", startX: 0, startY: 0, startAt: 0, lastY: 0, lastAt: 0, velocityY: 0 };

export function toastTouchDown(x: number, y: number, at: number): ToastTouch {
  "worklet";
  return { phase: "pressed", startX: x, startY: y, startAt: at, lastY: y, lastAt: at, velocityY: 0 };
}

export function toastTouchMove(touch: ToastTouch, x: number, y: number, at: number): ToastTouch {
  "worklet";
  if (touch.phase === "idle" || touch.phase === "gone") return touch;
  const elapsed = at - touch.lastAt;
  const velocityY = elapsed > 0 ? ((y - touch.lastY) / elapsed) * 1000 : touch.velocityY;
  const moved = { ...touch, lastY: y, lastAt: at, velocityY };
  if (touch.phase === "dragging") return moved;
  const dx = Math.abs(x - touch.startX);
  const dy = Math.abs(y - touch.startY);
  if (dy > TOAST_TOUCH_SLOP && dy >= dx) return { ...moved, phase: "dragging" };
  if (dx > TOAST_TOUCH_SLOP) return { ...moved, phase: "gone" };
  return moved;
}

export const toastTouchDrag = (touch: ToastTouch) => {
  "worklet";
  return touch.phase === "dragging" ? touch.lastY - touch.startY : 0;
};

export function toastTouchUp(touch: ToastTouch, at: number): ToastTouchEnd {
  "worklet";
  if (touch.phase === "dragging") return toastDragDismisses(touch.lastY - touch.startY, touch.velocityY) ? "dismiss" : "settle";
  if (touch.phase === "pressed" && at - touch.startAt <= TOAST_TAP_MAX_MS) return "tap";
  return "none";
}
