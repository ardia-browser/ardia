import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";
import type { SplitView } from "../../state/browser/types";
import type { PageBarMatch } from "../../state/plugins/pageBar";
import { useTab } from "../../state/browser/hooks";
import { useShortcutHints } from "../../state/commands/commandShortcuts";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import { reorderTick } from "../../state/drag/reorderTick";
import { useShareFor } from "../../state/media/screenShare";
import { useDeveloperMode } from "../../state/site/developerMode";
import { showSplitMenu, swapSplitPanes } from "../../state/splits/actions";
import { usePaneToolbarCollapsed, usePaneTopLeftObscured } from "../../state/splits/hooks";
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
import { ContextMenuArea, PageCoverGate, Panel, useHover, usePresence, useTheme, useTooltip, withAlpha } from "../ui";
import type { Rect } from "../window/geometry";
import { developerBarShown, type CardChrome } from "../window/paneChrome";
import { SHADOWS } from "../window/tokens";
import { SplitMoveIcon } from "./SplitMoveIcon";
import { handleOrigin, moveHandleTooltip, paneTopChrome, resolveMoveTarget } from "./splitMove";
import { MOVE_HANDLE, MOVE_TARGET_ALPHA, moveHandleRadius, moveTargetDashRadius, moveTargetRadius, SPLIT_MOTION, splitColors } from "./tokens";

const MOVE_HINTS = ["movePaneLeft", "movePaneRight", "movePaneUp", "movePaneDown"] as const;

const isPrimaryPress = (event: { nativeEvent?: unknown }) => {
  const raw = event.nativeEvent as { button?: number; ctrlKey?: boolean } | undefined;
  return !raw?.ctrlKey && (raw?.button === undefined || raw.button === 0);
};

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
  const tooltip = useTooltip(moveHandleTooltip(split, hints));
  const drag = useSplitMoveDrag(windowId);
  const lastTarget = useRef<string | null>(null);
  const dragging = !!drag?.moved;
  const dragTabId = drag?.tabId ?? null;

  const targetId = drag?.moved ? resolveMoveTarget(split, panes, drag.tabId, drag.start, drag.dx, drag.dy) : null;

  useEffect(() => {
    if (targetId && targetId !== lastTarget.current) reorderTick();
    lastTarget.current = targetId;
  }, [targetId]);

  const latest = useRef({ split, panes, activeId });
  latest.current = { split, panes, activeId };

  useEffect(() => {
    registerSplitMoveCommit(windowId, (ended, dx, dy) => {
      const cur = latest.current;
      if (ended.moved) {
        const target = resolveMoveTarget(cur.split, cur.panes, ended.tabId, ended.start, dx, dy);
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
  const sourceRect = drag?.moved ? panes[drag.tabId] : undefined;
  const targetRect = drag?.moved && targetId ? panes[targetId] : undefined;
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
          chrome={chrome}
          small={small}
          toolbarHeight={toolbarHeight}
          hasPageBar={chrome.kind === "none" && !!pageBars[tabId]}
          tooltip={tooltip}
          draggingAny={dragging}
          draggingThis={dragTabId === tabId}
        />
      ))}
      {drag?.moved && (
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
              left: drag.start.x + drag.dx - MOVE_HANDLE.box / 2,
              top: drag.start.y + drag.dy - MOVE_HANDLE.box / 2,
            },
          ]}
        >
          <SplitMoveIcon size={MOVE_HANDLE.glyph} color={targetId ? theme.accent : colors.moveHandleHoverIcon} />
        </Panel>
      )}
    </View>
  );
});

const PaneMoveHandle = memo(function PaneMoveHandle({
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
  const latest = useRef({ windowId, tabId, origin, clearHover });
  latest.current = { windowId, tabId, origin, clearHover };

  useEffect(() => {
    clearHover();
  }, [origin.x, origin.y, clearHover]);

  useEffect(() => {
    if (obscured) clearHover();
  }, [obscured, clearHover]);

  const openMenu = useCallback(() => {
    const cur = latest.current;
    cancelSplitMoveDrag(false, cur.windowId, cur.tabId);
    cur.clearHover();
    void showSplitMenu(cur.tabId);
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (e) => isPrimaryPress(e),
        onStartShouldSetPanResponderCapture: (e) => isPrimaryPress(e),
        onMoveShouldSetPanResponder: (e) => isPrimaryPress(e),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const cur = latest.current;
          beginSplitMoveDrag(cur.windowId, cur.tabId, { x: cur.origin.x + MOVE_HANDLE.box / 2, y: cur.origin.y + MOVE_HANDLE.box / 2 });
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

  const visible = (hovered || draggingThis) && !obscured && !draggingAny;
  const { shown, appear } = usePresence(visible ? true : null, SPLIT_MOTION.handlePresence, true);

  const colors = splitColors(theme.dark);
  const corner = moveHandleRadius();
  const coverKey = `${Math.round(origin.x)}:${Math.round(origin.y)}`;
  return (
    <ContextMenuArea
      captureDescendants
      onContextMenu={openMenu}
      pointerEvents={obscured && !draggingThis ? "none" : "auto"}
      style={{
        position: "absolute",
        left: origin.x,
        top: origin.y,
        width: MOVE_HANDLE.box,
        height: MOVE_HANDLE.box,
      }}
    >
      <View
        testID={`ardia.splitMoveHandle.${tabId}`}
        accessibilityRole="button"
        accessibilityLabel="Move Split Pane"
        tooltip={draggingAny ? undefined : tooltip}
        mouseDownCanMoveWindow={false}
        {...hoverProps}
        {...responder.panHandlers}
        style={{
          width: MOVE_HANDLE.box,
          height: MOVE_HANDLE.box,
          cursor: draggingThis ? "grabbing" : "grab",
        }}
      >
        {shown ? (
          <PageCoverGate covering={visible}>
            <Animated.View pointerEvents="none" style={{ opacity: appear }}>
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
    </ContextMenuArea>
  );
});

const HANDLE_FACE = { width: MOVE_HANDLE.box, height: MOVE_HANDLE.box, alignItems: "center", justifyContent: "center" } as const;
const GRABBING = { cursor: "grabbing" } as const;
