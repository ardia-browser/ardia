import { useEffect, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { inShownProfile, selectedTabIn, showsProfile, watchRevealTargets, windowProfileIn } from "../../state/sidebar/reveal";
import { reduceMotion } from "../ui/reduceMotion";
import { GLOW_ROOM, type SidebarGeometry } from "./pageLayout";
import { locateTab } from "./selectedRow";
import { REVEAL_ROW_MARGIN } from "./tokens";

export type RevealScroll = { y: number; animated: boolean };

export function revealScrollFor(row: { y: number; height: number }, at: { top: number; viewport: number; edgeLift?: number }, animated: boolean): RevealScroll | null {
  const { top, viewport, edgeLift = 0 } = at;
  if (row.y - top < GLOW_ROOM) return { y: Math.max(0, row.y - GLOW_ROOM + edgeLift - REVEAL_ROW_MARGIN), animated };
  if (row.y + row.height - top > viewport - GLOW_ROOM) return { y: row.y + row.height - viewport + REVEAL_ROW_MARGIN, animated };
  return null;
}

type Scroller = Pick<ScrollView, "scrollTo">;

export function startRevealTabs(windowId: string, scroll: RefObject<Scroller | null>, scrollY: RefObject<number>, geometry: RefObject<SidebarGeometry>, stillMotion: () => boolean | null = reduceMotion) {
    let switched: string | null = null;
    let opened: string | null = null;
    let viaPill = false;
    let frame = 0;
    let reveals = 0;
    let atRest: string | null = null;
    let switchedIn: string | null = null;
    const show = (row: { y: number; height: number }, pill: boolean) => {
      const { viewport, edgeLift } = geometry.current;
      const move = revealScrollFor(row, { top: scrollY.current ?? 0, viewport, edgeLift }, pill && !stillMotion());
      if (move) scroll.current?.scrollTo(move);
    };
    const reveal = () => {
      frame = 0;
      if (!geometry.current.viewport || !scroll.current) return;
      const mine = ++reveals;
      if (geometry.current.ownerShown?.() === false) {
        if (switched) atRest = windowProfileIn(windowId) ?? null;
        switched = null;
        return;
      }
      const selected = () => selectedTabIn(windowId) ?? undefined;
      const resting = atRest !== null && showsProfile(windowId, atRest) ? selected() : undefined;
      const asked = !switched ? undefined : inShownProfile(windowId, switched) ? switched : switchedIn && showsProfile(windowId, switchedIn) ? selected() : undefined;
      atRest = null;
      const tabId = asked ?? resting ?? (opened && inShownProfile(windowId, opened) ? opened : undefined);
      const pill = viaPill;
      switched = opened = null;
      viaPill = false;
      if (!tabId) return;
      const scroller = scroll.current;
      const from = scrollY.current ?? 0;
      const row = locateTab(windowId, tabId, geometry.current, scroller as ScrollView, () => scrollY.current ?? 0);
      if (!row) return;
      const unmoved = () => Math.abs((scrollY.current ?? 0) - from) < 1;
      if ("then" in row) void row.then((found) => found && mine === reveals && scroll.current === scroller && unmoved() && show(found, pill));
      else show(row, pill);
    };
    const schedule = () => {
      if ((switched || opened || atRest) && !frame) frame = requestAnimationFrame(reveal);
    };
    const unsubscribe = watchRevealTargets(windowId, ({ switched: nowSwitched, opened: nowOpened }, pill) => {
      reveals++;
      if (nowSwitched) {
        switched = nowSwitched;
        switchedIn = windowProfileIn(windowId) ?? null;
      }
      if (nowOpened) opened = nowOpened;
      viaPill = pill;
      schedule();
    });
    geometry.current.laidOut = schedule;
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      geometry.current.laidOut = undefined;
    };
}

export function useRevealTabs(windowId: string, scroll: RefObject<ScrollView | null>, scrollY: RefObject<number>, geometry: RefObject<SidebarGeometry>) {
  useEffect(() => startRevealTabs(windowId, scroll, scrollY, geometry), [windowId]);
}
