import { memo, startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useBrowser } from "../../browser/src/state/browser/store";
import { activeTabId } from "../../browser/src/state/browser/model";
import { entriesHeight, rowSpan } from "../../browser/src/state/sidebar/geometry";
import { sidebarEntries } from "../../browser/src/state/sidebar/entries";
import { SIDEBAR_ROW } from "../../browser/src/lib/sidebarMetrics";
import { pagerFor, useSettledProfile } from "../../browser/src/state/windows/profilePager";
import { GLOW_ROOM, type PageSpot } from "../../browser/src/components/sidebar/pageLayout";
import { SCROLL_EDGE } from "../../browser/src/components/sidebar/ScrollEdge";
import { SidebarPage } from "../../browser/src/components/sidebar/SidebarPage";
import type { SidebarPagesProps } from "../../browser/src/components/sidebar/SidebarPages";
import { coversTravel, sameTravel, neighbourPages, RevealQueue, revealRow, setPagerTrack, trackScrollLeft, trackSpan, trackWidth, widenTravel, type RevealAttempt, type RevealTarget, type TravelRange } from "./pagerTrack";

const MAX_REVEAL_FRAMES = 120;

const TRACK_STYLE = { ...StyleSheet.absoluteFillObject, overflow: "hidden" } as const;

type ReadableValue = { __getValue?: () => number };

function preReveal(windowId: string, profileId: string, spot: PageSpot | undefined): RevealAttempt {
  return revealRow(spot as unknown as RevealTarget | undefined, () => {
    const s = useBrowser.getState();
    const tabId = activeTabId(s, windowId, profileId);
    const span = tabId && spot ? rowSpan(s, windowId, profileId, tabId, spot.newTabAtTop) : null;
    if (!span || !spot) return null;
    const { list } = sidebarEntries(s, windowId, profileId);
    const listHeight = (spot.newTabAtTop ? SIDEBAR_ROW.height + SIDEBAR_ROW.gap : 0) + entriesHeight(s, windowId, profileId, list);
    return { ...span, listHeight };
  }, GLOW_ROOM + SCROLL_EDGE.inset);
}

export const SidebarPages = memo(function SidebarPagerTrack({ windowId, pages, paging, width, current, dragging, canDock, available, topField, geometry, onScrollView, onScrollY }: SidebarPagesProps) {
  const settled = useSettledProfile(windowId, current);
  const [spots] = useState(() => new Map<string, PageSpot>());
  const claimed = useRef<PageSpot | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const pager = pagerFor(windowId);
  const waiting = settled !== current;
  useLayoutEffect(() => {
    if (dragging && waiting) pager.bypassHold();
  }, [dragging, waiting, pager]);
  const shown = dragging || !pages.some((page) => page.id === settled) ? current : settled;
  const [neighbours, setNeighbours] = useState(false);
  const [travel, setTravel] = useState<TravelRange | null>(null);
  const span = trackSpan(pages);
  const home = pages.find((page) => page.id === current)?.slot ?? 0;
  const position = useRef<number | null>(null);
  position.current ??= (pager.pos as unknown as ReadableValue).__getValue?.() ?? home;
  const renderTravel = paging ? widenTravel(travel, position.current, home, span) : null;
  const mounted = neighbourPages(pages, current, shown, renderTravel).filter((page) => neighbours || renderTravel || page.id === current || page.id === shown);
  const live = useRef({ home, mounted, travel: renderTravel });
  const selected = useBrowser((s) => mounted.map((page) => activeTabId(s, windowId, page.id) ?? "").join("\n"));

  useLayoutEffect(() => {
    const spot = spots.get(current) ?? null;
    if (spot === claimed.current) return;
    if (claimed.current) claimed.current.owns = false;
    claimed.current = spot;
    if (!spot) {
      onScrollView(null);
      return;
    }
    spot.owns = true;
    Object.assign(geometry.current, { viewport: spot.viewport, regions: spot.regions, tilesFixed: spot.tilesFixed, newTabAtTop: spot.newTabAtTop, edgeLift: spot.edgeLift, ownerShown: () => spot.shown });
    onScrollView(spot.scroller);
    onScrollY(spot.scrollY);
    geometry.current.laidOut?.();
  });

  useLayoutEffect(() => {
    live.current = { home, mounted, travel: renderTravel };
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => startTransition(() => setNeighbours(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const place = (value: number) => {
      position.current = value;
      const left = trackScrollLeft(paging ? value : home, span, width);
      if (Math.abs(element.scrollLeft - left) >= 0.5) element.scrollLeft = left;
      if (!paging) return;
      const now = live.current;
      const next = widenTravel(now.travel, value, now.home, span);
      if (sameTravel(next, now.travel)) return;
      if (!next) setTravel(null);
      else if (!coversTravel(now.mounted, next)) setTravel(next);
    };
    place(paging ? (position.current ?? home) : home);
    setPagerTrack(windowId, paging && width > 0 ? { scroller: element, span } : null);
    if (!paging) return;
    const id = pager.pos.addListener(({ value }) => place(value));
    return () => pager.pos.removeListener(id);
  }, [pager, windowId, paging, home, span, width]);

  useEffect(() => () => setPagerTrack(windowId, null), [windowId]);

  const [reveals] = useState(() => new RevealQueue());
  const revealFrame = useRef(0);
  const launched = useRef(false);
  const mountedKey = mounted.map((page) => page.id).join("\n");
  useLayoutEffect(() => {
    if (!launched.current) {
      launched.current = true;
      reveals.want([current]);
    }
    if (neighbours) reveals.want(mounted.filter((page) => page.id !== shown).map((page) => page.id));
    let frames = 0;
    const attempt = (id: string) => (mounted.some((page) => page.id === id) ? preReveal(windowId, id, spots.get(id)) : "done");
    const pump = () => {
      revealFrame.current = 0;
      if (!reveals.pump(attempt)) return;
      if (++frames > MAX_REVEAL_FRAMES) {
        for (const page of mounted) reveals.forget(page.id);
        return;
      }
      revealFrame.current = requestAnimationFrame(pump);
    };
    cancelAnimationFrame(revealFrame.current);
    pump();
    return () => cancelAnimationFrame(revealFrame.current);
  }, [neighbours, selected, current, shown, available, mountedKey]);

  return (
    <View ref={(view) => void (scroller.current = view as unknown as HTMLElement | null)} pointerEvents={shown === current ? "box-none" : "none"} style={TRACK_STYLE}>
      <View pointerEvents="box-none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: trackWidth(span, width) }}>
        {mounted.map((page) => (
          <SidebarPage
            key={page.id}
            profileId={page.id}
            slot={page.slot}
            paging={paging}
            width={width}
            current={page.id === shown}
            resting={!!page.resting}
            canDock={canDock}
            height={Math.max(0, available - (topField ? GLOW_ROOM : 0))}
            rows={undefined}
            geometry={page.id === shown ? geometry : undefined}
            sharedGeometry={geometry}
            spots={spots}
            onScrollView={onScrollView}
            onScrollY={onScrollY}
          />
        ))}
      </View>
    </View>
  );
});
