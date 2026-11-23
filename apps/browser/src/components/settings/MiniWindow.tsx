import type { ReactNode } from "react";
import { StyleSheet, View, type DimensionValue } from "react-native";
import { capsule, ink, radius } from "../ui";
import { miniWindow, type MiniWindowGeometry } from "./tokens";

export type MiniWindowLook = { window: string; bar: string; page: string; field?: string; accent?: string; edge?: string; closed?: string };

type MiniWindowSize = keyof typeof miniWindow;

const FAINT_ALPHA = "59";
const OVERLAY = { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" } as const;

const chromeRadius = (g: MiniWindowGeometry, height: number) => Math.min(radius.chrome * g.scale, capsule(height));

export function MiniWindow({
  layout,
  bars = 3,
  accentBar,
  faintBar,
  closedBar,
  field,
  fieldLit,
  look,
  size = "m",
  side = "left",
  children,
  overlay,
}: {
  layout: "side" | "top" | "none";
  side?: "left" | "right";
  bars?: number | readonly number[];
  accentBar?: number;
  faintBar?: number;
  closedBar?: number;
  field?: "side" | "toolbar";
  fieldLit?: boolean;
  look: MiniWindowLook;
  size?: MiniWindowSize;
  children?: ReactNode;
  overlay?: ReactNode;
}) {
  const g = miniWindow[size];
  const widths = typeof bars === "number" ? Array.from({ length: bars }, () => 1) : bars;
  const barColor = (i: number) => (look.accent && i === accentBar ? look.accent : look.accent && i === faintBar ? `${look.accent}${FAINT_ALPHA}` : look.bar);
  const barFill = (i: number) =>
    i === closedBar
      ? { backgroundColor: ink.clear, borderWidth: 1, borderStyle: "dashed" as const, borderColor: look.closed ?? look.bar }
      : { backgroundColor: barColor(i) };
  const fieldEdge = look.accent && fieldLit !== false ? look.accent : undefined;
  const fieldStyle = (height: number) => ({
    height,
    borderRadius: chromeRadius(g, height),
    backgroundColor: look.field ?? look.bar,
    borderWidth: fieldEdge ? 1 : 0,
    borderColor: fieldEdge,
  });
  return (
    <View style={{ flex: 1, padding: g.pad, gap: g.gap, flexDirection: layout === "top" ? "column" : side === "right" ? "row-reverse" : "row", backgroundColor: look.window }}>
      {layout === "side" && (
        <View style={{ width: g.side, gap: g.barGap, paddingTop: field === "side" ? g.sideFieldTop : g.sideTop }}>
          {field === "side" && <View style={fieldStyle(g.sideField)} />}
          {widths.map((w, i) => (
            <View key={i} style={[{ width: `${w * 100}%` as DimensionValue, height: g.bar, borderRadius: capsule(g.bar) }, barFill(i)]} />
          ))}
        </View>
      )}
      {layout === "top" && (
        <View style={{ height: g.tab, flexDirection: "row", gap: g.barGap, paddingLeft: g.tabsLeft }}>
          {widths.map((w, i) => (
            <View key={i} style={[{ flex: w, borderRadius: chromeRadius(g, g.tab) }, barFill(i)]} />
          ))}
        </View>
      )}
      {children ?? (
        <View style={{ flex: 1, borderRadius: radius.chrome * g.scale, backgroundColor: look.page, overflow: "hidden", borderWidth: look.edge ? 1 : 0, borderColor: look.edge }}>
          {field === "toolbar" && (
            <View style={{ height: g.toolbar, flexDirection: "row", alignItems: "center", paddingHorizontal: g.barGap, gap: g.barGap, borderBottomWidth: 1, borderBottomColor: look.field ?? look.bar }}>
              <View style={{ ...g.nav, borderRadius: capsule(g.nav.height), backgroundColor: look.bar }} />
              <View style={[fieldStyle(g.toolbarField), { flex: 1 }]} />
            </View>
          )}
          {overlay ? (
            <View pointerEvents="none" style={OVERLAY}>
              {overlay}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}
