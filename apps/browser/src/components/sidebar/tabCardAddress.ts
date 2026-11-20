import { displayHost, displayUrl, hostOf } from "@ardia/core";
import { filePathLabel, isLocalFileUrl } from "../../lib/url";

export function tabCardAddress(url: string, fullUrl: boolean): string {
  if (!url) return "";
  if (isLocalFileUrl(url)) return filePathLabel(url);
  if (fullUrl) return displayUrl(url);
  const host = hostOf(url);
  return host ? displayHost(host) : displayUrl(url);
}
