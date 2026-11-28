export type ToastFileKind = "pdf" | "archive" | "image" | "video" | "audio" | "package" | "document" | "other";

const KIND_BY_EXTENSION: Record<string, ToastFileKind> = {
  pdf: "pdf",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  bz2: "archive",
  xz: "archive",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  bmp: "image",
  svg: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  m4v: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  aac: "audio",
  opus: "audio",
  apk: "package",
  apks: "package",
  xapk: "package",
  ipa: "package",
  doc: "document",
  docx: "document",
  txt: "document",
  rtf: "document",
  md: "document",
  csv: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  pages: "document",
  numbers: "document",
  key: "document",
  odt: "document",
  epub: "document",
  json: "document",
  html: "document",
};

export const TOAST_TILE_LABELS: Record<Exclude<ToastFileKind, "other">, string> = { pdf: "PDF", archive: "ZIP", image: "IMG", video: "VID", audio: "AUD", package: "APK", document: "DOC" };

export function fileExtension(fileName: string): string {
  const name = fileName.trim();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export const fileKindOf = (ext: string): ToastFileKind => KIND_BY_EXTENSION[ext.toLowerCase()] ?? "other";

export function fileTileLabel(ext: string): string {
  const kind = fileKindOf(ext);
  if (kind === "package") return ext.toUpperCase().slice(0, 4);
  if (kind !== "other") return TOAST_TILE_LABELS[kind];
  const shown = ext.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return shown.length > 0 && shown.length <= 4 ? shown : "FILE";
}
