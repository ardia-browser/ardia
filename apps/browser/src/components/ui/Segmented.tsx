import { Animated, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Symbol } from "./native";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { concentric, radius, space } from "./tokens";
import { buttonMotion, usePressScaleMotion } from "./motion";
import { SlidingThumb, useSlidingThumb } from "./SlidingThumb";

export type SegmentOption<T extends string> = { value: T; title: string; image?: string };

const INSET = StyleSheet.hairlineWidth * 2;
const SEGMENT = { height: 20, imageWidth: 30, glyph: 11, glyphBox: 14 } as const;
const SEGMENT_RADIUS = concentric(radius.control, INSET);

export function Segmented<T extends string>({ options, value, onChange }: { options: SegmentOption<T>[]; value: T; onChange: (value: T) => void }) {
  const theme = useTheme();
  const thumb = useSlidingThumb(value);
  return (
    <View style={{ borderRadius: radius.control, backgroundColor: theme.control, borderWidth: INSET, borderColor: theme.controlBorder, padding: INSET }}>
      <View style={{ flexDirection: "row" }}>
        <SlidingThumb x={thumb.x} width={thumb.width} style={{ borderRadius: SEGMENT_RADIUS, backgroundColor: theme.formAccent }} />
        {options.map((o) => (
          <Segment key={o.value} option={o} selected={o.value === value} onPress={() => onChange(o.value)} onLayout={(e) => thumb.measure(o.value, e)} />
        ))}
      </View>
    </View>
  );
}

function Segment<T extends string>({ option, selected, onPress, onLayout }: { option: SegmentOption<T>; selected: boolean; onPress: () => void; onLayout: (e: LayoutChangeEvent) => void }) {
  const theme = useTheme();
  const ink = selected ? theme.onAccent : theme.icon;
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  return (
    <Pressable
      tooltip={option.image ? option.title : undefined}
      accessibilityRole="button"
      accessibilityLabel={option.title}
      accessibilityState={{ selected }}
      onPress={onPress}
      onPressIn={pressMotion.onPressIn}
      onPressOut={pressMotion.onPressOut}
      onLayout={onLayout}
    >
      <Animated.View
        style={[
          {
            width: option.image ? SEGMENT.imageWidth : undefined,
            height: SEGMENT.height,
            paddingHorizontal: option.image ? undefined : space.m,
            alignItems: "center",
            justifyContent: "center",
          },
          scaleStyle,
        ]}
      >
        {option.image ? (
          <Symbol name={option.image} size={SEGMENT.glyph} color={ink} style={{ width: SEGMENT.glyphBox, height: SEGMENT.glyphBox }} />
        ) : (
          <Text size="small" color={selected ? theme.onAccent : theme.textPrimary} ardiaCentersCapitals>
            {option.title}
          </Text>
        )}
      </Animated.View>
    </Pressable>
  );
}
