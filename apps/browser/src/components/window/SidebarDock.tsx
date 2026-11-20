import { onWindowEvent, watchSidebarEdge } from "../../state/windows/nativeWindow";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { switchOn } from "../../state/app/switches";
import { useTheme } from "../ui/theme";
import { curve, useGated } from "../ui/motion";
import { Panel, reduceMotion, WindowBackdrop, WindowDragRegion } from "../ui";
import { useSidebarSide, useWindowFullScreen, useWindowId } from "../../state/browser/hooks";
import { useSidebarDockState } from "../../state/windows/hooks";
import { useSidebarWidth } from "../../state/sidebar/hooks";
import { useCardTopInset, useSidebarControlsRowIn, useToolbarLightsCenter } from "../../state/windows/layout";
import { Sidebar } from "../sidebar/Sidebar";
import { ResizeHandle } from "../sidebar/ResizeHandle";
import { dismissHoverIn } from "../../state/sidebar/hover";
import { sidebarUi, useSidebarUi } from "../../state/sidebar/sidebarUi";
import { peekHeld, watchHolds } from "../../state/app/transientUi";
import { noteSidebarPeek } from "../../state/telemetry/usage";
import {
  noteFullScreenPeek,
  noteFullScreenPeekClosed,
  notePageFullScreenPeek,
  noteSidebarPeekClosedWhileResizing,
  noteSidebarPeekResize,
  noteSidebarPeekRevealHeldBack,
  noteSidebarScreenEdge,
  noteSidebarSlide,
} from "../../state/telemetry/dockCounts";
import { ProfileSwipe } from "./ProfileSwipe";
import { ARC_HIDE_MS, DOCK_SLIDE, SHADOWS } from "./tokens";
import {
  EDGE_ARMED,
  EDGE_DISARMED,
  PEEK_EDGE_STRIP,
  TAB_DRAG_EDGE_STRIP,
  dockMove,
  dockState,
  dockedCardInset,
  edgeClosed,
  edgeEventReveals,
  edgeSeen,
  edgeStripOverPage,
  edgeWatchWidth,
  peekBleed,
  peekHoldWidth,
  peekOnScreen,
  peekSpan,
  shownAs,
  watchesEdge,
} from "./dockMotion";
import {
  ARC_LIGHTS_CENTER,
  devPeeks,
  peekShown,
  setDockMoving,
  setPeekLeaving,
  setPeekShown,
  useDockMotion,
} from "../../state/windows/dockMotion";
import { useTabDrag } from "../../state/drag/tabDrag";
import { usePeek } from "./usePeek";
import { useSidebarLights, useTopStripLights } from "./useDockLights";
import { useCardFrame } from "./cardFrame";
import { forgetSidebarDock, noteSidebarDock } from "./sidebarDockCheck";

function useSidebarDock(open: boolean, animate: boolean, arc: boolean): { dock: Animated.Value; away: boolean } {
  const windowId = useWindowId();
  const dock = useRef(new Animated.Value(open ? 1 : 0)).current;
  const was = useRef(open);
  const [away, setAway] = useState(!open);
  useEffect(() => {
    if (was.current === open) return;
    was.current = open;
    const move = dockMove({ open, animated: animate && !reduceMotion() && switchOn("sidebarSlide"), arc, peekOut: peekShown(windowId) });
    if (move === "jump") {
      dock.stopAnimation();
      dock.setValue(open ? 1 : 0);
      setDockMoving(windowId, false);
      setAway(!open);
      return;
    }
    if (open) setAway(false);
    setDockMoving(windowId, true);
    let pastTarget = false;
    const watch = dock.addListener(({ value }) => {
      if (value > 1 || value < 0) pastTarget = true;
    });
    (move === "arcHide"
      ? Animated.timing(dock, { toValue: 0, duration: ARC_HIDE_MS, easing: curve.enter, useNativeDriver: false })
      : Animated.timing(dock, { toValue: open ? 1 : 0, ...DOCK_SLIDE, useNativeDriver: false })
    ).start(({ finished }) => {
      dock.removeListener(watch);
      if (!finished) return;
      noteSidebarSlide(pastTarget);
      setDockMoving(windowId, false);
      if (!open) setAway(true);
    });
  }, [open]);
  useEffect(() => () => setDockMoving(windowId, false), []);
  return { dock, away };
}

