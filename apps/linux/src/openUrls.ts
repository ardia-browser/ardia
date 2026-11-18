import type { ArdiaHost } from "./host";
import { hostSupports, reportHostError } from "./host.ts";

export const OPEN_URLS_LISTEN = "ArdiaShell.listenForOpenURLs";

export function listenForOpenUrls(host: ArdiaHost) {
  if (!hostSupports(OPEN_URLS_LISTEN, host)) return false;
  void Promise.resolve(host.invoke(OPEN_URLS_LISTEN, { args: [] })).catch(reportHostError);
  return true;
}
