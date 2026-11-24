export const TRAY_DRAG = {
  upwardLimit: 36,
  flickVelocity: 800,
  returnVelocity: -250,
  momentum: 0.12,
  distanceShare: 0.35,
  distanceCap: 120,
  keyboardRelease: 8,
} as const;

export const TRAY_LIFT = {
  keyboardThreshold: 120,
  landingDelayMs: 220,
  settleHoldMs: 650,
  closePollMs: 50,
  closePolls: 20,
  removalDelayMs: 450,
  heldReleaseTolerance: 2,
  landedProgress: 0.99,
  backTravel: 72,
} as const;

export function rubberBand(distance: number, limit: number): number {
  "worklet";
  if (distance <= 0 || limit <= 0) return 0;
  return limit * (1 - 1 / (distance / limit + 1));
}

export function trayDragOffset(translation: number): number {
  "worklet";
  if (translation >= 0) return translation;
  return -rubberBand(-translation, TRAY_DRAG.upwardLimit);
}

export function trayDragTranslation(offset: number): number {
  "worklet";
  if (offset >= 0) return offset;
  const stretch = Math.min(-offset / TRAY_DRAG.upwardLimit, 0.99);
  return (-TRAY_DRAG.upwardLimit * stretch) / (1 - stretch);
}

export function trayVelocity(translation: number, fingerVelocity: number): number {
  "worklet";
  if (translation >= 0) return fingerVelocity;
  const stretch = -translation / TRAY_DRAG.upwardLimit + 1;
  return fingerVelocity / (stretch * stretch);
}

export function trayDismissDistance(trayHeight: number): number {
  "worklet";
  return Math.min(Math.max(trayHeight, 0) * TRAY_DRAG.distanceShare, TRAY_DRAG.distanceCap);
}

export function trayDragDismisses(translation: number, velocity: number, trayHeight: number): boolean {
  "worklet";
  if (translation <= 0) return false;
  if (velocity <= TRAY_DRAG.returnVelocity) return false;
  if (velocity >= TRAY_DRAG.flickVelocity) return true;
  return translation + Math.max(velocity, 0) * TRAY_DRAG.momentum >= trayDismissDistance(trayHeight);
}

export function trayExpansionTarget(progress: number, translationY: number, velocityY: number): number {
  "worklet";
  if (velocityY < -600 || translationY < -64) return 1;
  if (velocityY > 600 || translationY > 64) return 0;
  return progress > 0.5 ? 1 : 0;
}

export function trayDragReleasesKeyboard(translation: number): boolean {
  "worklet";
  return translation > TRAY_DRAG.keyboardRelease;
}

export function clampedProgress(offset: number, travel: number): number {
  "worklet";
  if (travel <= 0) return 0;
  return Math.min(Math.max(offset / travel, 0), 1);
}

export function keyboardIsUp(height: number): boolean {
  "worklet";
  return height > TRAY_LIFT.keyboardThreshold;
}

export function keyboardProgress(current: number, source: number, target: number): number {
  "worklet";
  const full = Math.max(source, target);
  if (full <= TRAY_LIFT.keyboardThreshold) return 0;
  return Math.min(Math.max(current / full, 0), 1);
}

export function liveLift(keyboard: number, safeBottom: number, hasLanded: boolean, isClosing: boolean): number {
  "worklet";
  const restsWithoutKeyboard = hasLanded && !keyboardIsUp(keyboard) && !isClosing;
  return restsWithoutKeyboard ? Math.max(keyboard, safeBottom) : keyboard;
}

export function trayOffset(lift: number, drag: number, rise: number, trayHeight: number, cornerRadius: number): number {
  "worklet";
  const clamped = Math.min(Math.max(rise, 0), 1);
  return -lift + drag + (1 - clamped) * (trayHeight + cornerRadius + lift);
}

export function trayMaxHeight(preferred: number, containerHeight: number, lift: number, gap: number): number {
  "worklet";
  return Math.max(Math.min(preferred, containerHeight - lift - gap), 0);
}
