import { useMemo } from "react";
import { buildPluginThemeCss } from "../../lib/pluginThemeCss";
import { useTheme } from "../ui";

export function usePluginThemeCss(): string {
  const theme = useTheme();
  return useMemo(() => buildPluginThemeCss({ scheme: theme.dark ? "dark" : "light", roles: { ...theme, background: theme.card, text: theme.textPrimary } }), [theme]);
}
