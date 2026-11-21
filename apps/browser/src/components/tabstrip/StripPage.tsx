import { memo, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Animated, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView, StyleSheet, View } from "react-native";
import { PageProfileContext, useWindowId } from "../../state/browser/hooks";
import { tabDragging } from "../../state/drag/tabDrag";
import { useShownTabIdFor, useStripEntries, useStripTitleNeeds } from "../../state/tabs/topStrip";
import { setMeasuredWidth, useMeasuredWidths } from "../../state/windows/measuredWidths";
import { dismissStripHoverIn, stripPageOffstage } from "../../state/tabs/stripHover";
import { onTabPressEnd, tabPressHeld } from "../../state/sidebar/heldTabPress";
import { noteTabStripChipsMeasured, noteTabStripCompact, noteTabStripReadable, noteTabStripHeldClose, noteTabStripOverflow, noteTabStripTabsInOverflow, noteTabStripRevealAfterPress, noteTabStripRevealHeldForScroll, noteTabStripScrolled, noteTabStripTitledTabs } from "../../state/telemetry/tabStripCounts";
import { Offstage } from "../ui/useHover";
import { usePageStyle } from "../../state/windows/profilePager";
import { ThemeScope } from "../window/ThemeScope";
import { TintInk } from "../ui/TintInk";
import { DockContext, FloatingStrip } from "./context";
import { IncomingGap, useIncomingTab } from "./IncomingTab";
import { chipKey, folderKey, nameKey, type Strip } from "./model";
import { NewTabButton } from "./NewTabButton";
import { PinnedDock } from "./PinnedDock";
import { SplitChip } from "./SplitChip";
import { heldWideTab, keyedWidths, namesStayTight, layoutDock, layoutStrip, newTabPinned, overflowIn, revealOffset, stripOverflow, withActiveShown, tabsOf, withOverflowCounts, withoutTabs, type DragGeometry, type StripOverflow, type TabWidths } from "./stripGroups";
import { groupChipWidth } from "./stripToggle";
import { StripGroup } from "./StripGroup";
import { DraggableChip } from "./TabChip";
import { edgeMaskAt, edgeStrength } from "./edgeFade";
import { EdgeFadeMask } from "../ui/EdgeFadeMask";
import { devRegister } from "../dev/devRegister";
import { StripScrollContext, type StripScroll } from "./stripScroll";
import { COMPACT_CHIP, GROUP_TITLE_MAX, GROUP_TITLE_TIGHT, EDGE_FADE, EDGE_FADE_FLOOR, EDGE_FADE_ONSET, FLARE, GAP, NEW_TAB_ROOM, STRIP_SCROLL_ID } from "./tokens";

type Wide = { tabId: string; slot: number };
type Hold = { widths: TabWidths; end: number; wide: Wide; lead: boolean; needsTitle: (tabId: string) => boolean; overflow: StripOverflow };

const USER_SCROLL_QUIET_MS = 200;
const OWN_SCROLL_MS = 80;
const OWN_ANIMATED_SCROLL_MS = 600;

const stripEnd = ({ slots, lefts }: DragGeometry) => (slots.length ? lefts.at(-1)! + slots.at(-1)!.width : 0);

