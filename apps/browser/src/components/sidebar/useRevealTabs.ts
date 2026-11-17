import { useEffect, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { watchRevealTargets } from "../../state/sidebar/reveal";
import { reduceMotion } from "../ui";
import { GLOW_ROOM, type SidebarGeometry } from "./pageLayout";
import { locateTab } from "./selectedRow";
import { REVEAL_GLIDE } from "./tokens";

export function glideOffsets(from: number, to: number, elapsedMs: number): { y: number; done: boolean } {
  const progress = Math.min(1, Math.max(0, elapsedMs / REVEAL_GLIDE.duration));
  return { y: from + (to - from) * REVEAL_GLIDE.easing(progress), done: progress >= 1 };
}

export function useRevealTabs(windowId: string, scroll: RefObject<ScrollView | null>, scrollY: RefObject<number>, geometry: RefObject<SidebarGeometry>) {
  useEffect(() => {
    let switched: string | null = null;
    let opened: string | null = null;
    let frame = 0;
    let glide = 0;
    let reveals = 0;
    const stopGlide = () => {
      cancelAnimationFrame(glide);
      glide = 0;
    };
    const glideTo = (to: number) => {
      stopGlide();
      const from = scrollY.current ?? 0;
      if (reduceMotion() || Math.abs(to - from) < 1) return void scroll.current?.scrollTo({ y: to, animated: false });
      const start = Date.now();
      const placed = [from];
      const step = () => {
        const now = scrollY.current ?? from;
        if (!placed.some((y) => Math.abs(now - y) <= 2)) return void (glide = 0);
        const { y, done } = glideOffsets(from, to, Date.now() - start);
        placed.push(y);
        if (placed.length > 4) placed.shift();
        scroll.current?.scrollTo({ y, animated: false });
        glide = done ? 0 : requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    const show = (y: number, height: number) => {
      const top = scrollY.current ?? 0;
      const { viewport, edgeLift = 0 } = geometry.current;
      if (y - top < GLOW_ROOM) glideTo(Math.max(0, y - GLOW_ROOM + edgeLift - REVEAL_GLIDE.margin));
      else if (y + height - top > viewport - GLOW_ROOM) glideTo(y + height - viewport + REVEAL_GLIDE.margin);
    };
    const reveal = () => {
      frame = 0;
      if (!geometry.current.viewport || !scroll.current) return;
      const mine = ++reveals;
      const tabId = switched ?? opened;
      switched = opened = null;
      if (!tabId) return;
      stopGlide();
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
      cancelAnimationFrame(glide);
      unsubscribe();
      geometry.current.laidOut = undefined;
    };
  }, [windowId]);
}
