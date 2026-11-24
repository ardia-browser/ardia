import { useState } from "react";
import type { View } from "react-native";
import { create } from "zustand";

export const ROW_PAGE = 100;
const NEAR_END = 600;

const useScrollEnds = create<{ reached: number }>()(() => ({ reached: 0 }));
export const useSettingsScroll = create<{ top: number; viewport: number; content: number }>()(() => ({ top: 0, viewport: 0, content: 0 }));
export const settingsContent: { current: View | null } = { current: null };
let armed = true;
let lastContent = -1;

export function noteSettingsViewport(viewport: number) {
  if (useSettingsScroll.getState().viewport !== viewport) useSettingsScroll.setState({ viewport });
}

export function noteSettingsContentSize(content: number) {
  if (useSettingsScroll.getState().content !== content) useSettingsScroll.setState({ content });
}

export function noteSettingsScroll(offset: number, viewport: number, content: number) {
  const seen = useSettingsScroll.getState();
  if (seen.top !== offset || seen.viewport !== viewport || seen.content !== content) useSettingsScroll.setState({ top: offset, viewport, content });
  if (content !== lastContent) {
    lastContent = content;
    armed = true;
  }
  if (offset + viewport < content - NEAR_END) {
    armed = true;
    return;
  }
  if (!armed) return;
  armed = false;
  useScrollEnds.setState((s) => ({ reached: s.reached + 1 }));
}

export function useGrowingRows(total: number, resetKey: string): number {
  const reached = useScrollEnds((s) => s.reached);
  const [start, setStart] = useState({ key: resetKey, at: reached });
  if (start.key !== resetKey) setStart({ key: resetKey, at: reached });
  const pages = 1 + (start.key === resetKey ? reached - start.at : 0);
  return Math.min(total, pages * ROW_PAGE);
}