export const StripPage = memo(function StripPage({ profileId, slot, pageWidth, current, resting }: { profileId: string; slot: number; pageWidth: number; current: boolean; resting: boolean }) {
  const windowId = useWindowId();
  const flare = useContext(FloatingStrip) ? 0 : FLARE;
  const pageStyle = usePageStyle(windowId, slot, pageWidth + flare * 2);
  const entries = useStripEntries(windowId, profileId);
  const activeId = useShownTabIdFor(windowId, profileId);
  const liveNeeds = useStripTitleNeeds(windowId, profileId);
  const shownNeeds = useRef(liveNeeds);
  const groupIds = entries.flatMap((e) => (e.kind === "group" ? [e.id] : []));
  const chipFrames = useMeasuredWidths(groupIds.map(chipKey));
  const folderIds = entries.flatMap((e) => (e.kind === "group" ? e.members.flatMap((m) => (m.kind === "folder" ? [m.id] : [])) : []));
  const folderWidths = useMeasuredWidths(folderIds.map(folderKey));
  const frameOf = keyedWidths(groupIds, chipFrames);
  const nameWidths = useMeasuredWidths(groupIds.map(nameKey));
  const nameOf = keyedWidths(groupIds, nameWidths);
  const chipsAt = (tight: boolean) => (groupId: string) => groupChipWidth(frameOf(groupId), nameOf(groupId), tight ? GROUP_TITLE_TIGHT : GROUP_TITLE_MAX);
  const folderChip = keyedWidths(folderIds, folderWidths);
  const dockEntry = entries.find((e) => e.kind === "dock");
  const dock = useMemo(() => layoutDock(dockEntry), [dockEntry]);
  const pointerIn = useRef(false);
  const held = useRef<Hold | null>(null);
  const last = useRef<Omit<Hold, "lead" | "needsTitle"> & { count: number; pageWidth: number; lastSlot: string | undefined }>(null);
  const closedTo = useRef("");
  const [releases, release] = useReducer((n: number) => n + 1, 0);
  const count = entries.reduce((n, e) => n + (e.kind === "dock" ? 0 : e.kind === "group" ? e.members.flatMap(tabsOf).length : tabsOf(e).length), 0);
  const closedWhileIn = pointerIn.current && !!last.current && count < last.current.count;
  const heldClose = closedWhileIn && !!held.current;
  if (closedWhileIn && last.current) {
    held.current ??= { widths: last.current.widths, end: last.current.end, wide: last.current.wide, lead: false, needsTitle: shownNeeds.current, overflow: last.current.overflow };
    const lastSlot = last.current.lastSlot;
    if (lastSlot && !entries.some((e) => e.kind !== "dock" && (e.kind === "group" ? e.members.some((m) => tabsOf(m).includes(lastSlot)) : tabsOf(e).includes(lastSlot)))) held.current.lead = true;
    closedTo.current = activeId;
  }
  const needsTitle = held.current?.needsTitle ?? liveNeeds;
  shownNeeds.current = needsTitle;
  const holding = held.current ? heldWideTab(entries, held.current.wide, held.current.overflow.hidden) : null;
  const wideId = holding?.tabId ?? activeId;
  const tightNames = useRef(false);
  const measuresAt = (tight: boolean) => ({ groupChip: chipsAt(tight), folderChip, needsTitle });
  let measures = measuresAt(tightNames.current);
  const heldFit = held.current ? withActiveShown(held.current.overflow, activeId) : null;
  const activeReturned = !!held.current && heldFit !== held.current.overflow;
  let fit = heldFit ?? stripOverflow(entries, activeId, pageWidth, measures, dock, wideId);
  if (!held.current) {
    const tight = namesStayTight(tightNames.current, fit, () => stripOverflow(entries, activeId, pageWidth, measuresAt(false), dock, wideId));
    if (tight !== tightNames.current) {
      tightNames.current = tight;
      measures = measuresAt(tight);
      fit = stripOverflow(entries, activeId, pageWidth, measures, dock, wideId);
    }
  }
  const chipOf = measures.groupChip;
  const overflow = fit.hidden;
  const parsed = withoutTabs(entries, overflow);
  const groupOverflow = new Map(entries.flatMap((e) => (e.kind === "group" ? [[e.id, overflowIn(e, overflow)] as const] : [])));
  const { chip, selected, widths, tabWidth, top, memberWidth, spanOf: spanInStrip, tabsEnd, tabsShrink } = layoutStrip(parsed, activeId, pageWidth, withOverflowCounts(measures, entries, overflow), dock, activeReturned ? undefined : held.current?.widths, wideId, fit.selectedMin, fit.titledMin, fit.compactMin);
  if (held.current && activeReturned) held.current = { ...held.current, overflow: fit, widths };
  const animateWidths = !held.current && !!last.current && last.current.count === count && last.current.pageWidth === pageWidth;
  last.current = { count, pageWidth, widths, overflow: fit, end: stripEnd(top), lastSlot: top.slots.at(-1)?.tabIds[0], wide: { tabId: wideId, slot: Math.max(0, top.slots.findIndex((s) => s.tabIds.includes(wideId))) } };
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
  strip.current = { top, chip, grow, dock, slotOf, animateWidths };
  const incoming = useIncomingTab(windowId, current, top);
  const scroll = useRef<ScrollView>(null);
  const scrolled = useRef(0);
  const viewport = useRef(pageWidth + flare * 2);
  const content = useRef(0);
  const ownScrollUntil = useRef(0);
  const userScrollAt = useRef(-Infinity);
  const userScrolling = () => performance.now() - userScrollAt.current < USER_SCROLL_QUIET_MS;
  const scrollStrip = (x: number, animated: boolean) => {
    scrolled.current = x;
    ownScrollUntil.current = performance.now() + (animated ? OWN_ANIMATED_SCROLL_MS : OWN_SCROLL_MS);
    scroll.current?.scrollTo({ x, animated });
  };
  const keepInRange = () => {
    const end = Math.max(0, content.current - viewport.current);
    if (scrolled.current > end + 0.5 && !userScrolling()) scrollStrip(end, false);
  };
  const clipShown = useRef(0);
  const clipLeft = useRef(new Animated.Value(0)).current;
  const [clipBack] = useState(() => Animated.multiply(clipLeft, -1));
  const onStage = useRef(current);
  onStage.current = current;
  const [scroller] = useState<StripScroll>(() => ({
    active: () => onStage.current,
    offset: () => scrolled.current,
    max: () => Math.max(0, content.current - viewport.current),
    scrollTo: (x) => scrollStrip(x, false),
    measure: (done) => scroll.current?.getNativeScrollRef()?.measureInWindow((x, _y, width) => done(x + clipShown.current, width - clipShown.current)),
  }));
  const stripTabIds = () => parsed.flatMap((e) => (e.kind === "dock" ? e.ids : e.kind === "group" ? e.members.flatMap(tabsOf) : tabsOf(e)));
  const latestTabIds = useRef(stripTabIds);
  latestTabIds.current = stripTabIds;
  const chipsUnderMask = () => {
    const box = viewport.current - clipShown.current;
    const strength = edgeStrength(scrolled.current, viewport.current, content.current);
    return latestTabIds.current().map((id) => {
      const span = latestSpan.current(id);
      if (!span) return { id, start: -1e6, end: -1e6, centre: -1e6, opacity: 1 };
      const start = span[0];
      const end = span[0] + span[1];
      const centre = (start + end) / 2;
      return { id, start, end, centre, opacity: edgeMaskAt(centre - scrolled.current - clipShown.current, box, strength) };
    });
  };
  useEffect(
    () =>
      devRegister("topStripPages", `${windowId}|${profileId}`, {
        current: () => current,
        fadeWidth: EDGE_FADE,
        scroll: () => ({ x: scrolled.current, viewport: viewport.current, content: content.current }),
        chips: chipsUnderMask,
        scrollTo: (x: number) => scroller.scrollTo(x),
      }),
    [windowId, profileId, current],
  );
  const latestScroll = useRef((_: NativeSyntheticEvent<NativeScrollEvent>) => {});
  latestScroll.current = (e) => {
    const now = performance.now();
    if (Math.abs(e.nativeEvent.contentOffset.x - scrolled.current) >= 1) {
      dismissStripHoverIn(windowId);
      if (now > ownScrollUntil.current) {
        userScrollAt.current = now;
        noteTabStripScrolled(now);
      }
    }
    scrolled.current = e.nativeEvent.contentOffset.x;
    const clip = scrolled.current < 0.5 ? 0 : flare;
    if (clip !== clipShown.current) {
      clipShown.current = clip;
      clipLeft.setValue(clip);
    }
  };
  const [onScroll] = useState(() => (e: NativeSyntheticEvent<NativeScrollEvent>) => latestScroll.current(e));
  const spanOf = (tabId: string): [number, number] | null => {
    const span = spanInStrip(tabId);
    return span && [flare + span[0], span[1]];
  };
  const latestSpan = useRef(spanOf);
  latestSpan.current = spanOf;
  const revealed = useRef(activeId);
  const reveal = (tabId: string, animated: boolean) => {
    const span = latestSpan.current(tabId);
    const x = span && revealOffset(span[0] - flare, span[1], scrolled.current, viewport.current - flare, EDGE_FADE + GAP);
    if (x !== null) scrollStrip(x, animated);
  };
  const latestReveal = useRef(() => {});
  latestReveal.current = () => {
    if (!current || !activeId || tabDragging()) return;
    if (userScrolling()) noteTabStripRevealHeldForScroll();
    else reveal(activeId, false);
  };
  useEffect(() => {
    if (revealed.current === activeId || (held.current && closedTo.current === activeId)) return;
    revealed.current = activeId;
    if (!current || !activeId || tabDragging()) return;
    let frame = 0;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const now = () => {
      if (!userScrolling()) return reveal(activeId, true);
      noteTabStripRevealHeldForScroll();
      quiet = setTimeout(now, USER_SCROLL_QUIET_MS);
    };
    const later = () => void (frame = requestAnimationFrame(now));
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
      clearTimeout(quiet);
    };
  }, [activeId, current, releases]);
  useEffect(() => {
    if (!current) stripPageOffstage(windowId, profileId);
  }, [current, windowId, profileId]);
  const chipsMeasured = `${chipFrames.join()}|${nameWidths.join()}|${folderWidths.join()}`;
  const measuredBefore = useRef(chipsMeasured);
  useEffect(() => {
    if (measuredBefore.current === chipsMeasured) return;
    measuredBefore.current = chipsMeasured;
    if (current) noteTabStripChipsMeasured(windowId, performance.now());
  }, [chipsMeasured]);
  const compact = current && chip <= COMPACT_CHIP && tabsShrink;
  useEffect(() => {
    if (compact) noteTabStripCompact();
  }, [compact]);
  const readable = current && fit.compactMin > COMPACT_CHIP;
  useEffect(() => {
    if (readable) noteTabStripReadable();
  }, [readable]);
  useEffect(() => {
    if (current && pinned) noteTabStripOverflow(count);
  }, [current, pinned, count]);
  useEffect(() => {
    if (current && overflow.size) noteTabStripTabsInOverflow(overflow.size);
  }, [current, overflow.size]);
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
        <ThemeScope page>
          <TintInk>
            <DockContext.Provider value={strip}>
              <StripScrollContext.Provider value={scroller}>
              <Offstage.Provider value={!current}>
                <Animated.View pointerEvents="box-none" style={{ flex: 1, marginLeft: clipLeft, marginRight: pinned ? flare + NEW_TAB_ROOM : 0, overflow: "hidden" }}>
                  <EdgeFadeMask pointerEvents="box-none" fadeWidth={EDGE_FADE} floor={EDGE_FADE_FLOOR} onset={EDGE_FADE_ONSET} style={StyleSheet.absoluteFill}>
                  <Animated.View pointerEvents="box-none" style={{ position: "absolute", top: 0, bottom: 0, left: clipBack, right: 0 }}>
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
                        keepInRange();
                        if (narrower) latestReveal.current();
                      }}
                      onContentSizeChange={(width) => {
                        content.current = width;
                        keepInRange();
                      }}
                      onScroll={onScroll}
                      style={{ flex: 1 }}
                      contentContainerStyle={{ alignItems: "flex-start", gap: GAP, paddingLeft: flare, paddingRight: pinned ? Math.max(flare, GAP) : flare }}
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
                              from={slot}
                              chip={selected}
                              tabWidth={tabWidth}
                              activeId={activeId}
                              chipWidth={chipOf(e.id)}
                              onChipFrame={(width) => setMeasuredWidth(chipKey(e.id), width)}
                              memberWidth={memberWidth}
                              folderMeasured={(groupId) => folderChip(groupId) !== undefined}
                              overflowCount={groupOverflow.get(e.id) ?? 0}
                              tightName={tightNames.current}
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
                  </Animated.View>
                  </EdgeFadeMask>
                </Animated.View>
                {pinned ? <View pointerEvents="box-none" style={{ position: "absolute", top: 0, right: flare }}>{newTab}</View> : null}
              </Offstage.Provider>
              </StripScrollContext.Provider>
            </DockContext.Provider>
          </TintInk>
        </ThemeScope>
      </PageProfileContext.Provider>
    </Animated.View>
  );
});
