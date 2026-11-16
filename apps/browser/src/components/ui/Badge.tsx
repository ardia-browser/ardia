import { useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { badgeFit, badgeTextWidth, type MeasuredBadgeText } from "../../lib/badgeFit";
import { Text } from "./Text";
import { useTheme, type Theme } from "./theme";
import { capsule, font, hairline, lineHeight, space, tabularNums, weight as weights } from "./tokens";

export type BadgeTone = "neutral" | "accent" | "chip" | "now";

const BADGE_SIZE = {
  s: {
    height: 14,
    get type() { return font.badge; },
    get line() { return lineHeight.badge; },
    get weight() { return weights.bold; },
  },
  m: {
    height: 18,
    get type() { return font.tiny; },
    get line() { return lineHeight.tiny; },
    get weight() { return weights.semibold; },
  },
};

const FITTED_MIN_SCALE = 0.6;
const UNFITTED = { pad: space.xs, scale: 1 };
const MEASURE = { position: "absolute", left: 0, top: 0, width: 200, flexDirection: "row", opacity: 0 } as const;

function badgeLook(theme: Theme, tone: BadgeTone) {
  switch (tone) {
    case "accent":
      return { fill: theme.accent, ink: theme.onAccent };
    case "now":
      return { fill: theme.destructive, ink: theme.onAccent };
    case "chip":
      return { fill: theme.chipFill, ink: theme.textSecondary };
    default:
      return { fill: theme.badgeFill, ink: theme.textTab };
  }
}

export function Badge({
  text,
  tone = "neutral",
  size = "m",
  outline,
  ring,
  fill,
  color,
  fit,
  style,
}: {
  text: string | number;
  tone?: BadgeTone;
  size?: "s" | "m";
  outline?: boolean;
  ring?: string;
  fill?: string;
  color?: string;
  fit?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const look = badgeLook(theme, tone);
  const metrics = BADGE_SIZE[size];
  const ink = color ?? (outline ? look.fill : look.ink);
  const [measured, setMeasured] = useState<MeasuredBadgeText | null>(null);
  const label = String(text);
  const type = { ...metrics.type, lineHeight: metrics.line, fontWeight: metrics.weight, color: ink, ...tabularNums };
  const fitting = fit !== undefined;
  const unmeasured = fitting && !measured;
  const { pad, scale } = fitting && measured
    ? badgeFit({ textWidth: badgeTextWidth(measured, label, type.fontSize), room: fit, roomyPad: space.xs, tightPad: space.xxs, minScale: FITTED_MIN_SCALE })
    : UNFITTED;
  const remember = (width: number) =>
    setMeasured((last) => (last && last.text === label && last.fontSize === type.fontSize && last.width === width ? last : { text: label, fontSize: type.fontSize, width }));
  const shape: ViewStyle = {
    height: metrics.height,
    minWidth: metrics.height,
    borderRadius: capsule(metrics.height),
    paddingHorizontal: pad,
    opacity: unmeasured ? 0 : undefined,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: outline ? undefined : (fill ?? look.fill),
    borderWidth: outline ? hairline.panel : ring ? 1 : undefined,
    borderColor: outline ? ink : ring,
  };
  return (
    <View pointerEvents="none" style={style ? [shape, style] : shape}>
      <Text numberOfLines={1} style={scale === 1 ? type : { ...type, fontSize: type.fontSize * scale }}>
        {text}
      </Text>
      {fitting ? (
        <View style={MEASURE}>
          <Text numberOfLines={1} onTextLayout={(e) => remember(e.nativeEvent.lines[0]?.width ?? 0)} style={type}>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
