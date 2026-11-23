import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";
import type { SplitView } from "../../state/browser/types";
import type { PageBarMatch } from "../../state/plugins/pageBar";
import { useTab } from "../../state/browser/hooks";
import { useShortcutHints } from "../../state/commands/commandShortcuts";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import { reorderTick } from "../../state/drag/reorderTick";
import { useShareFor } from "../../state/media/screenShare";
import { useDeveloperMode } from "../../state/site/developerMode";
import { swapSplitPanes } from "../../state/splits/actions";
import { usePaneToolbarCollapsed, usePaneTopLeftObscured } from "../../state/splits/hooks";
import { activate } from "../../state/tabs/actions";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
import { SHARE_BAR_HEIGHT } from "../media/ShareBar";
import { PAGE_BAR_HEIGHT } from "../plugins/PluginPageBar";
import { DEVELOPER_BAR } from "../toolbar/tokens";
import { PageCoverGate, Panel, useHover, useTheme, useTooltip, withAlpha } from "../ui";
import type { Rect } from "../window/geometry";
import { developerBarShown, type CardChrome } from "../window/paneChrome";
import { SHADOWS } from "../window/tokens";
import { SplitMoveIcon } from "./SplitMoveIcon";
import { handleOrigin, moveHandleTooltip, paneTopChrome, resolveMoveTarget, type Point } from "./splitMove";
import { MOVE_HANDLE, MOVE_TARGET_ALPHA, moveHandleRadius, moveTargetDashRadius, moveTargetRadius, SPLIT_MOTION, splitColors } from "./tokens";

type DragState = { tabId: string; x: number; y: number; targetId: string | null; moved: boolean };

const MOVE_HINTS = ["movePaneLeft", "movePaneRight"] as const;

export const SplitMoveHandles = memo(function SplitMoveHandles({
  windowId,
  split,
  panes,
  activeId,
  chrome,
  small,
  toolbarHeight,
  pageBars,
  cardRadius,
}: {
  windowId: string;
  split: SplitView;
  panes: Readonly<Record<string, Rect>>;
  activeId: string | undefined;
  chrome: CardChrome;
  small: boolean;
  toolbarHeight: number;
  pageBars: Readonly<Record<string, PageBarMatch | null | undefined>>;
  cardRadius: number;
}) {
  const theme = useTheme();
  const hints = useShortcutHints(MOVE_HINTS);
  const tooltip = useTooltip(moveHandleTooltip(hints.movePaneLeft, hints.movePaneRight));
  const [drag, setDrag] = useState<DragState | null>(null);
  const cancelled = useRef(false);
  const lastTarget = useRef<string | null>(null);
  const dragging = !!drag?.moved;
  const dragTabId = drag?.tabId ?? null;

  useEffect(() => {
    if (!dragging) return;
    captureEscape("splitMove", true);
    const subscription = onAppEvent((event) => {
      if (event.type !== "dragEscape") return;
      cancelled.current = true;
      lastTarget.current = null;
      setDrag(null);
    });
    return () => {
      captureEscape("splitMove", false);
      subscription.remove();
    };
  }, [dragging]);

  useEffect(() => {
    if (dragTabId && !panes[dragTabId]) {
      cancelled.current = true;
      lastTarget.current = null;
      setDrag(null);
    }
  }, [dragTabId, panes]);

  const colors = splitColors(theme.dark);
  const sourceRect = drag?.moved ? panes[drag.tabId] : undefined;
  const targetRect = drag?.moved && drag.targetId ? panes[drag.targetId] : undefined;
  const targetCorner = moveTargetRadius(cardRadius);
  const dashCorner = moveTargetDashRadius(cardRadius);
  const handleCorner = moveHandleRadius();
  const entries = Object.entries(panes);

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {dragging && <View pointerEvents="auto" style={[StyleSheet.absoluteFill, GRABBING]} />}
      {sourceRect && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: sourceRect.x,
            top: sourceRect.y,
            width: sourceRect.width,
            height: sourceRect.height,
            borderRadius: targetCorner,
            backgroundColor: colors.moveSourceScrim,
          }}
        />
      )}
      {targetRect && (
        <View
          testID="ardia.splitMoveTarget"
          pointerEvents="none"
          style={{
            position: "absolute",
            left: targetRect.x,
            top: targetRect.y,
            width: targetRect.width,
            height: targetRect.height,
            borderRadius: targetCorner,
            backgroundColor: withAlpha(theme.accent, theme.dark ? MOVE_TARGET_ALPHA.dark : MOVE_TARGET_ALPHA.light),
          }}
        >
          <View
            style={{
              position: "absolute",
              left: MOVE_HANDLE.dashInset,
              right: MOVE_HANDLE.dashInset,
              top: MOVE_HANDLE.dashInset,
              bottom: MOVE_HANDLE.dashInset,
              borderRadius: dashCorner,
              borderStyle: "dashed",
              borderWidth: MOVE_HANDLE.borderWidth,
              borderColor: theme.accent,
            }}
          />
        </View>
      )}
      {entries.map(([tabId, rect]) => (
        <PaneMoveHandle
          key={tabId}
          windowId={windowId}
          tabId={tabId}
          rect={rect}
          focused={tabId === activeId}
          split={split}
          panes={panes}
          chrome={chrome}
          small={small}
          toolbarHeight={toolbarHeight}
          hasPageBar={chrome.kind === "none" && !!pageBars[tabId]}
          tooltip={tooltip}
          draggingAny={dragging}
          draggingThis={dragTabId === tabId}
          cancelled={cancelled}
          lastTarget={lastTarget}
          onDrag={setDrag}
        />
      ))}
      {drag?.moved && (
        <Panel
          pointerEvents="none"
          fill={colors.moveHandleHoverFill}
          border={drag.targetId ? theme.accent : colors.moveHandleHoverBorder}
          radius={handleCorner}
          shadow={SHADOWS.status}
          style={[
            HANDLE_FACE,
            {
              position: "absolute",
              left: drag.x - MOVE_HANDLE.box / 2,
              top: drag.y - MOVE_HANDLE.box / 2,
            },
          ]}
        >
          <SplitMoveIcon size={MOVE_HANDLE.glyph} color={drag.targetId ? theme.accent : colors.moveHandleHoverIcon} />
        </Panel>
      )}
    </View>
  );
});

