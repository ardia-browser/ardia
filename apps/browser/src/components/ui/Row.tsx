import { Symbol } from "./Symbol";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Divider } from "./Divider";
import { useTheme } from "./theme";
import { lineHeight, radius, space, font as typeScale } from "./tokens";
import { useHover } from "./useHover";
import { HoverFill } from "./HoverFill";
import { useNativeForm } from "./nativeForm";

export function Row({ title, description, children, icon, onPress }: { title?: ReactNode; description?: ReactNode; children?: ReactNode; icon?: ReactNode; onPress?: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const native = useNativeForm();
  const body = (
    <View
      style={{
        minHeight: native ? NATIVE_ROW_HEIGHT : 40,
        paddingHorizontal: space.l,
        paddingVertical: native ? space.s : space.m,
        flexDirection: "row",
        alignItems: "center",
        gap: space.l,
      }}
    >
      {onPress ? <HoverFill shown={hovered} color={theme.rowHover} radius={0} /> : null}
      {icon}
      <View style={{ flex: 1 }}>
        {typeof title === "string" ? <Text style={{ ...typeScale.body, color: theme.textPrimary }}>{title}</Text> : title}
        {description ? (
          typeof description === "string" ? (
            <Text style={{ ...typeScale.caption, marginTop: space.xxs, color: theme.textSecondary, lineHeight: lineHeight.caption }}>{description}</Text>
          ) : (
            description
          )
        ) : null}
      </View>
      {children}
      {onPress && <Symbol name="chevron.right" size={11} weight="semibold" color={theme.textTertiary} style={{ width: 12, height: 14 }} />}
    </View>
  );
  if (!onPress) return body;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>{body}</Pressable>
    </View>
  );
}

const NATIVE_ROW_HEIGHT = 34;

export function Group({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const rows = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  return (
    <View style={{ borderRadius: radius.panel, backgroundColor: theme.groupFill, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: theme.groupBorder, overflow: "hidden" }}>
      {rows.map((row, i) => (
        <View key={i}>
          {i > 0 && <Divider thick inset="l" />}
          {row}
        </View>
      ))}
    </View>
  );
}
