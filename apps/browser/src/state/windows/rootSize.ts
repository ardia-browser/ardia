import { create } from "zustand";
import { useBrowser, type BrowserState } from "../browser/store";
import { currentInterfaceScale, rootSizeOfFrame, useInterfaceScale } from "../settings/interfaceScale";

export type RootSize = { width: number; height: number };

const useRootSizes = create<Record<string, RootSize>>()(() => ({}));

export function setWindowRootSize(windowId: string, width: number, height: number) {
  const known = useRootSizes.getState()[windowId];
  if (width > 0 && height > 0 && (known?.width !== width || known.height !== height)) useRootSizes.setState({ [windowId]: { width, height } });
}

export function forgetWindowRootSize(windowId: string) {
  if (!(windowId in useRootSizes.getState())) return;
  useRootSizes.setState(({ [windowId]: _, ...rest }) => rest, true);
}

export function windowRootSize(s: Pick<BrowserState, "windows">, windowId: string): RootSize | undefined {
  const measured = useRootSizes.getState()[windowId];
  if (measured) return measured;
  const frame = s.windows[windowId]?.frame;
  return frame ? rootSizeOfFrame(frame, currentInterfaceScale()) : undefined;
}

export const windowRootWidth = (s: Pick<BrowserState, "windows">, windowId: string): number | undefined => windowRootSize(s, windowId)?.width;

export function useWindowRootWidth(windowId: string): number | undefined {
  const frameWidth = useBrowser((s) => s.windows[windowId]?.frame?.[2]);
  const scale = useInterfaceScale((s) => s.scale);
  return useRootSizes((sizes) => sizes[windowId]?.width ?? (frameWidth === undefined ? undefined : frameWidth / scale));
}
