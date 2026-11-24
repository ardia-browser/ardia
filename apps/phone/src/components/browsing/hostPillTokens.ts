import { floatingBarLayout, space } from "../ui";
import { glassFadeMs } from "../ui/motion";

export const hostPillLayout = {
  glassMs: glassFadeMs,
  height: 30,
  maxWidth: 240,
  sideInset: space.m,
  spacing: floatingBarLayout.addressSpacing,
  siteIcon: 13,
  hostText: 13.5,
  hostWeight: "500",
  privateSymbolShare: 28 / 16,
  maxTextScale: floatingBarLayout.maxTextScale,
  collapsedScale: 0.62,
} as const;
