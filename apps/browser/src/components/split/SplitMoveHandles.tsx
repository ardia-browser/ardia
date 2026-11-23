import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";
import type { SplitView } from "../../state/browser/types";
import { splitTabIds } from "../../state/splits/splits";
import { cancelSplitPaneDrag, swapSplitPanes } from "../../state/splits/actions";
import { activate } from "../../state/tabs/actions";
import { captureEscape, onAppEvent } from "../../state/drag/dragNative";
import type { Rect } from "../window/geometry";
import { OverPage, tintedImage, useHover, withAlpha } from "../ui";
import { useTheme } from "../ui/theme";
import { MOVE_HANDLE, MOVE_HANDLE_MOTION, splitColors } from "./tokens";
import { clampHandleOffset, handlePosition, paneAtPoint } from "./paneDrag";

const SPLIT_MOVE_ICON = require("../../../assets/split-move.png");

type DragState = {
  tabId: string;
  splitId: string;
  initialOrder: string[];
  startLeft: number;
  startTop: number;
  left: number;
  top: number;
  moved: boolean;
};

export const SplitMoveHandles = memo(function SplitMoveHandles({
  split,
  panes,
  topOffset,
  bounds,
}: {
  split: SplitView;
  panes: Record<string, Rect>;
  topOffset: number;
  bounds: { width: number; height: number };
}) {
  const theme = useTheme();
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const latest = useRef({ split, panes, topOffset, bounds });
  latest.current = { split, panes, topOffset, bounds };
  const lastSwapPanes = useRef<Record<string, Rect> | null>(null);
  const tabIds = Object.keys(panes).sort();
  const activePaneRect = drag?.moved ? panes[drag.tabId] : undefined;

  useEffect(() => {
    if (!drag) return;
    captureEscape("splitPaneDrag", true);
    const sub = onAppEvent((e) => {
      if (e.type !== "dragEscape") return;
      const current = dragRef.current;
      if (!current) return;
      dragRef.current = null;
      setDrag(null);
      if (current.moved) cancelSplitPaneDrag(current.splitId, current.initialOrder);
    });
    return () => {
      captureEscape("splitPaneDrag", false);
      sub.remove();
    };
  }, [!!drag]);

  if (tabIds.length < 2) return null;

  return (
    <View pointerEvents={drag ? "auto" : "box-none"} style={[StyleSheet.absoluteFill, drag ? { cursor: "grabbing" } : null]}>
      {activePaneRect && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: activePaneRect.x,
            top: activePaneRect.y,
            width: activePaneRect.width,
            height: activePaneRect.height,
            backgroundColor: withAlpha(theme.accent, theme.dark ? MOVE_HANDLE.dragTintAlpha.dark : MOVE_HANDLE.dragTintAlpha.light),
          }}
        >
          <OverPage key={`${Math.round(activePaneRect.x)},${Math.round(activePaneRect.y)},${Math.round(activePaneRect.width)},${Math.round(activePaneRect.height)}`} radius={0} />
        </View>
      )}
      {tabIds.map((tabId) => {
        const rect = panes[tabId]!;
        const home = handlePosition(rect, topOffset, MOVE_HANDLE.inset);
        const dragging = drag?.tabId === tabId;
        const pos = dragging && drag.moved ? { left: drag.left, top: drag.top } : home;
        return (
          <MoveHandle
            key={tabId}
            tabId={tabId}
            left={pos.left}
            top={pos.top}
            dragging={dragging}
            moved={dragging && drag.moved}
            latest={latest}
            dragRef={dragRef}
            lastSwapPanes={lastSwapPanes}
            setDrag={setDrag}
          />
        );
      })}
    </View>
  );
});

