import { pageFrameOf, type PageFrame } from "../../lib/windowLayout";
import { drawnWindowCornerRadius, usePageFrameInset, useRoundedPageCorners, windowCornerRadius } from "../../state/windows/layout";
import { perLook } from "../ui/tokens";
import { sidebarCardGap } from "./dockMotion";
import { currentInterfaceScale, useCurrentInterfaceScale } from "../../state/settings/interfaceScale";

type CardFrame = PageFrame & { dockGap: number };

const framesOfLook = perLook(() => new Map<string, CardFrame>());

export function cardFrameOf(inset: number, scale = currentInterfaceScale(), roundedAtZero = false): CardFrame {
  const frames = framesOfLook();
  const key = `${inset}@${scale}:${roundedAtZero ? 1 : 0}`;
  let frame = frames.get(key);
  if (!frame) frames.set(key, (frame = { ...pageFrameOf(inset, windowCornerRadius(), drawnWindowCornerRadius(), roundedAtZero), dockGap: sidebarCardGap(inset) }));
  return frame;
}

export function useCardFrame(): CardFrame {
  const scale = useCurrentInterfaceScale();
  return cardFrameOf(usePageFrameInset(), scale, useRoundedPageCorners());
}

export function usePeekRestRadius(): number {
  const scale = useCurrentInterfaceScale();
  return cardFrameOf(usePageFrameInset(), scale).radius;
}
