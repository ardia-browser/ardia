import type { TextStyle } from "react-native";
import { Easing as WorkletEasing, withTiming, type AnimationCallback } from "react-native-reanimated";
import type { MotionCurve } from "@ardia/phone-native";

type TypeRole = Pick<TextStyle, "fontSize" | "lineHeight" | "fontWeight" | "letterSpacing">;

export const materialType = {
  displayLarge: { fontSize: 57, lineHeight: 64, fontWeight: "400", letterSpacing: -0.25 },
  displayMedium: { fontSize: 45, lineHeight: 52, fontWeight: "400", letterSpacing: 0 },
  displaySmall: { fontSize: 36, lineHeight: 44, fontWeight: "400", letterSpacing: 0 },
  headlineLarge: { fontSize: 32, lineHeight: 40, fontWeight: "400", letterSpacing: 0 },
  headlineMedium: { fontSize: 28, lineHeight: 36, fontWeight: "400", letterSpacing: 0 },
  headlineSmall: { fontSize: 24, lineHeight: 32, fontWeight: "400", letterSpacing: 0 },
  titleLarge: { fontSize: 22, lineHeight: 28, fontWeight: "400", letterSpacing: 0 },
  titleMedium: { fontSize: 16, lineHeight: 24, fontWeight: "500", letterSpacing: 0.15 },
  titleSmall: { fontSize: 14, lineHeight: 20, fontWeight: "500", letterSpacing: 0.1 },
  bodyLarge: { fontSize: 16, lineHeight: 24, fontWeight: "400", letterSpacing: 0.5 },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontWeight: "400", letterSpacing: 0.25 },
  bodySmall: { fontSize: 12, lineHeight: 16, fontWeight: "400", letterSpacing: 0.4 },
  labelLarge: { fontSize: 14, lineHeight: 20, fontWeight: "500", letterSpacing: 0.1 },
  labelMedium: { fontSize: 12, lineHeight: 16, fontWeight: "500", letterSpacing: 0.5 },
  labelSmall: { fontSize: 11, lineHeight: 16, fontWeight: "500", letterSpacing: 0.5 },
} as const satisfies Record<string, TypeRole>;

export const materialShape = { none: 0, extraSmall: 4, small: 8, medium: 12, large: 16, largeIncreased: 20, extraLarge: 28, full: 9999 } as const;

export const MATERIAL_SEGMENT_GAP = 2;

export const materialBottomBar = { height: 64, field: 48, inset: 8, pad: 8, edge: 16, gap: 4 } as const;

export const materialBarPill = { height: 36, shadowRoom: 12, maxWidth: 240, sideInset: 14, spacing: 8, siteIcon: 16, collapsedScale: 0.62 } as const;

export const materialSegmentCorners = (index: number, count: number) => {
  const top = index === 0 ? materialShape.largeIncreased : materialShape.extraSmall;
  const bottom = index === count - 1 ? materialShape.largeIncreased : materialShape.extraSmall;
  return { borderTopLeftRadius: top, borderTopRightRadius: top, borderBottomLeftRadius: bottom, borderBottomRightRadius: bottom };
};

export const materialSize = {
  touchTarget: 48,
  iconButton: 40,
  icon: 24,
  dragHandle: { width: 32, height: 4, top: 22 },
  sheetMaxWidth: 640,
  listItemOneLine: 56,
  listItemTwoLine: 72,
  listInset: 16,
  listIconGap: 16,
  topAppBar: 64,
  bottomBar: materialBottomBar.height + materialBottomBar.inset * 2,
  fab: 56,
  searchBar: 56,
  badge: 16,
} as const;

type Bezier = [number, number, number, number];

export const materialEasing = {
  emphasized: [0.2, 0, 0, 1],
  emphasizedDecelerate: [0.05, 0.7, 0.1, 1],
  emphasizedAccelerate: [0.3, 0, 0.8, 0.15],
  standard: [0.2, 0, 0, 1],
  standardDecelerate: [0, 0, 0, 1],
  standardAccelerate: [0.3, 0, 1, 1],
} as const satisfies Record<string, Bezier>;

export const materialDuration = {
  short1: 50,
  short2: 100,
  short3: 150,
  short4: 200,
  medium1: 250,
  medium2: 300,
  medium3: 350,
  medium4: 400,
  long1: 450,
  long2: 500,
  long3: 550,
  long4: 600,
} as const;

export type MaterialEasing = keyof typeof materialEasing;

export const materialCurve = (easing: MaterialEasing, durationMs: number): MotionCurve => ({ type: "timing", durationMs, curve: [...materialEasing[easing]] });

export function materialTiming(easing: MaterialEasing, durationMs: number) {
  "worklet";
  const [x1, y1, x2, y2] = materialEasing[easing];
  return { duration: durationMs, easing: WorkletEasing.bezier(x1, y1, x2, y2) };
}

export function materialMove(to: number, easing: MaterialEasing, durationMs: number, done?: AnimationCallback) {
  "worklet";
  return withTiming(to, materialTiming(easing, durationMs), done);
}

export const materialMotion = {
  sheetEnter: { easing: "emphasizedDecelerate", durationMs: materialDuration.medium1 },
  sheetExit: { easing: "emphasizedAccelerate", durationMs: materialDuration.short3 },
  scrimIn: { easing: "standard", durationMs: materialDuration.short4 },
  scrimOut: { easing: "standard", durationMs: materialDuration.short3 },
  fadeThroughOut: { easing: "emphasizedAccelerate", durationMs: materialDuration.short2 },
  fadeThroughIn: { easing: "emphasizedDecelerate", durationMs: materialDuration.short3 },
  containerTransform: { easing: "emphasized", durationMs: materialDuration.medium1 },
  menuEnter: { easing: "emphasizedDecelerate", durationMs: materialDuration.short4 },
  menuExit: { easing: "emphasizedAccelerate", durationMs: materialDuration.short2 },
  dialogEnter: { easing: "emphasizedDecelerate", durationMs: materialDuration.medium1 },
  dialogExit: { easing: "emphasizedAccelerate", durationMs: materialDuration.short3 },
  ripple: { easing: "standard", durationMs: materialDuration.medium1 },
  sharedAxisIn: { easing: "emphasizedDecelerate", durationMs: materialDuration.short4 },
  sharedAxisOut: { easing: "emphasizedAccelerate", durationMs: materialDuration.short2 },
} as const satisfies Record<string, { easing: MaterialEasing; durationMs: number }>;
