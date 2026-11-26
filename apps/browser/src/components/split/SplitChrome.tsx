import { useShallow } from "zustand/react/shallow";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { updateSplit } from "../../state/splits/actions";
import { useDragFallbackPane } from "../../state/splits/hooks";
import type { SplitView } from "../../state/browser/types";
import { evenPair, resize, type Divider, type Rect } from "../window/geometry";
import { capsule, Panel, space, Symbol, Text, Toast, usePresence } from "../ui";
import { hideToast, useToasts } from "../../state/app/toasts";
import { noteSplit } from "../../state/telemetry/usage";
import { useTab, useWindowId, useWindowProfileId } from "../../state/browser/hooks";
import { useCardFrame } from "../window/cardFrame";
import type { Size } from "../ui/useSettled";
import { overPeek } from "../../state/windows/dockMotion";
import { DROP_SIDES, dropPreviewRect, PANE_SIDES, paneDropTarget } from "./splitDrop";
import { setPageDrop, setTargetResolver, useTabDrag, type PaneDropSide } from "../../state/drag/tabDrag";
import { splitViewAvailable } from "../../state/splits/splits";
import { DROP_PREVIEW, dropPreviewRadius, FOCUS_RING, SPLIT_MOTION, TOAST_ACTION_MS, TOAST_MS } from "./tokens";

export function SplitDividers({ split, dividers, width, height }: { split: SplitView; dividers: Divider[]; width: number; height: number }) {
  return (
    <>
      {dividers.map((d) => (
        <DividerHandle key={d.kind === "root" ? `r${d.index}` : "s"} split={split} divider={d} width={width} height={height} />
      ))}
    </>
  );
}

export type WindowShape = Size & { radius: number };

type Corners = { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number };

export const SplitFocusRing = memo(function SplitFocusRing({ rect, origin, windowShape }: { rect: Rect; origin: { x: number; y: number } | null; windowShape: WindowShape | null }) {
  const theme = useTheme();
  const { inset, radius, splitGap } = useCardFrame();
  const framed = inset > 0;
  const room = framed ? splitGap / 2 : 0;
  const width = framed ? Math.min(FOCUS_RING.width, room) : FOCUS_RING.width;
  const outset = Math.min(FOCUS_RING.width + FOCUS_RING.gap, room);
  const corners = framed ? uniformCorners(radius > 0 ? radius + outset : 0) : windowCorners(rect, origin, windowShape);
  const box = { x: rect.x - outset, y: rect.y - outset, width: rect.width + outset * 2, height: rect.height + outset * 2 };
  const color = theme.powerUpColor ?? theme.accent;
  const edge = (style: { left: number; top: number; width: number; height: number }) => <View style={{ position: "absolute", backgroundColor: color, ...style }} />;
  const corner = (r: number, left: number, top: number, dx: number, dy: number) =>
    r > 0 && (
      <View style={{ position: "absolute", left, top, width: r, height: r, overflow: "hidden" }}>
        <View style={{ position: "absolute", left: dx, top: dy, width: r * 2, height: r * 2, borderRadius: r, borderWidth: width, borderColor: color, overflow: "hidden" }} />
      </View>
    );
  const { topLeft, topRight, bottomLeft, bottomRight } = corners;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {edge({ left: box.x + topLeft, top: box.y, width: box.width - topLeft - topRight, height: width })}
      {edge({ left: box.x + bottomLeft, top: bottom - width, width: box.width - bottomLeft - bottomRight, height: width })}
      {edge({ left: box.x, top: box.y + topLeft, width, height: box.height - topLeft - bottomLeft })}
      {edge({ left: right - width, top: box.y + topRight, width, height: box.height - topRight - bottomRight })}
      {corner(topLeft, box.x, box.y, 0, 0)}
      {corner(topRight, right - topRight, box.y, -topRight, 0)}
      {corner(bottomLeft, box.x, bottom - bottomLeft, 0, -bottomLeft)}
      {corner(bottomRight, right - bottomRight, bottom - bottomRight, -bottomRight, -bottomRight)}
    </View>
  );
});

const uniformCorners = (r: number): Corners => ({ topLeft: r, topRight: r, bottomLeft: r, bottomRight: r });

function windowCorners(rect: Rect, origin: { x: number; y: number } | null, windowShape: WindowShape | null): Corners {
  if (!origin || !windowShape || windowShape.radius <= 0) return uniformCorners(0);
  const r = windowShape.radius;
  const touches = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const left = touches(origin.x + rect.x, 0);
  const top = touches(origin.y + rect.y, 0);
  const right = touches(origin.x + rect.x + rect.width, windowShape.width);
  const bottom = touches(origin.y + rect.y + rect.height, windowShape.height);
  return { topLeft: left && top ? r : 0, topRight: right && top ? r : 0, bottomLeft: left && bottom ? r : 0, bottomRight: right && bottom ? r : 0 };
}

