export const listRowLayout = {
  icon: 20,
  iconScaleCap: 2,
  symbolShare: 0.8,
  gap: 12,
  lineGap: 2,
  titleLines: 1,
  largeTextTitleLines: 3,
  largeTextScale: 1.35,
  narrowTitleWidth: 240,
  narrowTitleLines: 2,
  subtitleLines: 1,
} as const;

export const listSheetInsets = {
  archive: { top: 5, bottom: 5, leading: 14, trailing: 14 },
} as const;

export const libraryLayout = {
  page: 16,
  tight: 8,
  rowPadding: 12,
  folderPadding: 12,
  headerTop: 24,
  deviceGlyph: 13,
  deviceGap: 4,
  switcherSegment: 40,
  drawnSwitcherHeight: 32,
  drawnSwitcherSegment: 48,
  drawnSectionGlyph: 17,
} as const;

export const listRowIconSide = (fontScale: number) => listRowLayout.icon * Math.min(fontScale, listRowLayout.iconScaleCap);

export type ListRowTitleSpace = { fontScale: number; titleWidth: number | null };

export const listRowTitleLines = ({ fontScale, titleWidth }: ListRowTitleSpace) => {
  if (fontScale >= listRowLayout.largeTextScale) return listRowLayout.largeTextTitleLines;
  if (titleWidth !== null && titleWidth < listRowLayout.narrowTitleWidth * fontScale) return listRowLayout.narrowTitleLines;
  return listRowLayout.titleLines;
};
