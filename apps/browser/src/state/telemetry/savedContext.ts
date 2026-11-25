import { isFields } from "../../lib/decode";
import { WEBUI_PAGE_VALUE } from "./sanitize";

export type SavedContext = Record<string, string | number | boolean | null> & { webui_page?: string | null; webui_pages?: string | null };

export type RecentPage = { page: string; at: number };

const RECENT_AT = /^\d{1,15}$/;

export const formatRecentPages = (pages: RecentPage[]) => (pages.length ? pages.map((p) => `${p.page}@${p.at}`).join(",") : null);

export function readRecentPages(value: unknown): RecentPage[] {
  if (typeof value !== "string") return [];
  return value.split(",").slice(0, 3).flatMap((item) => {
    const [page, at, ...rest] = item.split("@");
    return !rest.length && page && WEBUI_PAGE_VALUE.test(page) && at && RECENT_AT.test(at) ? [{ page, at: Number(at) }] : [];
  });
}

export function readContext(value: unknown): SavedContext | null {
  if (!isFields(value) || typeof value.at !== "number") return null;
  const out: SavedContext = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "webui_page") out[key] = typeof v === "string" && WEBUI_PAGE_VALUE.test(v) ? v : null;
    else if (key === "webui_pages") out[key] = formatRecentPages(readRecentPages(v));
    else if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) out[key] = v;
  }
  return out;
}
