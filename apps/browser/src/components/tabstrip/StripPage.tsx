import { memo, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Animated, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView, View } from "react-native";
import { PageProfileContext, useWindowId } from "../../state/browser/hooks";
import { tabDragging } from "../../state/drag/tabDrag";
import { useShownTabIdFor, useStripEntries, useStripTitleNeeds } from "../../state/tabs/topStrip";
import { setMeasuredWidth, useMeasuredWidths } from "../../state/windows/measuredWidths";
import { dismissStripHoverIn, stripPageOffstage } from "../../state/tabs/stripHover";
import { onTabPressEnd, tabPressHeld } from "../../state/sidebar/heldTabPress";
import { noteTabStripCompact, noteTabStripHeldClose, noteTabStripOverflow, noteTabStripRevealAfterPress, noteTabStripTitledTabs } from "../../state/telemetry/tabStripCounts";
import { Offstage } from "../ui/useHover";
import { usePageStyle } from "../../state/windows/profilePager";
import { ThemeScope } from "../window/ThemeScope";
import { TintInk } from "../ui/TintInk";
import { DockContext, FloatingStrip } from "./context";
import { IncomingGap, useIncomingTab } from "./IncomingTab";
import { chipKey, folderKey, type Strip } from "./model";
import { NewTabButton } from "./NewTabButton";
import { PinnedDock } from "./PinnedDock";
import { SplitChip } from "./SplitChip";
import { heldWideTab, layoutDock, layoutStrip, newTabPinned, revealOffset, tabsOf, type DragGeometry, type TabWidths } from "./stripGroups";
import { StripGroup } from "./StripGroup";
import { DraggableChip } from "./TabChip";
import { createEdgeFade, edgeOpacityAt, EdgeFadeContext, fadeEntries, refreshEdgeFade } from "./edgeFade";
import { devRegister } from "../dev/devRegister";
import { StripScrollContext, type StripScroll } from "./stripScroll";
import { COMPACT_CHIP, EDGE_FADE, FLARE, GAP, NEW_TAB_ROOM, STRIP_SCROLL_ID } from "./tokens";

type Wide = { tabId: string; slot: number };
type Hold = { widths: TabWidths; end: number; wide: Wide; lead: boolean; needsTitle: (tabId: string) => boolean };

const stripEnd = ({ slots, lefts }: DragGeometry) => (slots.length ? lefts.at(-1)! + slots.at(-1)!.width : 0);

