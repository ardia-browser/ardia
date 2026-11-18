import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "../ui";
import { sidebarLineHeight, space } from "../ui/tokens";

export function SectionLabel({ title, inset, top = 0, bottom = 0, accessory }: { title: string; inset: number; top?: number; bottom?: number; accessory?: ReactNode }) {
  const padding = { paddingHorizontal: inset, paddingTop: top, paddingBottom: bottom };
  const label = (
    <Text lines={1} size="caption" weight="semibold" tone="textSecondary" style={[{ lineHeight: sidebarLineHeight.caption }, accessory ? LABEL_BESIDE_ACCESSORY : padding]}>
      {title}
    </Text>
  );
  if (!accessory) return label;
  return (
    <View style={[ROW, padding]}>
      {label}
      {accessory}
    </View>
  );
}

const ROW = { flexDirection: "row", alignItems: "center", gap: space.s } as const;
const LABEL_BESIDE_ACCESSORY = { flex: 1 } as const;
