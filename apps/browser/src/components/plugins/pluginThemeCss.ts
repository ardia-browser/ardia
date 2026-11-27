import { useMemo } from "react";
import { activeLook } from "../../lib/activeLook";
import type { ThemeLook } from "../../lib/themeLook";
import { useBasePalette } from "../../state/config/basePalette";
import { buildPluginThemeCss } from "../../lib/pluginThemeCss";
import { useTheme } from "../ui";
import { opaqueCard } from "../ui/opaqueCard";
import { font, radius, webGlass, weight } from "../ui/tokens";

const px = (value: number) => `${value}px`;

function lookRoles(look: ThemeLook, dark: boolean, windowTint: readonly [string, string]) {
  const mode = dark ? "dark" : "light";
  return {
    ...(look.family ? { font: look.family } : {}),
    fontMono: look.mono,
    glassBlur: px(webGlass.blur),
    glassSaturation: webGlass.saturation,
    glassRim: webGlass.rim[mode],
    glassPanel: webGlass.panel[mode],
    glassPanelEdge: webGlass.panelEdge[mode],
    windowTintTop: windowTint[0],
    windowTintBottom: windowTint[1],
    radiusControl: px(radius.control),
    radiusToolbar: px(radius.toolbar),
    radiusTile: px(radius.tile),
    radiusRow: px(radius.chrome),
    radiusPanel: px(radius.panel),
    radiusSheet: px(radius.sheet),
    radiusHero: px(radius.hero),
    textCaption: px(font.caption.fontSize),
    textSmall: px(font.small.fontSize),
    textBody: px(font.body.fontSize),
    textTitle: px(font.title.fontSize),
    textLarge: px(font.large.fontSize),
    weightMedium: weight.medium,
    weightSemibold: weight.semibold,
  };
}

export function usePluginThemeCss(): string {
  const theme = useTheme();
  const look = useBasePalette((s) => s.look) ?? activeLook();
  return useMemo(
    () => buildPluginThemeCss({ scheme: theme.dark ? "dark" : "light", roles: { ...theme, ...lookRoles(look, theme.dark, theme.windowTint), background: theme.card, backgroundSolid: opaqueCard(theme), text: theme.textPrimary } }),
    [theme, look],
  );
}
