import type { ReactNode } from "react";
import { TextScopeContext } from "../ui";
import { contrastTheme, ThemeContext, useTheme } from "../ui/theme";
import { useSidebarHighContrast } from "../../state/sidebar/textLook";

export function SidebarTextScope({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const strong = useSidebarHighContrast();
  return (
    <ThemeContext.Provider value={strong ? contrastTheme(theme) : theme}>
      <TextScopeContext.Provider value="sidebar">{children}</TextScopeContext.Provider>
    </ThemeContext.Provider>
  );
}
