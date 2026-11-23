import type { ConsentToken } from "./choice";
import { warnFor } from "./consoleConsent";
import { consentOrNow, countFor } from "./countFor";

const counts = { downloads: 0, empty: 0, peeks: 0, peeksFailed: 0 };

export function notePageFavicon(uri: string | null, consent?: ConsentToken | null): string | null {
  countFor(consentOrNow(consent), () => {
    counts.downloads += 1;
    if (!uri) counts.empty += 1;
  });
  return uri;
}

export function notePageFaviconFailed(error: unknown, consent?: ConsentToken | null): null {
  const token = consentOrNow(consent);
  warnFor(token, "[favicons] page download failed", error);
  notePageFavicon(null, token);
  return null;
}

export function notePrivateFaviconPeek(failed: boolean, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => {
    counts.peeks += 1;
    if (failed) counts.peeksFailed += 1;
  });
}

export function takePageFaviconCounts() {
  const taken = {
    page_favicon_downloads: counts.downloads,
    page_favicon_downloads_empty: counts.empty,
    private_favicon_peeks: counts.peeks,
    private_favicon_peeks_failed: counts.peeksFailed,
  };
  counts.downloads = 0;
  counts.empty = 0;
  counts.peeks = 0;
  counts.peeksFailed = 0;
  return taken;
}
