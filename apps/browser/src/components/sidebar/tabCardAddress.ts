import { displayHost, displayUrl, hostOf } from "@ardia/core";

export function tabCardAddress(url: string, fullUrl: boolean): string {
  if (!url) return "";
  if (fullUrl) return displayUrl(url);
  const host = hostOf(url);
  return host ? displayHost(host) : displayUrl(url);
}
