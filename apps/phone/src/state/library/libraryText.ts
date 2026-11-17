export type FileKind = "image" | "video" | "audio" | "pdf" | "archive" | "document";

export const FILE_SYMBOLS: Record<FileKind, string> = { image: "photo", video: "film", audio: "waveform", pdf: "doc.richtext", archive: "doc.zipper", document: "doc" };

const UNITS = [
  { name: "KB", size: 1e3, digits: 0 },
  { name: "MB", size: 1e6, digits: 1 },
  { name: "GB", size: 1e9, digits: 2 },
  { name: "TB", size: 1e12, digits: 2 },
] as const;

export function fileSizeText(bytes: number): string {
  if (bytes <= 0) return "Zero KB";
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  let unit: (typeof UNITS)[number] = UNITS[0];
  for (const next of UNITS) if (bytes >= next.size) unit = next;
  const value = bytes / unit.size;
  const shown = Number(value.toFixed(unit.digits));
  return `${shown.toLocaleString("en-US", { maximumFractionDigits: unit.digits })} ${unit.name}`;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(locale?: string): Intl.DateTimeFormat {
  const key = locale ?? "";
  let format = clockFormats.get(key);
  if (!format) clockFormats.set(key, (format = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })));
  return format;
}

export const clockTime = (at: number, locale?: string) => clockFormat(locale).format(at);

export const abbreviatedDateTime = (at: number, locale?: string) => `${new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })} at ${clockTime(at, locale)}`;

export const downloadSubtitle = (size: number, modified: number, locale?: string) => `${fileSizeText(size)} · ${abbreviatedDateTime(modified, locale)}`;
