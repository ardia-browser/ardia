import type { ReactNode } from "react";
import { tintTheme, useTheme } from "./theme";
import { themeOverride } from "./ThemeOverride";

export function TintInk({ children }: { children: ReactNode }) {
  return themeOverride(tintTheme(useTheme()), children);
}
