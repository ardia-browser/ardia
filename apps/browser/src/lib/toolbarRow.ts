export type ToolbarRow = {
  height: number;
  center: number;
  button: number;
  buttonRadius: number;
  field: number;
  fieldRadius: number;
  fieldButton: number;
  fieldButtonRadius: number;
  extensionButton: number;
};

export const TOOLBAR_ROWS: Record<"regular" | "compact", ToolbarRow> = {
  regular: { height: 41, center: 21.2, button: 30, buttonRadius: 7, field: 30, fieldRadius: 8, fieldButton: 24, fieldButtonRadius: 5, extensionButton: 28 },
  compact: { height: 28, center: 14, button: 22, buttonRadius: 4, field: 22, fieldRadius: 4, fieldButton: 18, fieldButtonRadius: 2, extensionButton: 22 },
};

export const toolbarRowOf = (compact: boolean): ToolbarRow => (compact ? TOOLBAR_ROWS.compact : TOOLBAR_ROWS.regular);

export const urlFieldOf = (row: ToolbarRow) => ({ top: row.center - row.field / 2, height: row.field });

export const compactLift = (row: ToolbarRow) => Math.round((TOOLBAR_ROWS.regular.center - row.center) * 2) / 2;

export const TOOLBAR_TRAILING = { itemGap: 2, extensionIcon: 16, splitGlyph: 15 } as const;

export const fieldInsetOf = (row: ToolbarRow) => urlFieldOf(row).top;

export const fieldAloneInsetOf = (row: ToolbarRow, cardRadius: number) => {
  const top = fieldInsetOf(row);
  return top + row.fieldRadius >= cardRadius ? top : cardRadius - row.fieldRadius;
};

export function toolbarTrailing(row: ToolbarRow, o: { pinnedWidth: number; split: boolean; cardRadius?: number }) {
  const iconInset = (row.extensionButton - TOOLBAR_TRAILING.extensionIcon) / 2;
  const inkGap = TOOLBAR_TRAILING.itemGap + 2 * iconInset;
  const splitInset = (row.button - TOOLBAR_TRAILING.splitGlyph) / 2;
  const splitRight = inkGap - splitInset;
  const splitWidth = 2 * row.button;
  const splitInk = o.split ? splitRight + splitWidth - splitInset : 0;
  const nextInk = splitInk + inkGap;
  const splitLeft = o.split ? splitRight + splitWidth : 0;
  const extensionsRight = Math.max(splitLeft, nextInk - iconInset);
  const fieldRight = o.pinnedWidth ? extensionsRight + o.pinnedWidth + inkGap - iconInset : o.split ? nextInk : fieldAloneInsetOf(row, o.cardRadius ?? 0);
  return { fieldRight, extensionsRight, splitRight, inkGap };
}
