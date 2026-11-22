import { trayMaxHeight } from "../../lib/trayMotion";
import { browseLayout, capsule, controlSize, floatingBarLayout, floatingPanelLayout, font, glyphSlot, space, stroke } from "../ui/tokens";

export const searchPanel = {
  fieldHeight: browseLayout.searchFieldHeight,
  accessorySlot: controlSize.hitTarget,
  fieldInset: space.l,
  fieldLeading: space.xl,
  fieldTrailing: space.s,
  fieldEdge: stroke.chrome,
  maxTextScale: floatingBarLayout.maxTextScale,
  rowsTop: 5,
  rowPitch: 51,
  rowsShown: 4,
  bottom: space.s,
  rowInset: 6,
  rowLeading: 10,
  rowTrailing: 10,
  iconSlot: glyphSlot.field,
  iconGap: 9,
  glyph: 19,
  trailingGlyph: 15,
  titleSize: font.body.fontSize,
  detailSize: font.subheadline.fontSize,
  captionSize: font.callout.fontSize,
  incognitoLabel: font.footnote.fontSize,
  eyes: 26,
  eyesGap: 5,
  gapAboveNewTab: 28,
  light: { tint: "rgba(255,255,255,0.62)", solid: "#F2F2F4", field: "rgba(118,118,128,0.17)", fieldEdge: "rgba(0,0,0,0.07)" },
  dark: { tint: "rgba(30,30,32,0.6)", solid: "#1C1C1E", field: "rgba(118,118,128,0.3)", fieldEdge: "rgba(255,255,255,0.05)" },
  incognito: { tint: "rgba(14,14,16,0.86)", solid: "#121214", field: "rgba(118,118,128,0.28)", fieldEdge: "rgba(255,255,255,0.05)", caption: "rgba(235,235,245,0.5)", label: "rgba(235,235,245,0.55)" },
} as const;

export const searchFieldScale = (fontScale: number) => Math.min(Math.max(fontScale, 1), searchPanel.maxTextScale);

export const searchFieldHeight = (fontScale: number) => Math.max(searchPanel.fieldHeight * searchFieldScale(fontScale), searchPanel.accessorySlot + searchPanel.fieldEdge * 2);

export const searchFieldInnerHeight = (fieldHeight: number) => fieldHeight - searchPanel.fieldEdge * 2;

export const searchFieldRadius = (fieldHeight: number) => capsule(fieldHeight);

export const searchPanelRadius = (fieldHeight: number) => searchFieldRadius(fieldHeight) + searchPanel.fieldInset;

export const searchPanelHeight = (fieldHeight: number, fontScale: number) => searchPanel.fieldInset + fieldHeight + searchPanel.rowsTop + searchPanel.rowsShown * searchPanel.rowPitch * fontScale + searchPanel.bottom;

export const searchPanelFieldBlock = (fieldHeight: number) => searchPanel.fieldInset + fieldHeight + searchPanel.rowsTop;

export const searchPanelFieldCenter = (fieldHeight: number) => searchPanel.fieldInset + fieldHeight / 2;

export const searchPanelInk = (incognito: boolean, dark: boolean) => (incognito ? searchPanel.incognito : dark ? searchPanel.dark : searchPanel.light);

export type SearchPanelPlacement = "underKeyboard" | "aboveKeyboard" | "commandBar";

export const searchPanelPlacement = (arcPanel: boolean, commandBar: boolean): SearchPanelPlacement => (commandBar ? "commandBar" : arcPanel ? "underKeyboard" : "aboveKeyboard");

export type SearchPanelCorners = "top" | "all";

export type SearchPanelPlace = { corners: SearchPanelCorners; cardInset: number; cardGap: number; fieldInset: number; fieldTop: number; gapAbove: number; gapAboveKeyboard: number; underKeyboard: number };

export function searchPanelPlace(placement: SearchPanelPlacement, resting: number, hinged: boolean): SearchPanelPlace {
  const field = { fieldInset: searchPanel.fieldInset, fieldTop: searchPanel.fieldInset };
  if (placement === "underKeyboard") return { ...field, corners: "top", cardInset: hinged ? floatingPanelLayout.inset : 0, cardGap: 0, gapAbove: searchPanel.gapAboveNewTab, gapAboveKeyboard: 0, underKeyboard: resting };
  return { ...field, corners: "all", cardInset: floatingPanelLayout.inset, cardGap: floatingPanelLayout.aboveKeyboard, gapAbove: 0, gapAboveKeyboard: space.s + floatingPanelLayout.aboveKeyboard, underKeyboard: 0 };
}

export const searchPanelPreferredHeight = (placement: SearchPanelPlacement, fieldHeight: number, fontScale: number, rowsHeight: number) =>
  placement === "underKeyboard" ? searchPanelHeight(fieldHeight, fontScale) : Math.min(searchPanelHeight(fieldHeight, fontScale), searchPanelFieldBlock(fieldHeight) + rowsHeight);

export type SearchTrayHeightInput = { commandBarMaxHeight: number | null; placement: SearchPanelPlacement; place: SearchPanelPlace; fieldHeight: number; fontScale: number; rowsHeight: number; windowHeight: number; safeTop: number; resting: number };

export const searchTrayHeight = ({ commandBarMaxHeight, placement, place, fieldHeight, fontScale, rowsHeight, windowHeight, safeTop, resting }: SearchTrayHeightInput) =>
  commandBarMaxHeight ?? trayMaxHeight(searchPanelPreferredHeight(placement, fieldHeight, fontScale, rowsHeight), windowHeight - safeTop - place.gapAbove, resting, place.gapAboveKeyboard);
