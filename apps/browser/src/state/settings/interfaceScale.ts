import { create } from "zustand";
import { PixelRatio } from "react-native";
import { nativeInterfaceScaleRange } from "../../platform/app";
import { forgetWindowCornerRadius } from "../../platform/windows";
import { INTERFACE_SCALE, rootLength, snappedToGrid } from "../../lib/interfaceScale";

type Size = { width: number; height: number };

const RELAYOUT_MS = 120;

export const useInterfaceScale = create<{ scale: number }>()(() => ({ scale: INTERFACE_SCALE.default }));

let adjustable: boolean | undefined;

export function interfaceScaleAdjustable(): boolean {
  if (adjustable === undefined) {
    const [min, max] = nativeInterfaceScaleRange();
    adjustable = max > min;
  }
  return adjustable;
}

export const currentInterfaceScale = (): number => useInterfaceScale.getState().scale;

export const useCurrentInterfaceScale = (): number => useInterfaceScale((s) => s.scale);

export function onInterfaceScaleChange(listener: (scale: number) => void): () => void {
  return useInterfaceScale.subscribe((next, prev) => {
    if (next.scale !== prev.scale) listener(next.scale);
  });
}

export function onInterfaceScaleSettled(listener: (scale: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = onInterfaceScaleChange((scale) => {
    clearTimeout(timer);
    timer = setTimeout(() => listener(scale), RELAYOUT_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

export const devicePixelsPerRootPoint = (scale = currentInterfaceScale()): number => PixelRatio.get() * scale;

export const snappedToDevicePixels = (rootPoints: number): number => snappedToGrid(rootPoints, devicePixelsPerRootPoint());

export const rootSizeOfFrame = (frame: readonly number[], scale = currentInterfaceScale()): Size => ({ width: rootLength(frame[2]!, scale), height: rootLength(frame[3]!, scale) });

export function appliedInterfaceScale(scale: number) {
  if (scale === currentInterfaceScale()) return;
  forgetWindowCornerRadius();
  useInterfaceScale.setState({ scale });
}
