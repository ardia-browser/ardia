import { Symbol } from "./Symbol";
import { SystemGlyph } from "./SystemGlyph";
import { iconRoles } from "./iconRoles";
import { barGlyphLayout } from "./tokens";

export function BarPlusGlyph({ color, testID }: { color: string; testID?: string }) {
  const { pointSize, weight, side } = barGlyphLayout.plus;
  return <SystemGlyph testID={testID} systemName="plus" pointSize={pointSize} weight={weight} name={iconRoles.newTab} size={side} color={color} />;
}

export function TextSizeGlyph({ size, color }: { size: number; color: string }) {
  return <Symbol name={iconRoles.textSize} size={size} color={color} />;
}