const sizesOf = (split: SplitView) => ({ sizes: split.slots.map((slot) => slot.size), stack: split.slots.find((slot) => "stack" in slot)?.stackSizes });

const CLICK_SLOP = 3;

function DividerHandle({ split, divider, width, height }: { split: SplitView; divider: Divider; width: number; height: number }) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ sizes: number[]; stack?: [number, number] }>(sizesOf(split));
  const dragged = useRef(false);
  const latest = useRef({ split, divider, width, height });
  latest.current = { split, divider, width, height };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          const { split: v } = latest.current;
          start.current = sizesOf(v);
          dragged.current = false;
          setDragging(true);
        },
        onPanResponderMove: (_, g) => {
          const { split: v, divider: d, width: w, height: h } = latest.current;
          const delta = d.vertical ? g.dx : g.dy;
          if (Math.abs(delta) > CLICK_SLOP) dragged.current = true;
          const gap = d.vertical ? d.rect.width : d.rect.height;
          if (d.kind === "root") {
            updateSplit(v.id, { sizes: resize(start.current.sizes, d.index, delta, d.vertical ? w : h, gap) });
          } else if (start.current.stack) {
            const next = resize(start.current.stack, 0, delta, d.vertical ? w : h, gap) as [number, number];
            updateSplit(v.id, { stackSizes: next });
          }
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
      }),
    [],
  );

  const evenOut = () => {
    if (dragged.current) return;
    const { split: v, divider: d } = latest.current;
    const now = sizesOf(v);
    if (d.kind === "root") updateSplit(v.id, { sizes: evenPair(now.sizes, d.index) });
    else if (now.stack) updateSplit(v.id, { stackSizes: [0.5, 0.5] });
    noteSplit("splitDividerResets");
  };

  const { rect, vertical } = divider;
  const active = hovered || dragging;
  const cursor = vertical ? "col-resize" : "row-resize";
  return (
    <View
      {...responder.panHandlers}
      onDoubleClick={evenOut}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        left: rect.x - (vertical ? 2 : 0),
        top: rect.y - (vertical ? 0 : 2),
        width: rect.width + (vertical ? 4 : 0),
        height: rect.height + (vertical ? 0 : 4),
        alignItems: "center",
        justifyContent: "center",
        cursor,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          cursor,
          width: vertical ? HANDLE_THICKNESS : HANDLE_LENGTH,
          height: vertical ? HANDLE_LENGTH : HANDLE_THICKNESS,
          borderRadius: capsule(HANDLE_THICKNESS),
          backgroundColor: theme.mark,
          opacity: dragging ? 0.55 : active ? 0.32 : 0,
        }}
      />
    </View>
  );
}

const HANDLE_THICKNESS = 4;
const HANDLE_LENGTH = 36;

const NOT_DRAGGING = { dragging: null, x: -1, y: -1, lifted: null, outside: false, target: null } as const;

export function DropTargets({ panes, origin }: { panes: Record<string, Rect>; origin: { x: number; y: number } | null }) {
  const windowId = useWindowId();
  const { dragging, x, y, lifted, outside, target } = useTabDrag(
    useShallow((s) =>
      s.phase === "tab"
        ? { dragging: s.windowId === windowId ? s.tabId : null, x: s.x, y: s.y, lifted: s.lifted, outside: s.outside, target: s.target }
        : NOT_DRAGGING,
    ),
  );
  const draggedProfile = useTab(dragging ?? undefined, (t) => t?.profileId);
  const windowProfile = useWindowProfileId();
  const foreign = !!dragging && draggedProfile !== windowProfile;
  const ownPane = !!dragging && dragging in panes && Object.keys(panes).length > 1;
  const full = Object.keys(panes).length >= 3 && !ownPane;
  const sides = ownPane ? PANE_SIDES : DROP_SIDES;
  const fallback = useDragFallbackPane(dragging, panes, windowId);
  const candidates = useMemo((): [string, Rect][] => {
    if (fallback && dragging) return [[fallback, panes[dragging]!]];
    return Object.entries(panes).filter(([tabId]) => tabId !== dragging);
  }, [panes, dragging, fallback]);

  const px = origin ? x - origin.x : -1;
  const py = origin ? y - origin.y : -1;
  const overPage = !!origin && x >= 0 && !overPeek(windowId, x) && Object.values(panes).some((r) => px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height);
  const shown = !!dragging && !foreign && !!origin && !full && !outside && candidates.length > 0 && (lifted ?? overPage);
  const hit = splitViewAvailable && shown && overPage ? paneDropTarget(candidates, px, py, target, sides) : null;
  const preview = shown && overPage;
  const resolver = useRef({ candidates, origin, sides, ready: false });
  resolver.current = { candidates, origin, sides, ready: !!dragging && !foreign && !!origin && !full && candidates.length > 0 && lifted !== false };
  useEffect(() => {
    if (!dragging) return;
    setTargetResolver((x, y, current, outside) => {
      const { candidates, origin, sides, ready } = resolver.current;
      if (!ready || outside || !origin || overPeek(windowId, x)) return null;
      return paneDropTarget(candidates, x - origin.x, y - origin.y, current, sides);
    });
    return () => setTargetResolver(null);
  }, [dragging]);
  useEffect(() => setPageDrop(hit, preview), [hit?.tabId, hit?.side, preview]);
  useEffect(() => () => setPageDrop(null, false), []);
  const pane = hit ? candidates.find(([tabId]) => tabId === hit.tabId)?.[1] : undefined;
  const from = ownPane ? panes[dragging!]! : null;
  const landing = hit && pane ? { rect: dropPreviewRect(pane, hit.side), side: hit.side, stacked: !!from && stackedPanes(from, pane) } : null;
  return <DropPreview landing={landing} />;
}

