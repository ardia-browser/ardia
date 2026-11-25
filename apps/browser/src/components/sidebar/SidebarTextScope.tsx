import type { ReactNode } from "react";
import { TextScopeContext } from "../ui";
import { contrastTheme, tintTheme, useTheme, type Theme } from "../ui/theme";
import { themeOverride } from "../ui/ThemeOverride";
import { useSidebarHighContrast } from "../../state/sidebar/textLook";

export function sidebarText(theme: Theme, strong: boolean, children: ReactNode) {
  return themeOverride(strong ? contrastTheme(theme) : theme, <TextScopeContext.Provider value="sidebar">{children}</TextScopeContext.Provider>);
}

export function SidebarTextScope({ children }: { children: ReactNode }) {
  return sidebarText(useTheme(), useSidebarHighContrast(), children);
}

export function SidebarInk({ children }: { children: ReactNode }) {
  return sidebarText(tintTheme(useTheme()), useSidebarHighContrast(), children);
}
