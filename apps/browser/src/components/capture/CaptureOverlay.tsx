import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Box, Text } from "../ui";
import { useActiveTabId } from "../../state/browser/hooks";
import { endCapture, finishCapture, useCapturing } from "../../state/capture/capture";
import { dragRect, type Point, type Rect } from "../../state/capture/captureArea";
import { CAPTURE_EDGE, CAPTURE_SHADE, CAPTURE_SIZE_GAP } from "./tokens";

const ESCAPE = [{ key: "Escape" }];

export function CaptureOverlay({ windowId, panes, origin, width, height }: {
  windowId: string;
  panes: Readonly<Record<string, Rect>>;
  origin: Point | null;
  width: number;
  height: number;
}) {
  const active = useCapturing(windowId);
  const shownTab = useActiveTabId();
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const keys = useRef<View>(null);
  const latest = useRef({ panes, origin, width, height });
  latest.current = { panes, origin, width, height };
  const gesture = useRef<{ from: Point; page: Point } | null>(null);

  useEffect(() => {
    if (active) keys.current?.focus();
    else setDrag(null);
  }, [active]);
  useEffect(() => () => endCapture(windowId, { refocus: false }), [windowId]);
  useEffect(() => endCapture(windowId, { refocus: false }), [shownTab, windowId]);

  if (!active || width <= 0) return null;

  const pointer = (e: GestureResponderEvent) => ({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
  const dragTo = (e: GestureResponderEvent): Point | null => {
    const g = gesture.current;
    if (!g) return null;
    const p = pointer(e);
    return { x: g.from.x + p.x - g.page.x, y: g.from.y + p.y - g.page.y };
  };
  const begin = (e: GestureResponderEvent) => {
    const from = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
    gesture.current = { from, page: pointer(e) };
    setDrag({ from, to: from });
  };
  const move = (e: GestureResponderEvent) => {
    const from = gesture.current?.from;
    const to = dragTo(e);
    if (from && to) setDrag({ from, to });
  };
  const finish = (e: GestureResponderEvent) => {
    const from = gesture.current?.from;
    const to = dragTo(e);
    gesture.current = null;
    setDrag(null);
    const now = latest.current;
    if (!from || !to || !now.origin) return endCapture(windowId);
    void finishCapture(windowId, dragRect(from, to, now), now.panes, now.origin);
  };

  const r = drag ? dragRect(drag.from, drag.to, { width, height }) : null;
  return (
    <Pressable
      ref={keys}
      focusable
      enableFocusRing={false}
      keyDownEvents={ESCAPE}
      onKeyDown={(e) => {
        if (e.nativeEvent.key === "Escape") endCapture(windowId);
      }}
      accessibilityLabel="Drag to capture an area of the page"
      onPressIn={begin}
      // @ts-expect-error
      onPressMove={move}
      onPressOut={finish}
      style={[StyleSheet.absoluteFill, { cursor: "crosshair" }]}
    >
      {r ? (
        <>
          <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width, height: r.y, backgroundColor: CAPTURE_SHADE }} />
          <View pointerEvents="none" style={{ position: "absolute", left: 0, top: r.y + r.height, width, bottom: 0, backgroundColor: CAPTURE_SHADE }} />
          <View pointerEvents="none" style={{ position: "absolute", left: 0, top: r.y, width: r.x, height: r.height, backgroundColor: CAPTURE_SHADE }} />
          <View pointerEvents="none" style={{ position: "absolute", left: r.x + r.width, top: r.y, right: 0, height: r.height, backgroundColor: CAPTURE_SHADE }} />
          <View pointerEvents="none" style={{ position: "absolute", left: r.x, top: r.y, width: r.width, height: r.height, borderWidth: 1, borderColor: CAPTURE_EDGE }} />
          <Box pointerEvents="none" fill="tooltipFill" radius="control" padX="s" padY="xxs" style={{ position: "absolute", left: r.x, top: r.y + r.height + CAPTURE_SIZE_GAP }}>
            <Text size="caption" weight="semibold" tone="tooltipText">
              {Math.round(r.width)} × {Math.round(r.height)}
            </Text>
          </Box>
        </>
      ) : (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: CAPTURE_SHADE, alignItems: "center", justifyContent: "center" }]}>
          <Box fill="tooltipFill" radius="control" padX="l" padY="s">
            <Text size="body" weight="semibold" tone="tooltipText">
              Drag to copy an area · Esc to cancel
            </Text>
          </Box>
        </View>
      )}
    </Pressable>
  );
}
