import type { DomainModule, FaviconImage } from "@ardia/ardiacore";

export function downloadFavicon(favicons: Pick<DomainModule, "call">, profile: string, url: string): Promise<FaviconImage | null> {
  return Promise.resolve()
    .then(() => favicons.call("fetch", profile, JSON.stringify({ url })))
    .then((reply) => (JSON.parse(reply) as FaviconImage | null) ?? null);
}
