import { forwardRef, memo, useCallback, useState } from "react";
import type { FadeLabelProps } from "@ardia/shell";
import { Text, View, type LayoutChangeEvent, type TextProps, type TextStyle, type ViewStyle } from "react-native";
import { labelTextStyle } from "./labelStyle";
import { finite, useDark, useFirstWindow } from "./shared";

const CELL_PADDING = 2;
const FADE_SLICES = 6;
const RUN_WIDTH = 100000;

const frame: ViewStyle = { justifyContent: "center", overflow: "hidden" };
const runRow: ViewStyle = { position: "absolute", top: 0, bottom: 0, width: RUN_WIDTH, flexDirection: "row", alignItems: "center", paddingLeft: CELL_PADDING };

type RunProps = { text: string; textStyle: TextStyle; left: number; width?: number; opacity?: number; onTextLayout?: TextProps["onLayout"] };

const Run = memo(function Run({ text, textStyle, left, width, opacity, onTextLayout }: RunProps) {
  const line = (
    <View style={[runRow, { left: width === undefined ? 0 : -left }]}>
      <Text accessible={false} numberOfLines={1} ellipsizeMode="clip" allowFontScaling={false} style={textStyle} onLayout={onTextLayout}>
        {text}
      </Text>
    </View>
  );
  if (width === undefined) return line;
  return <View style={{ position: "absolute", top: 0, bottom: 0, left, width, opacity, overflow: "hidden" }}>{line}</View>;
});

export const FadeLabel = forwardRef<View, FadeLabelProps>(function FadeLabel({ text, fontSize, weight, fontFamily, color, fadeWidth, strikethrough, style, onLayout, ...rest }, ref) {
  useFirstWindow();
  const dark = useDark(undefined);
  const [boxWidth, setBoxWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const label = typeof text === "string" ? text : text == null ? "" : String(text);
  const textStyle: TextStyle = labelTextStyle({ fontSize, weight, fontFamily, color, strikethrough }, dark);
  const measureBox = useCallback(
    (event: LayoutChangeEvent) => {
      setBoxWidth(event.nativeEvent.layout.width);
      onLayout?.(event);
    },
    [onLayout],
  );
  const measureText = useCallback((event: LayoutChangeEvent) => setTextWidth(event.nativeEvent.layout.width), []);
  const fade = Math.min(boxWidth, Math.max(0, finite(fadeWidth, 24)));
  const overflows = boxWidth > 0 && fade > 0 && textWidth + 2 * CELL_PADDING > boxWidth + 0.5;
  const runs = [<Run key="solid" text={label} textStyle={textStyle} left={0} width={overflows ? boxWidth - fade : undefined} onTextLayout={measureText} />];
  if (overflows) {
    const slice = fade / FADE_SLICES;
    for (let i = 0; i < FADE_SLICES; i++) {
      runs.push(<Run key={i} text={label} textStyle={textStyle} left={boxWidth - fade + i * slice} width={slice} opacity={1 - (i + 0.5) / FADE_SLICES} />);
    }
  }
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} {...rest} ref={ref} onLayout={measureBox} pointerEvents="none" style={[frame, style]}>
      {runs}
    </View>
  );
});
