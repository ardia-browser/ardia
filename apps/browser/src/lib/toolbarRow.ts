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

export const EXTENSION_GAP = 2;
const EXTENSIONS_INSET = 6;
export const MIN_URL_FIELD = 120;

export const extensionsWidthOf = (count: number, button: number) => (count ? count * (button + EXTENSION_GAP) - EXTENSION_GAP + EXTENSIONS_INSET : 0);

export const urlFieldRight = (inSplit: boolean, extensionsWidth: number, row: ToolbarRow) => (inSplit ? 12 + 2 * (row.button - 2) : 12) + extensionsWidth;

type SplitPane = { width: number; urlLeft: number; trailing: number; row: ToolbarRow };

export const splitFieldWidth = ({ width, urlLeft, trailing, row }: SplitPane, extensionsWidth: number) => width - urlLeft - urlFieldRight(true, extensionsWidth, row) - trailing;

export function splitExtensionsLimit(pane: SplitPane) {
  const room = splitFieldWidth(pane, 0) - MIN_URL_FIELD;
  return Math.max(1, Math.floor((room - EXTENSIONS_INSET + EXTENSION_GAP) / (pane.row.extensionButton + EXTENSION_GAP)));
}
