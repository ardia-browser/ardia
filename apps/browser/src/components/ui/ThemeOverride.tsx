import { use, type ReactNode } from "react";
import { PageThemeContext, ThemeContext, type Theme } from "./theme";

export function ThemeOverride({ theme, children }: { theme: Theme; children: ReactNode }) {
  const Scope = use(PageThemeContext) ? PageThemeContext : ThemeContext;
  return <Scope.Provider value={theme}>{children}</Scope.Provider>;
}
