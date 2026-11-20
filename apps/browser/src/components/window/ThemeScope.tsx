import { useMemo, type ReactNode } from "react";
import { spaceLookSource } from "../../lib/profileLook";
import { useGlassSettings, useScopedLook } from "../../state/app/theme";
import { isIncognitoSpace } from "../../state/browser/model";
import { useProfileLook } from "../../state/spaces/hooks";
import { GlassLookContext, liquidGlass } from "../ui/Glass";
import { ToolbarRowContext } from "../ui/toolbarRowContext";
import { useToolbarRow } from "../toolbar/useToolbarRow";
import { PageThemeContext, scopedTheme, ThemeContext, type Theme } from "../ui/theme";

export function ThemeScope({ page = false, children }: { page?: boolean; children: ReactNode }) {
  const Scope = page ? PageThemeContext : ThemeContext;
  const theme = useScopedLook(scopedTheme);
  const { glass, tint } = useGlassSettings();
  const look = useMemo(() => ({ controls: liquidGlass && glass, panes: liquidGlass && glass, tint }), [glass, tint]);
  const row = useToolbarRow();
  return (
    <Scope.Provider value={theme}>
      <GlassLookContext.Provider value={look}>
        <ToolbarRowContext.Provider value={row}>{children}</ToolbarRowContext.Provider>
      </GlassLookContext.Provider>
    </Scope.Provider>
  );
}

export function useSpaceTheme(spaceId: string): Theme {
  return useProfileLook(spaceId, (space, appDark, settings, palette) => scopedTheme(isIncognitoSpace(spaceId), space, appDark, spaceLookSource(settings), palette));
}
