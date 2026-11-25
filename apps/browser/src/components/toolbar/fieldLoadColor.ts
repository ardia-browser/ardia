import { PROFILE_COLORS, type Theme } from "../ui/theme";

export function fieldLoadColor(theme: Pick<Theme, "spaceColor" | "custom" | "powerUpColor" | "accent">): string {
  if (theme.custom && theme.powerUpColor) return theme.powerUpColor;
  return theme.spaceColor === "incognito" ? theme.accent : PROFILE_COLORS[theme.spaceColor].swatch;
}
