import type { ReactNode } from "react";
import { Animated, View, type StyleProp, type ViewStyle } from "react-native";
import { FadeLabel, space, Text } from "../ui";
import { SIDEBAR_TYPE, TAB_ROW, TABULAR_NUMS } from "./tokens";

const MEASURE_LABEL = { opacity: 0, fontVariant: TABULAR_NUMS } as const;

export function FolderHeaderTitle({ label, color, style, children }: { label: string; color: string; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const height = TAB_ROW.titleHeight;
  return (
    <Animated.View style={[{ flex: 1, height, marginLeft: TAB_ROW.titleGap, flexDirection: "row", alignItems: "center" }, style]}>
      <View style={{ flexShrink: 1, height, paddingRight: space.m, justifyContent: "center" }}>
        <Text lines={1} weight="medium" style={MEASURE_LABEL}>
          {label}
        </Text>
        <FadeLabel text={label} fontSize={SIDEBAR_TYPE.title} weight="medium" color={color} style={{ position: "absolute", left: 0, right: 0, top: 0, height }} />
      </View>
      {children}
    </Animated.View>
  );
}