type Inset = { top: number; right: number; bottom: number; left: number };

export function DockedLayout({
  fullscreen,
  topTabs,
  inset,
  windowWidth,
  topStrip,
  children,
}: {
  fullscreen: boolean;
  topTabs: boolean;
  inset: Inset;
  windowWidth: number;
  topStrip?: { strip: ReactNode; peek: ReactNode };
  children: ReactNode;
}) {
  const windowId = useWindowId();
  const [open, addressBar] = useSidebarDockState(windowId);
  const right = useSidebarSide(windowId) === "right";
  const dragWidth = useSidebarUi((u) => u.dragWidth[windowId]);
  const width = useSidebarWidth(windowId);
  const arc = addressBar && !topTabs && switchOn("sidebarSlide");
  const toolbarLights = useToolbarLightsCenter();
  const lights = addressBar && !topTabs ? ARC_LIGHTS_CENTER : toolbarLights;
  const { dock, away } = useSidebarDock(open, !fullscreen, arc);
  const frame = useCardFrame();
  const sideInset = right ? inset.right : inset.left;
  const edge = useMemo(
    () =>
      dock.interpolate({
        inputRange: [0, 1],
        outputRange: [sideInset, dockedCardInset(width, frame.inset)],
      }),
    [dock, width, sideInset, frame.inset],
  );
  const hiddenTop = useCardTopInset(frame.inset);
  const top = useMemo(() => dock.interpolate({ inputRange: [0, 1], outputRange: [hiddenTop, inset.top] }), [dock, hiddenTop, inset.top]);
  const stripY = useMemo(() => dock.interpolate({ inputRange: [0, 1], outputRange: [-inset.top, 0] }), [dock, inset.top]);
  const stripShown = topTabs && (open || !away);
  const moving = useDockMotion((m) => !!m.moving[windowId]);
  useTopStripLights(windowId, dock, topTabs && !fullscreen, inset.top, open);
  return (
    <>
      <Animated.View
        style={
          fullscreen
            ? { flex: 1 }
            : {
                flex: 1,
                flexDirection: "row",
                paddingTop: topTabs ? top : inset.top,
                paddingRight: !topTabs && right ? edge : inset.right,
                paddingBottom: inset.bottom,
                paddingLeft: !topTabs && !right ? edge : inset.left,
              }
        }
      >
        {!fullscreen && <WindowDragRegion style={StyleSheet.absoluteFill} />}
        {children}
      </Animated.View>
      {topStrip &&
        stripShown && (
          <Animated.View
            pointerEvents={fullscreen || moving ? "none" : "auto"}
            style={[{ position: "absolute", left: 0, right: 0 }, fullscreen ? { bottom: "100%" } : { top: 0, transform: [{ translateY: stripY }] }]}
          >
            {topStrip.strip}
          </Animated.View>
        )}
      {topStrip && topTabs && !stripShown && topStrip.peek}
      {!topTabs && (
        <SidebarDock
          dock={dock}
          open={open}
          width={width}
          fullscreen={fullscreen}
          arc={arc}
          lights={lights}
          right={right}
          windowWidth={windowWidth}
        />
      )}
      {dragWidth !== undefined && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { cursor: "col-resize" }]} />}
    </>
  );
}

