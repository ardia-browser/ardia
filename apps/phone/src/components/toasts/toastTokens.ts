import type { ToastFileKind } from "../../lib/fileKinds.ts";

export { fileExtension, fileKindOf, fileTileLabel, type ToastFileKind } from "../../lib/fileKinds.ts";

export const toastGesture = { materialElevation: 8 } as const;

export const toastTileInk = {
  file: { pdf: "#C62828", archive: "#636366", image: "#1E7B44", video: "#6A3FB5", audio: "#B0306A", package: "#1A7F37", document: "#1F5FBF", other: "#5A5A60" } as Record<ToastFileKind, string>,
  fileLabel: "#FFFFFF",
  warning: "#FFB224",
  warningGlyph: "#1C1C1E",
  count: "#1E7B44",
  neutral: { light: "rgba(0,0,0,0.07)", dark: "rgba(255,255,255,0.14)" },
  countLabel: "#FFFFFF",
} as const;
