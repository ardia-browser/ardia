export type PopupFeatures = { x?: number; y?: number; width?: number; height?: number };
import type { Rect4 } from "@ardia/shell";


export const POPUP_CAPTION_HEIGHT = 32;
export const POPUP_ORIGIN_STRIP_HEIGHT = 28;
export const POPUP_CHROME_HEIGHT = POPUP_CAPTION_HEIGHT + POPUP_ORIGIN_STRIP_HEIGHT;
const POPUP_DEFAULT_PAGE = { width: 500, height: 600 } as const;
export const POPUP_MIN_PAGE = { width: 200, height: 150 } as const;
const POPUP_BELOW_OPENER_TOP = 60;

const FIELDS = ["x", "y", "width", "height"] as const;

export function popupFeatures(value: unknown): PopupFeatures | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const features: PopupFeatures = {};
  for (const field of FIELDS) {
    const number = (value as Record<string, unknown>)[field];
    if (typeof number === "number" && Number.isFinite(number)) features[field] = number;
  }
  return features;
}

export function popupSize(features: PopupFeatures): [width: number, height: number] {
  const width = Math.max(features.width ?? POPUP_DEFAULT_PAGE.width, POPUP_MIN_PAGE.width);
  const page = Math.max(features.height ?? POPUP_DEFAULT_PAGE.height, POPUP_MIN_PAGE.height);
  return [Math.round(width), Math.round(page + POPUP_CHROME_HEIGHT)];
}

export function popupFrame(features: PopupFeatures, opener: Rect4 | null): Rect4 | null {
  const [width, height] = popupSize(features);
  if (!opener && features.x === undefined && features.y === undefined) return null;
  const centred = opener ? opener[0] + (opener[2] - width) / 2 : 0;
  const belowTop = opener ? opener[1] + POPUP_BELOW_OPENER_TOP : 0;
  return [Math.round(features.x ?? centred), Math.round(features.y ?? belowTop), width, height];
}

export function popupOriginText(url: string): string {
  if (!url) return "about:blank";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const colon = url.indexOf(":");
    return colon < 0 ? url : url.slice(0, colon + 1);
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "blob" || scheme === "filesystem") {
    const inner = popupInnerOrigin(parsed.pathname);
    return `${scheme}:${inner}`;
  }
  if (parsed.host) {
    const host = parsed.host.toLowerCase();
    return scheme === "https" ? host : `${scheme}://${host}`;
  }
  if (scheme === "about") return `about:${parsed.pathname}`;
  if (scheme === "file") return `file://${parsed.pathname}`;
  return `${scheme}:`;
}

function popupInnerOrigin(path: string): string {
  try {
    const inner = new URL(path);
    return inner.host ? `${inner.protocol.slice(0, -1).toLowerCase()}://${inner.host.toLowerCase()}` : "";
  } catch {
    return "";
  }
}

export type PopupSecurity = "secure" | "notSecure" | "certificateError" | "unknown" | "local";

export function popupSecurity(url: string, level: string | null): PopupSecurity {
  let scheme = "";
  try {
    scheme = new URL(url).protocol.slice(0, -1).toLowerCase();
  } catch {
    scheme = "";
  }
  const seen = level ?? (scheme === "http" || scheme === "ws" ? "insecure" : "none");
  if (seen === "secure") return "secure";
  if (seen === "certificateError") return "certificateError";
  if (seen === "insecure" || seen === "mixed") return "notSecure";
  return scheme === "https" || scheme === "wss" ? "unknown" : "local";
}

export function popupTitle(title: string, url: string): string {
  return title && title !== url ? title : popupOriginText(url);
}
