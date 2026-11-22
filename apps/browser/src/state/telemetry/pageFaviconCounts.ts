import type { ConsentToken } from "./choice";
import { warnFor } from "./consoleConsent";
import { consentOrNow, countFor } from "./countFor";
import { t } from "../../lib/uiLanguage";


const counts = { downloads: 0, empty: 0 };

export function notePageFavicon(uri: string | null, consent?: ConsentToken | null): string | null {
  countFor(consentOrNow(consent), () => {
    counts.downloads += 1;
    if (!uri) counts.empty += 1;
  });
  return uri;
}

export function notePageFaviconFailed(error: unknown, consent?: ConsentToken | null): null {
  const token = consentOrNow(consent);
  warnFor(token, t(`[favicons] page download failed`), error);
  notePageFavicon(null, token);
  return null;
}

export function takePageFaviconCounts() {
  const taken = { page_favicon_downloads: counts.downloads, page_favicon_downloads_empty: counts.empty };
  counts.downloads = 0;
  counts.empty = 0;
  return taken;
}
