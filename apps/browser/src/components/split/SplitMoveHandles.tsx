import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";
import type { ToolbarRow } from "../../lib/toolbarRow";
import type { SplitView } from "../../state/browser/types";
import type { PageBarMatch } from "../../state/plugins/pageBar";
import { useTab } from "../../state/browser/hooks";
import { useShortcutHints } from "../../state/commands/commandShortcuts";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import { reorderTick } from "../../state/drag/reorderTick";
import { useShareFor } from "../../state/media/screenShare";
import { useDeveloperMode } from "../../state/site/developerMode";
import { swapSplitPanes } from "../../state/splits/actions";
import { usePaneTopLeftObscured } from "../../state/splits/hooks";
import {
  beginSplitMoveDrag,
  cancelSplitMoveDrag,
  finishSplitMoveDrag,
  registerSplitMoveCommit,
  updateSplitMoveDrag,
  useSplitMoveDrag,
} from "../../state/splits/moveDrag";
import { activate } from "../../state/tabs/actions";
import { SHARE_BAR_HEIGHT } from "../media/ShareBar";
import { PAGE_BAR_HEIGHT } from "../plugins/PluginPageBar";
import { DEVELOPER_BAR } from "../toolbar/tokens";
import { capsule, PageCoverGate, Panel, useHover, usePresence, useTheme, useTooltip, withAlpha } from "../ui";
import type { Rect } from "../window/geometry";
import { developerBarShown, type CardChrome } from "../window/paneChrome";
import { SHADOWS } from "../window/tokens";
import { SplitMoveIcon } from "./SplitMoveIcon";
import { edgeHandleCenter, edgeHandleOrigin, moveHandleTooltip, paneTopChrome, resolveMoveTarget, toolbarHandleCenter } from "./splitMove";
import { MOVE_HANDLE, MOVE_TARGET_ALPHA, moveHandleRadius, moveTargetDashRadius, moveTargetRadius, SPLIT_MOTION, splitColors } from "./tokens";

const MOVE_HINTS = ["movePaneLeft", "movePaneRight", "movePaneUp", "movePaneDown"] as const;

