import { useMemo } from "react";
import { legibleInk } from "../../lib/color";
import { useIncreasedContrast } from "./contrast";
import { useTheme } from "./theme";
import { syncInk } from "./tokens";

export function useWarningInk(): string {
  const theme = useTheme();
  const increased = useIncreasedContrast();
  return useMemo(() => legibleInk(syncInk.banner, theme.dark, increased), [theme.dark, increased]);
}