function MoveHandle({
  tabId,
  left,
  top,
  dragging,
  moved,
  latest,
  dragRef,
  lastSwapPanes,
  setDrag,
}: {
  tabId: string;
  left: number;
  top: number;
  dragging: boolean;
  moved: boolean;
  latest: { current: { split: SplitView; panes: Record<string, Rect>; topOffset: number; bounds: { width: number; height: number } } };
  dragRef: { current: DragState | null };
  lastSwapPanes: { current: Record<string, Rect> | null };
  setDrag: (next: DragState | null) => void;
}) {
  const theme = useTheme();
  const colors = splitColors(theme.dark);
  const { hovered, hoverProps } = useHover();
  const active = hovered || dragging;
  const opacity = useRef(new Animated.Value(MOVE_HANDLE.restOpacity)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: dragging ? MOVE_HANDLE.activeOpacity : hovered ? MOVE_HANDLE.hoverOpacity : MOVE_HANDLE.restOpacity,
      ...(active ? MOVE_HANDLE_MOTION.show : MOVE_HANDLE_MOTION.hide),
      useNativeDriver: true,
    }).start();
  }, [hovered, dragging]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const { split, panes, topOffset } = latest.current;
          const rect = panes[tabId];
          if (!rect) return;
          activate(tabId);
          const home = handlePosition(rect, topOffset, MOVE_HANDLE.inset);
          const next: DragState = {
            tabId,
            splitId: split.id,
            initialOrder: splitTabIds(split),
            startLeft: home.left,
            startTop: home.top,
            left: home.left,
            top: home.top,
            moved: false,
          };
          dragRef.current = next;
          lastSwapPanes.current = null;
          setDrag(next);
        },
        onPanResponderMove: (_, g) => {
          const current = dragRef.current;
          if (!current || current.tabId !== tabId) return;
          const isMoved = current.moved || Math.hypot(g.dx, g.dy) >= MOVE_HANDLE.dragSlop;
          if (!isMoved) return;
          const { panes, bounds } = latest.current;
          const clamped = clampHandleOffset(current.startLeft + g.dx, current.startTop + g.dy, bounds, MOVE_HANDLE.size);
          const next: DragState = { ...current, moved: true, left: clamped.left, top: clamped.top };
          dragRef.current = next;
          setDrag(next);
          if (lastSwapPanes.current === panes) return;
          const target = paneAtPoint(panes, clamped.left + MOVE_HANDLE.size / 2, clamped.top + MOVE_HANDLE.size / 2, tabId);
          if (target && swapSplitPanes(tabId, target, "drag")) lastSwapPanes.current = panes;
        },
        onPanResponderRelease: () => {
          if (dragRef.current?.tabId === tabId) {
            dragRef.current = null;
            lastSwapPanes.current = null;
            setDrag(null);
          }
        },
        onPanResponderTerminate: () => {
          const current = dragRef.current;
          if (current?.tabId !== tabId) return;
          dragRef.current = null;
          lastSwapPanes.current = null;
          setDrag(null);
          if (current.moved) cancelSplitPaneDrag(current.splitId, current.initialOrder);
        },
      }),
    [tabId],
  );

  const fill = dragging ? colors.moveHandleActive : hovered ? colors.moveHandleHover : colors.moveHandleFill;
  const borderColor = moved ? theme.accent : colors.moveHandleBorder;
  const tint = moved ? theme.accent : active ? theme.textPrimary : theme.textSecondary;

  return (
    <Animated.View
      testID={`ardia.splitMoveHandle.${tabId}`}
      tooltip="Drag to reorder split pane"
      accessibilityRole="button"
      accessibilityLabel="Reorder split pane"
      {...hoverProps}
      {...responder.panHandlers}
      style={{
        position: "absolute",
        left,
        top,
        width: MOVE_HANDLE.size,
        height: MOVE_HANDLE.size,
        borderRadius: MOVE_HANDLE.radius,
        borderWidth: 0.5,
        borderColor,
        backgroundColor: fill,
        alignItems: "center",
        justifyContent: "center",
        opacity,
        zIndex: dragging ? 2 : 1,
        cursor: dragging ? "grabbing" : "grab",
      }}
    >
      <OverPage key={`${Math.round(left)},${Math.round(top)}`} radius={MOVE_HANDLE.radius} />
      <View pointerEvents="none">
        {tintedImage({ source: SPLIT_MOVE_ICON, tint, style: { width: MOVE_HANDLE.glyph, height: MOVE_HANDLE.glyph } })}
      </View>
    </Animated.View>
  );
}