export const SplitMoveHandles = memo(function SplitMoveHandles({
  windowId,
  split,
  panes,
  activeId,
  chrome,
  small,
  toolbarRow,
  cardWidth,
  captionRoom,
  pageBars,
  cardRadius,
}: {
  windowId: string;
  split: SplitView;
  panes: Readonly<Record<string, Rect>>;
  activeId: string | undefined;
  chrome: CardChrome;
  small: boolean;
  toolbarRow: ToolbarRow;
  cardWidth: number;
  captionRoom: number;
  pageBars: Readonly<Record<string, PageBarMatch | null | undefined>>;
  cardRadius: number;
}) {
  const theme = useTheme();
  const hints = useShortcutHints(MOVE_HINTS);
  const tooltip = useTooltip(moveHandleTooltip(split, hints));
  const drag = useSplitMoveDrag(windowId);
  const lastTarget = useRef<string | null>(null);
  const dragging = !!drag?.moved;
  const dragTabId = drag?.tabId ?? null;

  const sourceRect = drag ? panes[drag.tabId] : undefined;
  const start = useMemo(() => {
    if (!drag || !sourceRect) return null;
    if (drag.source === "edge" && drag.edgeStart) return drag.edgeStart;
    const trailing = sourceRect.y === 0 && sourceRect.x + sourceRect.width === cardWidth ? captionRoom : 0;
    return toolbarHandleCenter(sourceRect, toolbarRow, trailing);
  }, [drag?.tabId, drag?.source, drag?.edgeStart?.x, drag?.edgeStart?.y, sourceRect, toolbarRow, cardWidth, captionRoom]);

  const targetId = drag?.moved && start ? resolveMoveTarget(split, panes, drag.tabId, start, drag.dx, drag.dy) : null;

  useEffect(() => {
    if (targetId && targetId !== lastTarget.current) reorderTick();
    lastTarget.current = targetId;
  }, [targetId]);

  const latest = useRef({ split, panes, activeId, toolbarRow, cardWidth, captionRoom });
  latest.current = { split, panes, activeId, toolbarRow, cardWidth, captionRoom };

  useEffect(() => {
    registerSplitMoveCommit(windowId, (ended, dx, dy) => {
      const cur = latest.current;
      const rect = cur.panes[ended.tabId];
      if (ended.moved && rect) {
        const trailing = rect.y === 0 && rect.x + rect.width === cur.cardWidth ? cur.captionRoom : 0;
        const origin =
          ended.source === "edge" && ended.edgeStart
            ? ended.edgeStart
            : toolbarHandleCenter(rect, cur.toolbarRow, trailing);
        const target = resolveMoveTarget(cur.split, cur.panes, ended.tabId, origin, dx, dy);
        if (target) swapSplitPanes(ended.tabId, target, ended.consent);
      }
      if (ended.tabId !== cur.activeId) activate(ended.tabId);
    });
    return () => registerSplitMoveCommit(windowId, null);
  }, [windowId]);

  useEffect(() => {
    if (!dragging) return;
    captureEscape("splitMove", true);
    const subscription = onAppEvent((event) => {
      if (event.type !== "dragEscape") return;
      lastTarget.current = null;
      cancelSplitMoveDrag(true, windowId);
    });
    return () => {
      captureEscape("splitMove", false);
      subscription.remove();
    };
  }, [dragging, windowId]);

  useEffect(() => {
    if (dragTabId && !panes[dragTabId]) {
      lastTarget.current = null;
      cancelSplitMoveDrag(false, windowId, dragTabId);
    }
  }, [dragTabId, panes, windowId]);

  const colors = splitColors(theme.dark);
  const targetRect = drag?.moved && targetId ? panes[targetId] : undefined;
  const targetCorner = moveTargetRadius(cardRadius);
  const dashCorner = moveTargetDashRadius(cardRadius);
  const handleCorner = moveHandleRadius();
  const showEdgeHandles = chrome.kind === "none";
  const entries = showEdgeHandles ? Object.entries(panes) : [];

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {dragging && <View pointerEvents="auto" style={[StyleSheet.absoluteFill, GRABBING]} />}
      {drag?.moved && sourceRect && (
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
        <PaneEdgeMoveHandle
          key={tabId}
          windowId={windowId}
          tabId={tabId}
          rect={rect}
          chrome={chrome}
          small={small}
          toolbarHeight={toolbarRow.height}
          hasPageBar={!!pageBars[tabId]}
          tooltip={tooltip}
          draggingAny={dragging}
          draggingThis={dragTabId === tabId}
        />
      ))}
      {drag?.moved && start && (
        <Panel
          pointerEvents="none"
          fill={colors.moveHandleHoverFill}
          border={targetId ? theme.accent : colors.moveHandleHoverBorder}
          radius={handleCorner}
          shadow={SHADOWS.status}
          style={[
            HANDLE_FACE,
            {
              position: "absolute",
              left: start.x + drag.dx - MOVE_HANDLE.box / 2,
              top: start.y + drag.dy - MOVE_HANDLE.box / 2,
            },
          ]}
        >
          <SplitMoveIcon size={MOVE_HANDLE.glyph} color={targetId ? theme.accent : colors.moveHandleHoverIcon} />
        </Panel>
      )}
    </View>
  );
});

