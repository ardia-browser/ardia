import { useMemo } from "react";
import { pageLeft } from "./pagerTrack";

export * from "../../browser/src/state/windows/profilePager";

export function usePageStyle(_windowId: string, slot: number, width: number) {
  return useMemo(() => ({ left: pageLeft(slot, width) }), [slot, width]);
}
