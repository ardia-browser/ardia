import { controlSize, shape, space, stroke, type ColorRoles } from "../ui";

export const pageMenuInkFrom = (roles: Pick<ColorRoles, "groupedBackground" | "groupedCell" | "rowPressed" | "separator" | "tertiaryFill">) => ({
  solid: roles.groupedBackground,
  cell: roles.groupedCell,
  rowPressed: roles.rowPressed,
  separator: roles.separator,
  stepper: roles.tertiaryFill,
});

export const pageMenuCards = {
  padding: space.m,
  sectionGap: space.l,
  groupRadius: shape.card,
  navigationRadius: shape.card,
  stepperRadius: shape.control,
  barHeight: 46,
  barButton: controlSize.hitTarget,
  barGlyph: 19,
  tileRadius: 18,
  tileGap: 10,
  tileGlyph: 32,
  tileLabelGap: 6,
  captionLines: 2,
  feedbackLines: 2,
  captionAdvance: 0.55,
  largeTextTileHeight: 64,
  rowHeight: 52,
  rowGlyph: 22,
  iconSlot: 30,
  rowInset: space.l,
  iconGap: 14,
  divider: stroke.hairline,
  stepperHeight: 32,
  stepperButton: controlSize.hitTarget,
  stepperGlyph: 16,
  stepperReset: 52,
  sendChevron: 14,
  sendMenuWidth: 250,
} as const;

export const classicPageMenu = { rowGlyph: 20, zoomGlyph: 16 } as const;
