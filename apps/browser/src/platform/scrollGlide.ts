import { nativeModule } from "@ardia/shell";

const Wheel = nativeModule("ArdiaWheelArea");

export const wheelSteersSections = true;

export function glideNativeScroll(tag: number, y: number, durationMs: number): boolean {
  if (typeof Wheel?.glideScroll !== "function") return false;
  void Wheel.glideScroll(tag, y, durationMs);
  return true;
}

export function steerNativeScroll(tag: number, lo: number, hi: number, glideMs: number, canForward: boolean, canBack: boolean): boolean {
  if (typeof Wheel?.steerScroll !== "function") return false;
  void Wheel.steerScroll(tag, lo, hi, glideMs, canForward, canBack);
  return true;
}
