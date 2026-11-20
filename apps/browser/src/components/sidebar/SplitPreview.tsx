import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { FadeLabel, radius, sidebarFont, sidebarLineHeight, space } from "../ui";
import { previewSlots, SPLIT_MAX_PANES, SPLIT_PANE, splitPaneShape } from "./splitPaneGeometry";
import { spring } from "../ui/motion";
import { useTab } from "../../state/browser/hooks";
import { tabTitle } from "../../state/browser/model";
import type { SplitDropSide } from "../../state/drag/drops";
import { TabIcon } from "./TabIcon";
import { ROW_GLYPH, SPLIT_PREVIEW } from "./tokens";
import { profileSurfaces } from "./profileSurfaces";

type PreviewValues = { shown: Animated.Value; hidden: Animated.AnimatedInterpolation<number>; toLeft: Animated.Value };
export type SplitPreviewMotion = { side: SplitDropSide | null; values: PreviewValues | null };

export function useSplitPreview(side: SplitDropSide | null, panes: number): SplitPreviewMotion {
  const previews = !!side && panes < SPLIT_MAX_PANES;
  const [drawn, setDrawn] = useState<SplitDropSide | null>(null);
  if (previews && side !== drawn) setDrawn(side);
  const values = useRef<PreviewValues | null>(null);
  if ((previews || drawn) && !values.current) {
    const shown = new Animated.Value(0);
    values.current = { shown, hidden: shown.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), toLeft: new Animated.Value(side === "left" ? 1 : 0) };
  }
  const placedSide = useRef<SplitDropSide | null>(null);
  useEffect(() => {
    const v = values.current;
    if (!v || (!previews && !drawn)) return;
    const motion = Animated.spring(v.shown, { toValue: previews ? 1 : 0, ...spring(SPLIT_PREVIEW), useNativeDriver: true });
    motion.start(({ finished }) => {
      if (finished && !previews) setDrawn(null);
    });
    return () => motion.stop();
  }, [previews]);
  useEffect(() => {
    const v = values.current;
    const was = placedSide.current;
    placedSide.current = drawn;
    if (!v || !drawn) return;
    const target = drawn === "left" ? 1 : 0;
    if (!was) return v.toLeft.setValue(target);
    const motion = Animated.spring(v.toLeft, { toValue: target, ...spring(SPLIT_PREVIEW), useNativeDriver: true });
    motion.start();
    return () => motion.stop();
  }, [drawn]);
  return { side: drawn, values: drawn ? values.current : null };
}

export function SplitPreview({ panes, values, rowActive }: { panes: string[]; values: PreviewValues; rowActive: boolean }) {
  const theme = useTheme();
  const surfaces = profileSurfaces(theme);
  const [width, setWidth] = useState(0);
  const shape = splitPaneShape();
  const { slot, pitch } = previewSlots(width, panes.length);
  const placed = useMemo(
    () => panes.map((_, i) => Animated.add(i * pitch, Animated.multiply(values.toLeft, pitch))),
    [panes.length, pitch, values.toLeft],
  );
  const empty = useMemo(() => Animated.multiply(Animated.add(1, Animated.multiply(values.toLeft, -1)), panes.length * pitch), [panes.length, pitch, values.toLeft]);
  const pane = { position: "absolute", left: SPLIT_PANE.inset, top: SPLIT_PANE.inset, width: Math.max(0, slot), height: shape.height, borderRadius: shape.corner } as const;
  return (
    <Animated.View pointerEvents="none" onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[StyleSheet.absoluteFill, { opacity: width ? values.shown : 0 }]}>
      {width ? (
        <>
          {rowActive ? null : <View style={[StyleSheet.absoluteFill, { borderRadius: radius.chrome, backgroundColor: theme.tabSelected }]} />}
          <Animated.View style={[pane, { backgroundColor: surfaces.emptySlot, transform: [{ translateX: empty }] }]} />
          {panes.map((id, i) => (
            <Animated.View key={id} style={[pane, PANE_ROW, { backgroundColor: surfaces.activePanes.rest, transform: [{ translateX: placed[i]! }] }]}>
              <PanePreview tabId={id} />
            </Animated.View>
          ))}
        </>
      ) : (
        <View />
      )}
    </Animated.View>
  );
}

export function PanePreview({ tabId, color }: { tabId: string; color?: string }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  if (!tab) return null;
  return (
    <>
      <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} compact />
      <FadeLabel text={tabTitle(tab)} fontSize={sidebarFont.small.fontSize} color={color ?? theme.textTab} style={{ flex: 1, height: Math.max(ROW_GLYPH.box, sidebarLineHeight.small + 1), marginLeft: space.xs }} />
    </>
  );
}

export const PANE_ROW = { flexDirection: "row", alignItems: "center", paddingLeft: space.s, paddingRight: SPLIT_PANE.closeInset } as const;
