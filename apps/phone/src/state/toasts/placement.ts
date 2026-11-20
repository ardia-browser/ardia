export type ToastPlacement = {
  keyboardLift: number | null;
  safeBottom: number;
  barClearance: number;
  hostBottomY: number;
  barTopY: number | null;
  gap: number;
};

export const TOAST_KEYBOARD_TOP = 4;

export function toastPlace(place: ToastPlacement & { safeTop: number }): { top: number } | { bottom: number } {
  if (place.keyboardLift !== null) return { top: place.safeTop + TOAST_KEYBOARD_TOP };
  return { bottom: toastBottom({ ...place, keyboardLift: null }) };
}

export function toastBottom(place: ToastPlacement): number {
  if (place.keyboardLift !== null) return place.keyboardLift + place.gap;
  const clear = place.safeBottom + place.barClearance;
  if (place.barTopY === null) return clear;
  return Math.max(clear, place.hostBottomY - place.barTopY + place.gap);
}

export const TOAST_MOTION = { enterTravel: 24, enterScale: 0.92, exitTravel: 16, flingDistance: 40, dragDistance: 24, projectionSeconds: 0.499 } as const;

export function toastDragDismisses(translation: number, velocity: number): boolean {
  "worklet";
  const predicted = translation + velocity * TOAST_MOTION.projectionSeconds;
  return predicted > TOAST_MOTION.flingDistance || translation > TOAST_MOTION.dragDistance;
}
