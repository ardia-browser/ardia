import type { ConsentToken } from "../telemetry/choice";
import { rememberSettingsScrollOffset, settingsPageKey, type SettingsPlace } from "./settingsWindows";

export const SCROLL_SETTLE_MS = 250;
export const REVEAL_MARGIN = 16;

export type RestoreOutcome = "applied" | "clamped" | "unreachable";

export type ScrollMove = { y: number };

export type ScrollSource = { layout: string; generation: number };

type Expect = { y: number; until: number; owed: boolean };

type Visit = { visit: number; saved: number; layout: string; generation: number; consent: ConsentToken | null; settled: boolean; expect: Expect | null };

export const settingsLayoutKey = (s: SettingsPlace) => `${settingsPageKey(s)}\u0000${s.profileId ?? ""}`;

export function revealScrollTarget(y: number, height: number, top: number, viewport: number): number | null {
  if (y >= top + REVEAL_MARGIN && y + height <= top + viewport - REVEAL_MARGIN) return null;
  return Math.max(0, y - viewport / 3);
}

export function settingsScroller(report: (outcome: RestoreOutcome, consent: ConsentToken | null) => void = () => {}, now: () => number = Date.now) {
  let shown: Visit | null = null;
  let laidOut: ScrollSource | null = null;
  let content = 0;
  let viewport = 0;
  let position: { generation: number; y: number } | null = null;
  let top = 0;
  let early: ScrollSource & { height: number } | null = null;

  const conclude = (visit: Visit, outcome: RestoreOutcome | null, landed: number | null) => {
    if (outcome && visit.expect?.owed) report(outcome, visit.consent);
    visit.expect = null;
    if (landed !== null) rememberSettingsScrollOffset(visit.visit, landed);
  };

  const observe = (generation: number, y: number) => {
    position = { generation, y };
    top = y;
  };

  const settle = (visit: Visit): ScrollMove => {
    visit.settled = true;
    const reachable = visit.saved > 0 && content - viewport >= visit.saved;
    const y = reachable ? visit.saved : 0;
    if (visit.saved > 0 && !reachable) {
      report("unreachable", visit.consent);
      rememberSettingsScrollOffset(visit.visit, 0);
    }
    visit.expect = { y, until: now() + SCROLL_SETTLE_MS, owed: reachable };
    top = y;
    if (position?.generation === visit.generation && Math.abs(position.y - y) < 1) conclude(visit, "applied", y);
    return { y };
  };

  return {
    resized(height: number) {
      viewport = height;
    },
    begin(visit: number, saved: number, place: SettingsPlace, consent: ConsentToken | null, generation: number): ScrollMove | null {
      const samePage = !!shown?.layout.startsWith(`${settingsPageKey(place)}\u0000`);
      if (shown) conclude(shown, null, null);
      const layout = settingsLayoutKey(place);
      shown = { visit, saved, layout, generation, consent, settled: false, expect: null };
      if (saved <= 0) rememberSettingsScrollOffset(visit, 0);
      if (early?.layout === layout && early.generation === generation) {
        laidOut = { layout, generation };
        content = early.height;
      }
      early = null;
      if (laidOut?.generation === generation) return settle(shown);
      laidOut = null;
      if (samePage) return null;
      top = 0;
      return { y: 0 };
    },
    laidOut(layout: string, height: number, generation: number): ScrollMove | null {
      if (!shown || generation !== shown.generation) {
        if (!shown || generation > shown.generation) early = { layout, height, generation };
        return null;
      }
      laidOut = { layout, generation };
      content = height;
      return shown.settled ? null : settle(shown);
    },
    scrolled(y: number, max: number, contentHeight: number, source?: ScrollSource) {
      if (source && (source.generation !== shown?.generation || source.layout !== shown.layout)) return;
      if (!shown?.settled) return;
      const expect = shown.expect;
      if (!expect) {
        observe(shown.generation, y);
        return rememberSettingsScrollOffset(shown.visit, y);
      }
      if (now() >= expect.until) {
        observe(shown.generation, y);
        return conclude(shown, null, y);
      }
      if (contentHeight >= 0 && Math.abs(contentHeight - content) >= 1) return;
      if (Math.abs(y - expect.y) < 1) {
        observe(shown.generation, y);
        return conclude(shown, "applied", y);
      }
      if (expect.y > max + 0.5 && Math.abs(y - max) < 1) {
        observe(shown.generation, y);
        return conclude(shown, "clamped", y);
      }
    },
    revealTop(): number {
      return top;
    },
    moved() {
      if (!shown) return;
      shown.settled = true;
      conclude(shown, null, null);
    },
  };
}
