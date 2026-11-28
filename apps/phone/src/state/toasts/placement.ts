export type ToastPlacement = {
  keyboardLift: number | null;
  safeBottom: number;
  barClearance: number | null;
  hostBottomY: number;
  barTopY: number | null;
  covered: boolean;
  gap: number;
};

export type PageBarShown = "full" | "pill" | "gone";

export const TOAST_KEYBOARD_TOP = 4;

export function pageBarClearance(materialBar: { inset: number; height: number } | null, floatingClearance: number, gap: number): number {
  return materialBar ? materialBar.inset + materialBar.height + gap : floatingClearance;
}

export function floatingBarClearance(barCenterFromBottom: number, control: number, gap: number, safeBottom: number): number {
  return barCenterFromBottom + control / 2 + gap - safeBottom;
}

export function floatingPillClearance(barCenterFromBottom: number, control: number, pillHeight: number, gap: number, safeBottom: number): number {
  return barCenterFromBottom - control / 2 + pillHeight + gap - safeBottom;
}

export function materialPillClearance(materialBar: { inset: number }, pillHeight: number, gap: number): number {
  return materialBar.inset + pillHeight + gap;
}

export type PageBarGeometry = { full: number; pill: number | null };

export function shownBarClearance(geometry: PageBarGeometry, shown: PageBarShown): number | null {
  if (shown === "gone") return null;
  if (shown === "pill") return geometry.pill ?? geometry.full;
  return geometry.full;
}

export function toastPlace(place: ToastPlacement & { safeTop: number }): { top: number } | { bottom: number } {
  if (place.keyboardLift !== null) return { top: place.safeTop + TOAST_KEYBOARD_TOP };
  return { bottom: toastBottom({ ...place, keyboardLift: null }) };
}

export function toastBottom(place: ToastPlacement): number {
  if (place.keyboardLift !== null) return place.keyboardLift + place.gap;
  if (place.covered) return place.safeBottom + place.gap;
  const clear = place.safeBottom + (place.barClearance ?? place.gap);
  if (place.barTopY === null) return clear;
  return Math.max(clear, place.hostBottomY - place.barTopY + place.gap);
}

export const toastSideInset = (barSideInset: number, safeSide: number) => barSideInset + safeSide;

export const TOAST_MOTION = { enterTravel: 24, enterScale: 0.92, exitTravel: 16, flingDistance: 40, dragDistance: 24, projectionSeconds: 0.499 } as const;

export function toastDragDismisses(translation: number, velocity: number): boolean {
  "worklet";
  const predicted = translation + velocity * TOAST_MOTION.projectionSeconds;
  return predicted > TOAST_MOTION.flingDistance || translation > TOAST_MOTION.dragDistance;
}