const PaneMoveHandle = memo(function PaneMoveHandle({
  windowId,
  tabId,
  rect,
  focused,
  split,
  panes,
  chrome,
  small,
  toolbarHeight,
  hasPageBar,
  tooltip,
  draggingAny,
  draggingThis,
  cancelled,
  lastTarget,
  onDrag,
}: {
  windowId: string;
  tabId: string;
  rect: Rect;
  focused: boolean;
  split: SplitView;
  panes: Readonly<Record<string, Rect>>;
  chrome: CardChrome;
  small: boolean;
  toolbarHeight: number;
  hasPageBar: boolean;
  tooltip: string | undefined;
  draggingAny: boolean;
  draggingThis: boolean;
  cancelled: { current: boolean };
  lastTarget: { current: string | null };
  onDrag: (next: DragState | null) => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps, clearHover } = useHover();
  const url = useTab(tabId, (t) => t?.url ?? "");
  const collapsed = usePaneToolbarCollapsed(windowId, tabId, chrome.kind === "pane" && chrome.autoHide && !!url);
  const sharing = !!useShareFor(tabId);
  const developerBar = developerBarShown(chrome, { developerMode: useDeveloperMode(url), small, fullscreen: false });
  const obscured = usePaneTopLeftObscured(tabId);
  const topChrome = paneTopChrome({
    chrome,
    toolbarHeight,
    collapsed,
    topBarHeight: developerBar ? DEVELOPER_BAR.height : hasPageBar ? PAGE_BAR_HEIGHT : 0,
    shareBarHeight: sharing ? SHARE_BAR_HEIGHT : 0,
  });
  const origin = handleOrigin(rect, topChrome);
  const start = useRef<Point>({ x: 0, y: 0 });
  const moved = useRef(false);
  const dragConsent = useRef<ConsentToken | null>(null);
  const latest = useRef({ tabId, focused, split, panes, origin, onDrag, clearHover });
  latest.current = { tabId, focused, split, panes, origin, onDrag, clearHover };

  useEffect(() => {
    clearHover();
  }, [origin.x, origin.y, clearHover]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const cur = latest.current;
          cancelled.current = false;
          moved.current = false;
          lastTarget.current = null;
          dragConsent.current = consentToken();
          start.current = { x: cur.origin.x + MOVE_HANDLE.box / 2, y: cur.origin.y + MOVE_HANDLE.box / 2 };
          cur.onDrag({ tabId: cur.tabId, x: start.current.x, y: start.current.y, targetId: null, moved: false });
        },
        onPanResponderMove: (_, g) => {
          if (cancelled.current) return;
          const cur = latest.current;
          if (!moved.current && Math.hypot(g.dx, g.dy) >= MOVE_HANDLE.dragSlop) moved.current = true;
          const targetId = moved.current ? resolveMoveTarget(cur.split, cur.panes, cur.tabId, start.current, g.dx, g.dy) : null;
          if (targetId && targetId !== lastTarget.current) reorderTick();
          lastTarget.current = targetId;
          cur.onDrag({ tabId: cur.tabId, x: start.current.x + g.dx, y: start.current.y + g.dy, targetId, moved: moved.current });
        },
        onPanResponderRelease: (_, g) => {
          const cur = latest.current;
          if (!cancelled.current) {
            if (moved.current) {
              const targetId = resolveMoveTarget(cur.split, cur.panes, cur.tabId, start.current, g.dx, g.dy);
              if (targetId) {
                cur.clearHover();
                swapSplitPanes(cur.tabId, targetId, dragConsent.current);
              }
            }
            if (!cur.focused) activate(cur.tabId);
          }
          moved.current = false;
          lastTarget.current = null;
          dragConsent.current = null;
          cur.onDrag(null);
        },
        onPanResponderTerminate: () => {
          moved.current = false;
          lastTarget.current = null;
          dragConsent.current = null;
          latest.current.clearHover();
          latest.current.onDrag(null);
        },
      }),
    [],
  );

  const lit = hovered || draggingThis;
  const hidden = (obscured && !draggingThis) || draggingAny;
  const targetOpacity = hidden ? 0 : lit ? 1 : focused ? MOVE_HANDLE.activeOpacity : MOVE_HANDLE.restOpacity;
  const opacity = useRef(new Animated.Value(targetOpacity)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: targetOpacity, ...SPLIT_MOTION.handleFade, useNativeDriver: true }).start();
  }, [targetOpacity]);

  const colors = splitColors(theme.dark);
  const corner = moveHandleRadius();
  const coverKey = `${Math.round(origin.x)}:${Math.round(origin.y)}`;
  return (
    <View
      testID={`ardia.splitMoveHandle.${tabId}`}
      accessibilityRole="button"
      accessibilityLabel="Move Split Pane"
      tooltip={draggingAny ? undefined : tooltip}
      mouseDownCanMoveWindow={false}
      pointerEvents={obscured && !draggingThis ? "none" : "auto"}
      {...hoverProps}
      {...responder.panHandlers}
      style={{
        position: "absolute",
        left: origin.x,
        top: origin.y,
        width: MOVE_HANDLE.box,
        height: MOVE_HANDLE.box,
        cursor: draggingThis ? "grabbing" : "grab",
      }}
    >
      <PageCoverGate covering={!hidden}>
        <Animated.View pointerEvents="none" style={{ opacity }}>
          <Panel
            key={coverKey}
            glass
            fill={lit ? colors.moveHandleHoverFill : colors.moveHandleFill}
            border={lit ? colors.moveHandleHoverBorder : colors.moveHandleBorder}
            radius={corner}
            shadow={SHADOWS.status}
            style={HANDLE_FACE}
          >
            <SplitMoveIcon size={MOVE_HANDLE.glyph} color={lit ? colors.moveHandleHoverIcon : colors.moveHandleIcon} />
          </Panel>
        </Animated.View>
      </PageCoverGate>
    </View>
  );
});

const HANDLE_FACE = { width: MOVE_HANDLE.box, height: MOVE_HANDLE.box, alignItems: "center", justifyContent: "center" } as const;
const GRABBING = { cursor: "grabbing" } as const;
