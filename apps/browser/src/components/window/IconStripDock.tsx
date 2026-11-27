import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useSettings } from "../../state/browser/hooks";
import { useWindowSettings } from "../../state/browser/keyedWatch";
import { autoHidesTabsIn, iconStripIn } from "../../state/browser/model";
import { useWindowRootWidth } from "../../state/windows/rootSize";
import { iconStripTop } from "../../state/windows/layout";
import { expandWindowSidebar, followWindowWidth } from "../../state/sidebar/sidebarMode";
import { toggleFolderPanel } from "../../state/sidebar/tileFolderUi";
import { updateGroup } from "../../state/groups/actions";
import type { StripItem } from "../../state/sidebar/iconStrip";
import { noteIconStripPress } from "../../state/telemetry/dockCounts";
import { useIsFocusedWindow } from "../../state/windows/hooks";
import { belowStackedLights, useDockMotion } from "../../state/windows/dockMotion";
import { createStripDrags } from "../sidebar/stripPointer";
import { IconStrip, type StripActions } from "../sidebar/IconStrip";
import { ICON_STRIP, stripExpandSnap, stripRail } from "../sidebar/iconStripGeometry";
import { stripDragHandoff } from "../sidebar/stripDrag";
import { useResizeDrag } from "../sidebar/useResizeDrag";
import { useCardFrame } from "./cardFrame";
import { PEEK_IN_MS } from "./tokens";
import { dockedCardInset } from "./dockMotion";

type PeekHandle = { current: { live: boolean; show: () => void; slide: Animated.Value } };

const STRIP_EDGE_WIDTH = 8;
const SETTLE_MS = PEEK_IN_MS + 32;

export const useIconStripShown = (windowId: string): boolean => useWindowSettings(windowId, (s) => iconStripIn(s, windowId));

export function useIconStripInset(windowId: string, beside: boolean, sideInset: number, frameInset: number): number {
  const rootWidth = useWindowRootWidth(windowId);
  const savedWidth = useSettings((st) => st.sidebarWidth);
  useEffect(() => followWindowWidth(windowId, rootWidth), [windowId, rootWidth, savedWidth]);
  return useIconStripShown(windowId) && beside ? dockedCardInset(ICON_STRIP.width, frameInset) : sideInset;
}

type StripDockProps = { windowId: string; right: boolean; shown: boolean; moving: boolean; fullscreen: boolean; peek: PeekHandle; lightsBottom?: number | null };

export function IconStripDock({ windowId, right, shown, moving, fullscreen, peek, lightsBottom = null }: StripDockProps) {
  const [drags] = useState(createStripDrags);
  const kept = useRef(shown);
  if (!moving) kept.current = shown;
  const mounted = shown || (kept.current && moving && !fullscreen);
  const focused = useIsFocusedWindow(windowId);
  const peekOut = useDockMotion((m) => !!m.peeks[windowId]);
  const wasOut = useRef(peekOut);
  useEffect(() => {
    if (!shown || !focused) drags.cancelAll();
  }, [drags, shown, focused]);
  useEffect(() => {
    if (wasOut.current && !peekOut) drags.cancelAll();
    wasOut.current = peekOut;
  }, [drags, peekOut]);
  useEffect(() => () => drags.cancelAll(), [drags]);
  const collapsedByChoice = useWindowSettings(windowId, (s) => autoHidesTabsIn(s, windowId));
  const frame = useCardFrame();
  const cardTop = useWindowSettings(windowId, (s) => iconStripTop(s, windowId, frame.inset));
  const rail = stripRail(belowStackedLights(cardTop, lightsBottom), frame.inset);
  const slide = peek.current.slide;
  const under = useMemo(() => ({ opacity: slide.interpolate({ inputRange: [0, 1], outputRange: [1, 0], extrapolate: "clamp" }) }), [slide]);
  const actions = useMemo<StripActions>(() => {
    const float = () => peek.current.show();
    return {
      pressed: noteIconStripPress,
      open: (item: StripItem) => {
        if (item.kind === "group") return updateGroup(item.groupId, { collapsed: false });
        float();
        if (item.kind === "tileFolder") setTimeout(() => void toggleFolderPanel(windowId, item.folderId), SETTLE_MS);
      },
      drag: (key: string) => drags.track(stripDragHandoff(windowId, key, float, SETTLE_MS, undefined, right)),
    };
  }, [windowId, peek, right, drags]);
  if (!mounted) return null;
  return (
    <View
      pointerEvents={moving ? "none" : "auto"}
      style={{ position: "absolute", [right ? "right" : "left"]: 0, top: 0, bottom: 0, width: ICON_STRIP.width }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, under]}>
        <IconStrip windowId={windowId} right={right} top={rail.top} bottom={rail.bottom} actions={actions} />
      </Animated.View>
      {collapsedByChoice && shown ? <StripEdge windowId={windowId} right={right} /> : null}
    </View>
  );
}

function StripEdge({ windowId, right }: { windowId: string; right: boolean }) {
  const handlers = useResizeDrag({
    min: ICON_STRIP.width,
    max: ICON_STRIP.width,
    direction: right ? -1 : 1,
    saved: () => ICON_STRIP.width,
    onLive: () => {},
    onCommit: () => {},
    snap: { above: stripExpandSnap, onSnap: () => expandWindowSidebar(windowId) },
  });
  return <View {...handlers} style={{ position: "absolute", top: 0, bottom: 0, [right ? "left" : "right"]: -STRIP_EDGE_WIDTH / 2, width: STRIP_EDGE_WIDTH, cursor: "col-resize" }} />;
}
