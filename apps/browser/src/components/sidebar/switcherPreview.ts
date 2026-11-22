import { isHexColor, isLight } from "../../lib/color";

type PreviewColors = { blankFill: string; onPage: string; onDark: string };

export function previewBackdrop(themeColor: string | null | undefined, colors: PreviewColors) {
  const fill = themeColor && isHexColor(themeColor) ? themeColor.trim().slice(0, 7) : colors.blankFill;
  return { fill, icon: isLight(fill) ? colors.onPage : colors.onDark };
}
