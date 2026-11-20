import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const counts = { downloads: 0, empty: 0 };

export function notePageFavicon(uri: string | null, consent?: ConsentToken | null): string | null {
  countFor(consent, () => {
    counts.downloads += 1;
    if (!uri) counts.empty += 1;
  }, { page_favicon_downloads: 1, page_favicon_downloads_empty: uri ? 0 : 1 });
  return uri;
}

export function takePageFaviconCounts() {
  const taken = { page_favicon_downloads: counts.downloads, page_favicon_downloads_empty: counts.empty };
  counts.downloads = 0;
  counts.empty = 0;
  return taken;
}
