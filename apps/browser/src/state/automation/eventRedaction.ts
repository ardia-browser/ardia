import { minimizedUrl } from "../../lib/urlParts";

export function redactedEventData(data: Record<string, unknown>): Record<string, unknown> {
  let shown = data;
  if (typeof data.url === "string") shown = { ...shown, url: minimizedUrl(data.url) };
  if (Array.isArray(data.urls)) shown = { ...shown, urls: data.urls.map((u: unknown) => (typeof u === "string" ? minimizedUrl(u) : u)) };
  return shown;
}