function SidebarDock({
  dock,
  open,
  width,
  fullscreen,
  arc,
  lights,
  right,
  windowWidth,
}: {
  dock: Animated.Value;
  open: boolean;
  width: number;
  fullscreen: boolean;
  arc: boolean;
  lights: readonly [number, number];
  right: boolean;
  windowWidth: number;
}) {
  const theme = useTheme();
  const windowId = useWindowId();
  const controlsRow = useSidebarControlsRowIn(windowId);
  const moving = useDockMotion((m) => !!m.moving[windowId]);
  const draggingTab = useTabDrag((d) => d.phase === "tab" && d.windowId === windowId);
  const edgeOver = useRef(false);
  const arm = useRef(EDGE_ARMED);
  const windowFullScreen = useRef(false);
  windowFullScreen.current = useWindowFullScreen(windowId);
  const fullScreenPeekAt = useRef<number | null>(null);
  const pageFullScreen = useRef(fullscreen);
  pageFullScreen.current = fullscreen;
  const opened = (bounce: boolean) => {
    noteSidebarPeek(bounce);
    if (pageFullScreen.current) notePageFullScreenPeek();
    if (windowFullScreen.current) noteFullScreenPeek();
    fullScreenPeekAt.current = windowFullScreen.current ? Date.now() : null;
  };
  const closed = () => {
    arm.current = edgeClosed(arm.current);
    if (windowId in sidebarUi().dragWidth) noteSidebarPeekClosedWhileResizing();
    if (fullScreenPeekAt.current !== null) noteFullScreenPeekClosed(Date.now() - fullScreenPeekAt.current);
    fullScreenPeekAt.current = null;
    dismissHoverIn(windowId);
  };
  const peek = usePeek((!open || fullscreen) && !moving, arc, () => edgeOver.current || peekHeld(windowId), closed, opened);
  const reveal = () => {
    if (arm.current.armed) latestPeek.current.show();
    else noteSidebarPeekRevealHeldBack();
  };
  const latestPeek = useRef(peek);
  latestPeek.current = peek;
  useEffect(() => {
    if (open && !fullscreen) latestPeek.current.reset();
  }, [open, fullscreen]);
  useEffect(() => (peek.live ? watchHolds("peek", () => latestPeek.current.recheck()) : undefined), [peek.live]);
  const state = dockState({ open, fullscreen, moving, peekLive: peek.live, peekLeaving: peek.leaving });
  const band = draggingTab ? TAB_DRAG_EDGE_STRIP : PEEK_EDGE_STRIP;
  const latestReveal = useRef({ state, right, windowWidth, band, reveal });
  latestReveal.current = { state, right, windowWidth, band, reveal };
  const frame = useCardFrame();
  const peekAt = frame.peek;
  const holdWidth = peekHoldWidth(width, peekAt.left);
  const peeking = peekOnScreen(state);
  const holding = state === "peeking";
  const shown = shownAs(state);
  useLayoutEffect(() => () => dismissHoverIn(windowId), [windowId, shown]);
  const watching = watchesEdge(state, moving);
  const nativeHold = edgeWatchWidth(holding, draggingTab, holdWidth, fullscreen ? 0 : frame.inset);
  useEffect(() => {
    if (!watching) return;
    const sub = onWindowEvent((e) => {
      if (e.type !== "sidebarEdge" || e.id !== windowId) return;
      if (e.screenEdge) noteSidebarScreenEdge(e.screenEdge);
      const at = latestReveal.current;
      if (e.over && !edgeEventReveals(at.state, e.point[0], at.right, at.windowWidth, at.band)) return;
      edgeOver.current = e.over;
      arm.current = edgeSeen(arm.current, "native", e.over);
      if (e.over) latestReveal.current.reveal();
      else latestPeek.current.hide();
    });
    watchSidebarEdge(windowId, true, nativeHold, right, holding || draggingTab);
    return () => {
      sub.remove();
      watchSidebarEdge(windowId, false);
      edgeOver.current = false;
    };
  }, [windowId, watching, nativeHold, right, holding || draggingTab]);
  useEffect(() => {
    if (!open) arm.current = EDGE_DISARMED;
  }, [open]);
  const resizing = useSidebarUi((u) => windowId in u.dragWidth);
  useEffect(() => {
    if (resizing && peek.live) noteSidebarPeekResize();
  }, [resizing]);
  useEffect(() => setPeekLeaving(windowId, state === "leaving"), [windowId, state]);
  useEffect(() => () => setPeekLeaving(windowId, false), [windowId]);
  useEffect(() => setPeekShown(windowId, peek.live, peekSpan(width, right, windowWidth, peekAt.left)), [windowId, peek.live, width, right, windowWidth, peekAt.left]);
  if (__DEV__) devPeeks[windowId] = peek;
  useEffect(() => () => setPeekShown(windowId, false), [windowId]);
  const away = state === "fullscreen" || state === "away";
  const outward = right ? -1 : 1;
  const slideOut = useMemo(() => dock.interpolate({ inputRange: [0, 1], outputRange: [-width * outward, 0] }), [dock, width, outward]);
  const peekIn = useMemo(
    () => peek.slide.interpolate({ inputRange: [0, 1], outputRange: [-12 * outward, width * outward] }),
    [peek.slide, width, outward],
  );
  useSidebarLights(windowId, dock, peek.slide, { width, peeking, fullscreen, lights, right, peekAt });
  const edgeSide = right ? "right" : "left";
  const sidebar = useMemo(
    () => (
      <ProfileSwipe>
        <Sidebar width={width} />
      </ProfileSwipe>
    ),
    [width],
  );

  const enterStrip = () => {
    arm.current = edgeSeen(arm.current, "strip", true);
    reveal();
  };
  const leaveStrip = () => {
    arm.current = edgeSeen(arm.current, "strip", false);
    if (!peek.live) peek.cancelPending(edgeOver.current);
  };

  const strip = useRef(false);
  if (!open || fullscreen) strip.current = true;
  const fade = peeking && !arc;
  const layerOpacity = useGated(fade, peek.slide, 1);
  const layerShift = useGated(peeking, peekIn, 0);
  const layer = useMemo(() => ({ opacity: layerOpacity, transform: [{ translateX: layerShift }] }), [layerOpacity, layerShift]);
  const restingPeek = peeking && (fullscreen || (!open && !moving));
  const panelLayer = useMemo(
    () => ({ opacity: layerOpacity, transform: [{ translateX: restingPeek ? Animated.add(layerShift, -width * outward) : layerShift }] }),
    [layerOpacity, layerShift, restingPeek, width, outward],
  );
  noteSidebarDock(windowId, { peek, open, moving, fullscreen, layer });
  useEffect(() => () => forgetSidebarDock(windowId), [windowId]);
  const panelOn = useRef(new Animated.Value(0)).current;
  useLayoutEffect(() => panelOn.setValue(peeking ? 1 : 0), [panelOn, peeking]);
  const bleed = peekBleed(peekAt.left);
  const [panelHeight, setPanelHeight] = useState(0);

  return (
    <>
      {strip.current && (
        <View
          pointerEvents={!open && !fullscreen && !edgeStripOverPage(frame.inset) ? "auto" : "none"}
          onMouseEnter={enterStrip}
          onMouseLeave={leaveStrip}
          style={{
            position: "absolute",
            [edgeSide]: 0,
            top: 0,
            bottom: frame.inset,
            width: !open && !fullscreen ? PEEK_EDGE_STRIP : 0,
          }}
        />
      )}
      <Animated.View
        pointerEvents={moving || ((fullscreen || !open) && !holding) ? "none" : "box-none"}
        style={{
          position: "absolute",
          ...(away ? { left: -10_000 } : { [edgeSide]: peeking ? peekAt.left : 0 }),
          top: peeking ? peekAt.top : 0,
          bottom: peeking ? peekAt.bottom : 0,
          width,
          transform: [{ translateX: restingPeek ? 0 : fullscreen ? -width * outward : slideOut }],
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, panelLayer]}>
          {strip.current && (
            <Animated.View
              pointerEvents="none"
              style={{ position: "absolute", top: 0, bottom: 0, [edgeSide]: -bleed, [right ? "left" : "right"]: 0, opacity: panelOn }}
              onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
            >
              <Panel fill={theme.windowTint[0]} radius={peekAt.radius} shadow={SHADOWS.sidebarPeek} style={StyleSheet.absoluteFill} />
              {peeking && (
                <View style={[StyleSheet.absoluteFill, { borderRadius: peekAt.radius, overflow: "hidden" }]}>
                  <WindowBackdrop
                    vibrancy
                    {...theme.backdrop}
                    colors={theme.windowTint}
                    grainOpacity={theme.grain}
                    style={{
                      position: "absolute",
                      [edgeSide]: -peekAt.left,
                      top: -peekAt.top,
                      width: windowWidth + bleed,
                      height: panelHeight + peekAt.top + peekAt.bottom,
                    }}
                  />
                </View>
              )}
            </Animated.View>
          )}
          <View style={[{ flex: 1, paddingTop: controlsRow }, peeking ? { borderRadius: peekAt.radius, overflow: "hidden" } : null]}>{sidebar}</View>
          <ResizeHandle windowId={windowId} />
        </Animated.View>
      </Animated.View>
    </>
  );
}
