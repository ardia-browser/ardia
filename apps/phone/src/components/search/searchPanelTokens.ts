export const searchPanel = {
  radius: 20,
  fieldTop: 15,
  fieldSide: 16,
  fieldHeight: 44,
  fieldLeading: 20,
  fieldTrailing: 8,
  fieldEdge: 0.5,
  rowsTop: 5,
  rowPitch: 51,
  rowsShown: 4,
  bottom: 8,
  rowInset: 6,
  rowLeading: 10,
  rowTrailing: 10,
  iconSlot: 20,
  iconGap: 9,
  glyph: 19,
  trailingGlyph: 15,
  trailingHit: 40,
  titleSize: 17,
  detailSize: 15,
  captionSize: 16,
  incognitoLabel: 13,
  eyes: 26,
  eyesGap: 5,
  light: { tint: "rgba(255,255,255,0.62)", solid: "#F2F2F4", field: "rgba(118,118,128,0.17)", fieldEdge: "rgba(0,0,0,0.07)" },
  dark: { tint: "rgba(30,30,32,0.6)", solid: "#1C1C1E", field: "rgba(118,118,128,0.3)", fieldEdge: "rgba(255,255,255,0.05)" },
  incognito: { tint: "rgba(14,14,16,0.86)", solid: "#121214", field: "rgba(118,118,128,0.28)", fieldEdge: "rgba(255,255,255,0.05)", caption: "rgba(235,235,245,0.5)", label: "rgba(235,235,245,0.55)" },
} as const;

export const searchPanelHeight = (fieldHeight: number, fontScale: number) => searchPanel.fieldTop + fieldHeight + searchPanel.rowsTop + searchPanel.rowsShown * searchPanel.rowPitch * fontScale + searchPanel.bottom;

export const searchPanelFieldCenter = (fieldHeight: number) => searchPanel.fieldTop + fieldHeight / 2;

export const searchPanelInk = (incognito: boolean, dark: boolean) => (incognito ? searchPanel.incognito : dark ? searchPanel.dark : searchPanel.light);
