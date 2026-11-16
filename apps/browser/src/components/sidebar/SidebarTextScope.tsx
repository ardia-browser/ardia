import type { ReactNode } from "react";
import { TextScopeContext } from "../ui";
import { contrastTheme, useTheme } from "../ui/theme";
import { ThemeOverride } from "../ui/ThemeOverride";
import { useSidebarHighContrast } from "../../state/sidebar/textLook";

export function SidebarTextScope({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const strong = useSidebarHighContrast();
  return (
    <ThemeOverride theme={strong ? contrastTheme(theme) : theme}>
      <TextScopeContext.Provider value="sidebar">{children}</TextScopeContext.Provider>
    </ThemeOverride>
  );
}
