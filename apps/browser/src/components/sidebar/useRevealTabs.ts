import { useEffect, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { watchRevealTargets } from "../../state/sidebar/reveal";
import { GLOW_ROOM, type SidebarGeometry } from "./pageLayout";
import { SCROLL_EDGE } from "./ScrollEdge";
import { locateTab } from "./selectedRow";

export function useRevealTabs(windowId: string, scroll: RefObject<ScrollView | null>, scrollY: RefObject<number>, geometry: RefObject<SidebarGeometry>) {
  useEffect(() => {
    let switched: string | null = null;
    let opened: string | null = null;
    let frame = 0;
    let reveals = 0;
    const show = (y: number, height: number) => {
      const top = scrollY.current ?? 0;
      const { viewport } = geometry.current;
      if (y - top < GLOW_ROOM) scroll.current?.scrollTo({ y: Math.max(0, y - GLOW_ROOM - SCROLL_EDGE.inset), animated: true });
      else if (y + height - top > viewport - GLOW_ROOM) scroll.current?.scrollTo({ y: y + height - viewport + GLOW_ROOM, animated: true });
    };
    const reveal = () => {
      frame = 0;
      if (!geometry.current.viewport || !scroll.current) return;
      const mine = ++reveals;
      const tabId = switched ?? opened;
      switched = opened = null;
      if (!tabId) return;
      const row = locateTab(windowId, tabId, geometry.current, scroll.current, () => scrollY.current ?? 0);
      if (!row) return;
      if ("then" in row) void row.then((found) => found && mine === reveals && show(found.y, found.height));
      else show(row.y, row.height);
    };
    const schedule = () => {
      if ((switched || opened) && !frame) frame = requestAnimationFrame(reveal);
    };
    const unsubscribe = watchRevealTargets(windowId, (nowSwitched, nowOpened) => {
      if (nowSwitched) switched = nowSwitched;
      if (nowOpened) opened = nowOpened;
      schedule();
    });
    geometry.current.laidOut = schedule;
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      geometry.current.laidOut = undefined;
    };
  }, [windowId]);
}