export const StripPage = memo(function StripPage({ profileId, slot, pageWidth, current, resting }: { profileId: string; slot: number; pageWidth: number; current: boolean; resting: boolean }) {
  const windowId = useWindowId();
  const flare = useContext(FloatingStrip) ? 0 : FLARE;
  const pageStyle = usePageStyle(windowId, slot, pageWidth + flare * 2);
  const parsed = useStripEntries(windowId, profileId);
  const activeId = useShownTabIdFor(windowId, profileId);
  const liveNeeds = useStripTitleNeeds(windowId, profileId);
  const shownNeeds = useRef(liveNeeds);
  const groupIds = parsed.flatMap((e) => (e.kind === "group" ? [e.id] : []));
  const chipWidths = useMeasuredWidths(groupIds.map(chipKey));
  const folderIds = parsed.flatMap((e) => (e.kind === "group" ? e.members.flatMap((m) => (m.kind === "folder" ? [m.id] : [])) : []));
  const folderWidths = useMeasuredWidths(folderIds.map(folderKey));
  const chipOf = (groupId: string) => chipWidths[groupIds.indexOf(groupId)];
  const folderChip = (groupId: string) => folderWidths[folderIds.indexOf(groupId)];
  const dockEntry = parsed.find((e) => e.kind === "dock");
  const dock = useMemo(() => layoutDock(dockEntry), [dockEntry]);
  const pointerIn = useRef(false);
  const held = useRef<Hold | null>(null);
  const last = useRef<Omit<Hold, "lead" | "needsTitle"> & { count: number; pageWidth: number; lastSlot: string | undefined }>(null);
  const closedTo = useRef("");
  const [releases, release] = useReducer((n: number) => n + 1, 0);
  const count = parsed.reduce((n, e) => n + (e.kind === "dock" ? 0 : e.kind === "group" ? e.members.flatMap(tabsOf).length : tabsOf(e).length), 0);
  const closedWhileIn = pointerIn.current && !!last.current && count < last.current.count;
  const heldClose = closedWhileIn && !!held.current;
  if (closedWhileIn && last.current) {
    held.current ??= { widths: last.current.widths, end: last.current.end, wide: last.current.wide, lead: false, needsTitle: shownNeeds.current };
    const lastSlot = last.current.lastSlot;
    if (lastSlot && !parsed.some((e) => e.kind !== "dock" && (e.kind === "group" ? e.members.some((m) => tabsOf(m).includes(lastSlot)) : tabsOf(e).includes(lastSlot)))) held.current.lead = true;
    closedTo.current = activeId;
  }
  const needsTitle = held.current?.needsTitle ?? liveNeeds;
  shownNeeds.current = needsTitle;
  const holding = held.current ? heldWideTab(parsed, held.current.wide) : null;
  const wideId = holding?.tabId ?? activeId;
  const { chip, selected, widths, tabWidth, top, targets, memberWidth, spanOf: spanInStrip, tabsEnd, tabsShrink } = layoutStrip(parsed, activeId, pageWidth, { groupChip: chipOf, folderChip, needsTitle }, dock, held.current?.widths, wideId);
  const animateWidths = !held.current && !!last.current && last.current.count === count && last.current.pageWidth === pageWidth;
  last.current = { count, pageWidth, widths, end: stripEnd(top), lastSlot: top.slots.at(-1)?.tabIds[0], wide: { tabId: wideId, slot: Math.max(0, top.slots.findIndex((s) => s.tabIds.includes(wideId))) } };
  const spare = held.current ? Math.max(0, held.current.end - stripEnd(top)) : 0;
  const leadSpare = !!held.current && (held.current.lead || !!holding?.atEnd);
  const pinned = newTabPinned(chip, tabsEnd + spare, pageWidth, tabsShrink);
  const newTab = <NewTabButton windowId={windowId} geometry={top} pinned={pinned} />;
  const leave = () => {
    pointerIn.current = false;
    if (!held.current) return;
    held.current = null;
    release();
  };
  const slotOf = (id: string) => top.slots.findIndex((slot) => slot.tabIds[0] === id);
  const grow = useRef(new Animated.Value(0)).current;
  const strip = useRef<Strip>(null!);
  strip.current = { top, targets, chip, grow, dock, slotOf, animateWidths };
  const incoming = useIncomingTab(windowId, current, top);
  const scroll = useRef<ScrollView>(null);
  const scrolled = useRef(0);
  const viewport = useRef(pageWidth + flare * 2);
  const content = useRef(0);
  const keepInRange = () => {
    const end = Math.max(0, content.current - viewport.current);
    if (scrolled.current > end + 0.5) scroll.current?.scrollTo({ x: end, animated: false });
  };
  const onStage = useRef(current);
  onStage.current = current;
  const [scroller] = useState<StripScroll>(() => ({
    active: () => onStage.current,
    offset: () => scrolled.current,
    max: () => Math.max(0, content.current - viewport.current),
    scrollTo: (x) => {
      scrolled.current = x;
      scroll.current?.scrollTo({ x, animated: false });
    },
    measure: (done) => scroll.current?.getNativeScrollRef()?.measureInWindow((x, _y, width) => done(x, width)),
  }));
  const [atStart, setAtStart] = useState(true);
  const inset = atStart ? flare : 0;
  const scrollX = useRef(new Animated.Value(0)).current;
  const [edgeFade] = useState(() => createEdgeFade(scrollX));
  const fadeOrigin = inset + (dock ? -dock.left : 0);
  useLayoutEffect(() => refreshEdgeFade(edgeFade, fadeOrigin));
  useEffect(
    () =>
      devRegister("topStripPages", `${windowId}|${profileId}`, {
        current: () => current,
        fadeWidth: EDGE_FADE,
        scroll: () => ({ x: scrolled.current, viewport: viewport.current, content: content.current }),
        chips: () => fadeEntries(edgeFade).map((e) => ({ ...e, opacity: edgeOpacityAt(scrolled.current, e.start, e.end, viewport.current, content.current) })),
        scrollTo: (x: number) => scroller.scrollTo(x),
      }),
    [windowId, profileId, current],
  );
  const fadeRange = () => {
    edgeFade.viewport.setValue(viewport.current);
    edgeFade.maxScroll.setValue(Math.max(0, content.current - viewport.current));
  };
  const latestScroll = useRef((_: NativeSyntheticEvent<NativeScrollEvent>) => {});
  latestScroll.current = (e) => {
    if (Math.abs(e.nativeEvent.contentOffset.x - scrolled.current) >= 1) dismissStripHoverIn(windowId);
    scrolled.current = e.nativeEvent.contentOffset.x;
    setAtStart(scrolled.current < 0.5);
  };
  const [onScroll] = useState(() => Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true, listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => latestScroll.current(e) }));
  const spanOf = (tabId: string): [number, number] | null => {
    const span = spanInStrip(tabId);
    return span && [inset + span[0], span[1]];
  };
  const latestSpan = useRef(spanOf);
  latestSpan.current = spanOf;
  const revealed = useRef(activeId);
  const reveal = (tabId: string, animated: boolean) => {
    const span = latestSpan.current(tabId);
    const x = span && revealOffset(span[0], span[1], scrolled.current, viewport.current, EDGE_FADE + GAP);
    if (x === null) return;
    scrolled.current = x;
    scroll.current?.scrollTo({ x, animated });
  };
  const latestReveal = useRef(() => {});
  latestReveal.current = () => {
    if (current && activeId && !tabDragging()) reveal(activeId, false);
  };
  useEffect(() => {
    if (revealed.current === activeId || (held.current && closedTo.current === activeId)) return;
    revealed.current = activeId;
    if (!current || !activeId || tabDragging()) return;
    let frame = 0;
    const later = () => void (frame = requestAnimationFrame(() => reveal(activeId, true)));
    let unsubscribe = () => {};
    if (tabPressHeld(windowId)) {
      noteTabStripRevealAfterPress();
      unsubscribe = onTabPressEnd(windowId, () => {
        if (!tabDragging()) later();
      });
    } else later();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [activeId, current, releases]);
  useEffect(() => {
    if (!current) stripPageOffstage(windowId, profileId);
  }, [current, windowId, profileId]);
  const compact = current && chip <= COMPACT_CHIP && tabsShrink;
  useEffect(() => {
    if (compact) noteTabStripCompact();
  }, [compact]);
  useEffect(() => {
    if (current && pinned) noteTabStripOverflow(count);
  }, [current, pinned, count]);
  useEffect(() => {
    if (heldClose) noteTabStripHeldClose();
  }, [count]);
  const titledTabs = compact ? parsed.reduce((n, e) => n + (e.kind === "dock" ? 0 : (e.kind === "group" ? e.members.flatMap(tabsOf) : tabsOf(e)).filter(needsTitle).length), 0) : 0;
  useEffect(() => {
    if (titledTabs) noteTabStripTitledTabs(titledTabs);
  }, [titledTabs]);
  let slotIndex = 0;
  const gap = (i: number) => (incoming.active ? <IncomingGap key={`gap${i}`} open={incoming.at === i} width={chip} origin={i === 0 ? incoming.origin : undefined} /> : null);

  return (
    <Animated.View
      pointerEvents={current ? "box-none" : "none"}
      onMouseEnter={() => void (pointerIn.current = current)}
      onMouseLeave={leave}
      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: pageWidth + flare * 2, display: resting ? "none" : "flex", ...pageStyle }}
    >
      <PageProfileContext.Provider value={profileId}>
        <ThemeScope>
          <TintInk>
            <DockContext.Provider value={strip}>
              <EdgeFadeContext.Provider value={edgeFade}>
              <StripScrollContext.Provider value={scroller}>
              <Offstage.Provider value={!current}>
                <Animated.ScrollView
                  ref={scroll}
                  horizontal
                  testID={STRIP_SCROLL_ID}
                  disableScrollViewPanResponder
                  showsHorizontalScrollIndicator={false}
                  scrollEventThrottle={16}
                  onLayout={(e) => {
                    const narrower = e.nativeEvent.layout.width < viewport.current - 0.5;
                    viewport.current = e.nativeEvent.layout.width;
                    fadeRange();
                    keepInRange();
                    if (narrower) latestReveal.current();
                  }}
                  onContentSizeChange={(width) => {
                    content.current = width;
                    fadeRange();
                    keepInRange();
                  }}
                  onScroll={onScroll}
                  style={{ flex: 1, marginLeft: flare - inset, marginRight: pinned ? flare + NEW_TAB_ROOM : 0 }}
                  contentContainerStyle={{ alignItems: "flex-start", gap: GAP, paddingLeft: inset, paddingRight: pinned ? Math.max(flare, GAP) : flare }}
                >
                  {parsed.flatMap((e) => {
                    if (e.kind === "dock") return <PinnedDock key="dock" tabIds={e.ids} />;
                    const slot = slotIndex;
                    const lead = slot === 0 && spare && leadSpare ? <View key="held-lead" style={{ width: spare, marginRight: -GAP }} /> : null;
                    const before = gap(slotIndex++);
                    if (e.kind === "group")
                      return [
                        before,
                        <StripGroup
                          key={e.id}
                          entry={e}
                          geometry={top}
                          from={slotOf(e.members[0] ? tabsOf(e.members[0])[0]! : "")}
                          chip={selected}
                          tabWidth={tabWidth}
                          activeId={activeId}
                          chipWidth={chipOf(e.id)}
                          onChipWidth={(width) => setMeasuredWidth(chipKey(e.id), width)}
                          memberWidth={memberWidth}
                          folderMeasured={(groupId) => folderChip(groupId) !== undefined}
                        />,
                      ];
                    if (e.kind === "split")
                      return [before, <SplitChip key={e.id} tabIds={e.tabIds} width={top.slots[slot]!.width} paneWidths={e.tabIds.map(tabWidth)} group={null} />];
                    return [lead, before, <DraggableChip key={e.id} tabId={e.id} width={top.slots[slot]!.width} group={null} />];
                  })}
                  {gap(top.slots.length)}
                  {pinned ? null : newTab}
                  {spare && !leadSpare ? <View style={{ width: spare, marginLeft: -GAP }} /> : null}
                </Animated.ScrollView>
                {pinned ? <View pointerEvents="box-none" style={{ position: "absolute", top: 0, right: flare }}>{newTab}</View> : null}
              </Offstage.Provider>
              </StripScrollContext.Provider>
              </EdgeFadeContext.Provider>
            </DockContext.Provider>
          </TintInk>
        </ThemeScope>
      </PageProfileContext.Provider>
    </Animated.View>
  );
});
