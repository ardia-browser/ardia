import { duration } from "../ui/motion";
import { useTheme, type Theme } from "../ui/theme";
import { parseColor } from "../../lib/color";

const rgbOf = (color: string) => parseColor(color).slice(0, 3) as [number, number, number];

const light = {
  track: "rgba(0,0,0,0.1)",
  fill: "rgba(0,0,0,0.35)",
  hoverFill: "rgba(0,0,0,0.6)",
  iconTile: "rgba(0,0,0,0.05)",
  pickerSelected: "rgba(0,0,0,0.08)",
  previewBorder: "rgba(0,0,0,0.12)",
  previewFill: "rgba(0,0,0,0.03)",
};

const dark: typeof light = {
  track: "rgba(255,255,255,0.2)",
  fill: "rgba(255,255,255,0.5)",
  hoverFill: "rgba(255,255,255,0.8)",
  iconTile: "rgba(255,255,255,0.08)",
  pickerSelected: "rgba(255,255,255,0.14)",
  previewBorder: "rgba(255,255,255,0.15)",
  previewFill: "rgba(255,255,255,0.05)",
};

export type MediaTokens = typeof light & { background: string; backgroundRgb: [number, number, number]; label: string; secondary: string; glyph: string; artPlaceholder: string };

const byTheme = new WeakMap<Theme, MediaTokens>();

export function useMediaTokens(): MediaTokens {
  const theme = useTheme();
  let tokens = byTheme.get(theme);
  if (!tokens)
    byTheme.set(
      theme,
      (tokens = { ...(theme.dark ? dark : light), background: theme.panel, backgroundRgb: rgbOf(theme.panel), label: theme.textPrimary, secondary: theme.textSecondary, glyph: theme.icon, artPlaceholder: theme.promptFill }),
    );
  return tokens;
}

export const CAPTURE_DOT_RIM = "rgba(0,0,0,0.25)";
export const ART_HOVER_SCRIM = "rgba(0,0,0,0.5)";

export const fadeStepColor = ([r, g, b]: [number, number, number], alpha: number) => `rgba(${r},${g},${b},${alpha})`;

export const mediaMotion = { shareBarSlide: duration.base, marqueePause: 1500, marqueeSpeed: 30 } as const;