const PaneEdgeMoveHandle = memo(function PaneEdgeMoveHandle({
  windowId,
  tabId,
  rect,
  chrome,
  small,
  toolbarHeight,
  hasPageBar,
  tooltip,
  draggingAny,
  draggingThis,
}: {
  windowId: string;
  tabId: string;
  rect: Rect;
  chrome: CardChrome;
  small: boolean;
  toolbarHeight: number;
  hasPageBar: boolean;
  tooltip: string | undefined;
  draggingAny: boolean;
  draggingThis: boolean;
}) {
  const theme = useTheme();
  const { hovered, hoverProps, clearHover } = useHover();
  const url = useTab(tabId, (t) => t?.url ?? "");
  const sharing = !!useShareFor(tabId);
  const developerBar = developerBarShown(chrome, { developerMode: useDeveloperMode(url), small, fullscreen: false });
  const obscured = usePaneTopLeftObscured(tabId);
  const topChrome = paneTopChrome({
    chrome,
    toolbarHeight,
    collapsed: false,
    topBarHeight: developerBar ? DEVELOPER_BAR.height : hasPageBar ? PAGE_BAR_HEIGHT : 0,
    shareBarHeight: sharing ? SHARE_BAR_HEIGHT : 0,
  });
  const origin = edgeHandleOrigin(rect, topChrome);
  const center = edgeHandleCenter(rect, topChrome);
  const latest = useRef({ windowId, tabId, center, clearHover });
  latest.current = { windowId, tabId, center, clearHover };

  useEffect(() => {
    clearHover();
  }, [origin.x, origin.y, clearHover]);

  useEffect(() => {
    if (obscured) clearHover();
  }, [obscured, clearHover]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const cur = latest.current;
          beginSplitMoveDrag(cur.windowId, cur.tabId, "edge", cur.center);
        },
        onPanResponderMove: (_, g) => updateSplitMoveDrag(latest.current.windowId, latest.current.tabId, g.dx, g.dy, MOVE_HANDLE.dragSlop),
        onPanResponderRelease: (_, g) => {
          const cur = latest.current;
          cur.clearHover();
          finishSplitMoveDrag(cur.windowId, cur.tabId, g.dx, g.dy);
        },
        onPanResponderTerminate: () => {
          const cur = latest.current;
          cur.clearHover();
          cancelSplitMoveDrag(false, cur.windowId, cur.tabId);
        },
      }),
    [],
  );

  const expanded = (hovered || draggingThis) && !obscured && !draggingAny;
  const { shown, appear } = usePresence(expanded ? true : null, SPLIT_MOTION.handlePresence, true);
  const colors = splitColors(theme.dark);
  const corner = moveHandleRadius();
  const coverKey = `${Math.round(origin.x)}:${Math.round(origin.y)}`;
  const hitHeight = expanded ? MOVE_HANDLE.edgeNotchTop + MOVE_HANDLE.box : MOVE_HANDLE.edgeHitHeight;

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
        width: MOVE_HANDLE.edgeHitWidth,
        height: hitHeight,
        alignItems: "center",
        cursor: draggingThis ? "grabbing" : "grab",
      }}
    >
      {!obscured && !draggingAny && !shown && (
        <View
          pointerEvents="none"
          style={{
            marginTop: MOVE_HANDLE.edgeNotchTop,
            width: MOVE_HANDLE.edgeNotchWidth,
            height: MOVE_HANDLE.edgeNotchHeight,
            borderRadius: capsule(MOVE_HANDLE.edgeNotchHeight),
            backgroundColor: colors.moveNotch,
          }}
        />
      )}
      {shown ? (
        <PageCoverGate covering={expanded}>
          <Animated.View pointerEvents="none" style={{ marginTop: MOVE_HANDLE.edgeNotchTop, opacity: appear }}>
            <Panel
              key={coverKey}
              glass
              fill={colors.moveHandleHoverFill}
              border={colors.moveHandleHoverBorder}
              radius={corner}
              shadow={SHADOWS.status}
              style={HANDLE_FACE}
            >
              <SplitMoveIcon size={MOVE_HANDLE.glyph} color={colors.moveHandleHoverIcon} />
            </Panel>
          </Animated.View>
        </PageCoverGate>
      ) : null}
    </View>
  );
});

const HANDLE_FACE = { width: MOVE_HANDLE.box, height: MOVE_HANDLE.box, alignItems: "center", justifyContent: "center" } as const;
const GRABBING = { cursor: "grabbing" } as const;
