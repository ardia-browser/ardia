import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import type { MediaKind } from "../../state/library/library";
import { concentric, reduceMotion, Text, useHover, useTheme } from "../ui";
import { LIBRARY_MOTION } from "./motion";
import { LIBRARY } from "./tokens";

const F = LIBRARY.filter;
const PILL_RADIUS = concentric(LIBRARY.search.radius, F.inset);
const OPTIONS: { value: MediaKind; title: string }[] = [
  { value: "all", title: "All" },
  { value: "image", title: "Images" },
  { value: "video", title: "Videos" },
  { value: "audio", title: "Audio" },
];

export const MediaFilter = memo(function MediaFilter({ value, onChange }: { value: MediaKind; onChange: (kind: MediaKind) => void }) {
  const theme = useTheme();
  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === value));
  const position = useRef(new Animated.Value(index)).current;
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const segment = width / OPTIONS.length;
  const hover = useCallback((order: number, inside: boolean) => setHovered((at) => (inside ? order : at === order ? null : at)), []);

  const target = useRef(index);
  const slide = useCallback(
    (to: number) => {
      if (target.current === to) return;
      target.current = to;
      if (reduceMotion()) {
        position.stopAnimation();
        position.setValue(to);
        return;
      }
      Animated.spring(position, { toValue: to, ...LIBRARY_MOTION.filter, useNativeDriver: true }).start();
    },
    [position],
  );
  useEffect(() => slide(index), [slide, index]);
  const choose = useCallback(
    (kind: MediaKind) => {
      slide(Math.max(0, OPTIONS.findIndex((o) => o.value === kind)));
      setTimeout(() => onChange(kind), 0);
    },
    [slide, onChange],
  );

  const pillShift = useMemo(
    () => position.interpolate({ inputRange: [0, OPTIONS.length - 1], outputRange: [0, segment * (OPTIONS.length - 1)] }),
    [position, segment],
  );
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Media Type"
      style={{
        height: F.height,
        padding: F.inset,
        borderRadius: LIBRARY.search.radius,
        backgroundColor: theme.pinnedResting,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.pinnedRestingStroke,
      }}
    >
      <View style={ROW} onLayout={onLayout}>
        {OPTIONS.map((o, i) => (
          <Segment key={o.value} value={o.value} title={o.title} order={i} selected={i === index} filled={segment === 0 && i === index} onChange={choose} onHover={hover} />
        ))}
        {segment > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[PILL, { width: segment, backgroundColor: theme.tabSelected, transform: [{ translateX: pillShift }] }]}
          />
        ) : null}
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={LABELS}>
          {OPTIONS.map((o, i) => (
            <SegmentLabel key={o.value} title={o.title} order={i} position={position} hovered={hovered === i} />
          ))}
        </View>
      </View>
    </View>
  );
});

const Segment = memo(function Segment({
  value,
  title,
  order,
  selected,
  filled,
  onChange,
  onHover,
}: {
  value: MediaKind;
  title: string;
  order: number;
  selected: boolean;
  filled: boolean;
  onChange: (kind: MediaKind) => void;
  onHover: (order: number, inside: boolean) => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  useEffect(() => onHover(order, hovered), [onHover, order, hovered]);
  return (
    <View {...hoverProps} style={SEGMENT_FRAME}>
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={title}
        accessibilityState={{ selected }}
        onPress={() => onChange(value)}
        style={[SEGMENT_FACE, filled ? { backgroundColor: theme.tabSelected } : null]}
      />
    </View>
  );
});

const SegmentLabel = memo(function SegmentLabel({ title, order, position, hovered }: { title: string; order: number; position: Animated.Value; hovered: boolean }) {
  const lit = useMemo(
    () => position.interpolate({ inputRange: [order - 1, order, order + 1], outputRange: [0, 1, 0], extrapolate: "clamp" }),
    [position, order],
  );
  const dim = useMemo(() => Animated.subtract(1, lit), [lit]);
  return (
    <View style={SEGMENT_LABEL}>
      <Animated.View style={{ opacity: dim }}>
        <Text size="small" weight="medium" tone={hovered ? "textPrimary" : "textSecondary"} lines={1}>
          {title}
        </Text>
      </Animated.View>
      <Animated.View style={[LABEL_OVER, { opacity: lit }]}>
        <Text size="small" weight="semibold" tone="textPrimary" lines={1}>
          {title}
        </Text>
      </Animated.View>
    </View>
  );
});

const ROW = { flex: 1, flexDirection: "row" } as const;
const PILL = { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: PILL_RADIUS } as const;
const SEGMENT_FRAME = { flex: 1 } as const;
const SEGMENT_FACE = { flex: 1, borderRadius: PILL_RADIUS } as const;
const LABELS = { ...StyleSheet.absoluteFillObject, flexDirection: "row" } as const;
const SEGMENT_LABEL = { flex: 1, alignItems: "center", justifyContent: "center" } as const;
const LABEL_OVER = { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" } as const;
