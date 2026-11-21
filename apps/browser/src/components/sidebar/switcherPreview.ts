import { isHexColor, isLight } from "../../lib/color";

export function previewSurface(
  themeColor: string | null | undefined,
  tokens: { blankFill: string; onPage: string; onDark: string },
) {
  const fill = themeColor && isHexColor(themeColor) ? themeColor.slice(0, 7) : tokens.blankFill;
  return { fill, icon: isLight(fill) ? tokens.onPage : tokens.onDark };
}

export function isCardInViewport(index: number, offset: number, viewport: number, card: number, stride: number) {
  const left = index * stride;
  return left + card > offset && left < offset + viewport;
}
