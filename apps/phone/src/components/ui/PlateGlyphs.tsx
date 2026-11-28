import type { ComponentProps } from "react";
import { Text } from "react-native";
import { BarPlusGlyph } from "./BarGlyphs";
import { useSurfaceInk } from "./surfaceInk";
import { Symbol } from "./Symbol";
import { SystemGlyph } from "./SystemGlyph";

export type PlateRole = "label" | "secondaryLabel" | "tertiaryLabel" | "headerText" | "foregroundPrimary" | "foregroundSecondary" | "toastLabel" | "toastDetail" | "rowIcon" | "foregroundTertiary";

export function PlateSymbol({ role = "label", ...props }: Omit<ComponentProps<typeof Symbol>, "color"> & { role?: PlateRole }) {
  return <Symbol {...props} color={useSurfaceInk().roles[role]} />;
}

export function PlateSystemGlyph({ role = "label", ...props }: Omit<ComponentProps<typeof SystemGlyph>, "color"> & { role?: PlateRole }) {
  return <SystemGlyph {...props} color={useSurfaceInk().roles[role]} />;
}

export function PlatePlusGlyph() {
  return <BarPlusGlyph color={useSurfaceInk().roles.label} />;
}

export function PlateText({ inkRole = "label", style, ...props }: ComponentProps<typeof Text> & { inkRole?: PlateRole }) {
  return <Text {...props} style={[style, { color: useSurfaceInk().roles[inkRole] }]} />;
}
