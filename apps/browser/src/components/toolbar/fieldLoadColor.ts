import { PROFILE_COLORS, type Theme } from "../ui/theme";

export function fieldLoadColor(theme: Pick<Theme, "profileColor" | "custom" | "powerUpColor" | "accent">): string {
  if (theme.custom && theme.powerUpColor) return theme.powerUpColor;
  return theme.profileColor === "incognito" ? theme.accent : PROFILE_COLORS[theme.profileColor].swatch;
}
