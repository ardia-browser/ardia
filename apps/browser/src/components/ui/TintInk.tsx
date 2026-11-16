import type { ReactNode } from "react";
import { tintTheme, useTheme } from "./theme";
import { ThemeOverride } from "./ThemeOverride";

export function TintInk({ children }: { children: ReactNode }) {
  return <ThemeOverride theme={tintTheme(useTheme())}>{children}</ThemeOverride>;
}
