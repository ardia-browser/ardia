import { t } from "../../lib/uiLanguage";
export const INTRO_TAB_KEYS = [{ key: t(`Tab`) }, { key: t(`Tab`), shiftKey: true }];

export function nextIntroStop(focused: number, shift: boolean, count: number): number {
  const at = focused >= 0 && focused < count ? focused : shift ? count : -1;
  return (at + (shift ? -1 : 1) + count) % count;
}

export const introHoldsKeyboard = ({ live, leaving, tabReachesUnderOverlays }: { live: boolean; leaving: boolean; tabReachesUnderOverlays: boolean }) =>
  tabReachesUnderOverlays && !live && !leaving;
