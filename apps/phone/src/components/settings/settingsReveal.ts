import type { ScrollViewInstance, ViewInstance } from "react-native";

export type SettingsReveal = (target: ViewInstance | null) => void;

export function revealScrollY(top: number, height: number, scrollY: number, viewport: number): number | null {
  if (viewport <= 0) return null;
  if (top < scrollY) return Math.max(0, top);
  if (top + height > scrollY + viewport) return top + Math.min(height, viewport) - viewport;
  return null;
}

type RevealFrame = { list: ScrollViewInstance | null; scrollY: number; viewport: number };

export function revealInList({ list, scrollY, viewport }: RevealFrame, target: ViewInstance | null) {
  const content = list?.getInnerViewRef();
  if (!list || !content || !target) return;
  target.measureLayout(content, (_x, y, _width, height) => {
    const next = revealScrollY(y, height, scrollY, viewport);
    if (next !== null) list.scrollTo({ y: next, animated: false });
  });
}