const stackedPanes = (a: Rect, b: Rect) => Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) > Math.abs(a.x + a.width / 2 - (b.x + b.width / 2));

const STACKED_SWAP_SYMBOL = "arrow.up.arrow.down";
const LANDING_COPY: Record<PaneDropSide, { symbol: string; label: string; shortLabel: string }> = {
  left: { symbol: "rectangle.lefthalf.filled", label: "Add left split", shortLabel: "Left" },
  right: { symbol: "rectangle.righthalf.filled", label: "Add right split", shortLabel: "Right" },
  top: { symbol: "rectangle.tophalf.filled", label: "Add top split", shortLabel: "Top" },
  bottom: { symbol: "rectangle.bottomhalf.filled", label: "Add bottom split", shortLabel: "Bottom" },
  center: { symbol: "arrow.left.arrow.right", label: "Swap panes", shortLabel: "Swap" },
};

type Landing = { rect: Rect; side: PaneDropSide; stacked: boolean };

function DropPreview({ landing }: { landing: Landing | null }) {
  const { shown, appear } = usePresence(landing, SPLIT_MOTION.dropPreview, true);
  if (!shown) return null;
  const { rect, side, stacked } = shown;
  const copy = LANDING_COPY[side];
  const symbol = side === "center" && stacked ? STACKED_SWAP_SYMBOL : copy.symbol;
  const text = rect.width < 160 ? copy.shortLabel : copy.label;
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, opacity: appear }}>
      <Panel
        radius={dropPreviewRadius()}
        fill={DROP_PREVIEW.fill}
        border={DROP_PREVIEW.border}
        borderWidth={DROP_PREVIEW.borderWidth}
        shadow={DROP_PREVIEW.shadow}
        style={[StyleSheet.absoluteFill, { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: space.l }]}
      >
        <Symbol name={symbol} size={16} color={DROP_PREVIEW.label} style={{ width: 22, height: 18 }} />
        {rect.width >= 96 && rect.height >= 40 ? (
          <Text weight="semibold" numberOfLines={1} color={DROP_PREVIEW.label} style={{ marginLeft: space.s, flexShrink: 1 }}>
            {text}
          </Text>
        ) : null}
      </Panel>
    </Animated.View>
  );
}

export const SplitToast = memo(function SplitToast({ windowId }: { windowId: string }) {
  const toast = useToasts((s) => s.toasts[windowId] ?? null);
  const [shown, setShown] = useState(toast);
  const [closing, setClosing] = useState(false);
  const [held, setHeld] = useState(false);
  if (toast && toast !== shown) {
    setShown(toast);
    setClosing(false);
  } else if (!toast && shown && !closing) setClosing(true);
  useEffect(() => {
    if (!toast || toast.sticky || (held && toast.secondary)) return;
    const timer = setTimeout(() => setClosing(true), toast.holdMs ?? (toast.action ? TOAST_ACTION_MS : TOAST_MS));
    return () => clearTimeout(timer);
  }, [toast?.id, held && !!toast?.secondary]);
  if (!shown) return null;
  const { action, secondary } = shown;
  const pick = (chosen: typeof action) => () => {
    chosen?.run();
    setShown(null);
    hideToast(windowId, shown.id);
  };
  return (
    <Toast
      key={shown.id}
      title={shown.title}
      message={shown.message ?? undefined}
      icon={shown.icon ?? "rectangle.split.3x1"}
      action={action?.title}
      onAction={pick(action)}
      secondary={secondary?.title}
      onSecondary={pick(secondary)}
      onHeld={secondary ? setHeld : undefined}
      titleLines={shown.titleLines}
      closing={closing}
      onClosed={() => {
        setShown(null);
        setClosing(false);
        hideToast(windowId, shown.id);
      }}
    />
  );
});
