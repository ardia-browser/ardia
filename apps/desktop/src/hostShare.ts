import { cleanLinkTitle, cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import type { ArdiaHost } from "./host";
import { hostSupports, invokeHost, reportHostError } from "./host.ts";
import { isLinkShareService, MORE_SHARE_SERVICE, setShareServices, shareLinkVia, shareServicesFrom } from "./linkShare.ts";

export const SHARE_VIA = "ArdiaApp.shareVia";
export const SHARE_SERVICES = "ArdiaApp.shareServices";
export const OPEN_SHARING_SETTINGS = "ArdiaApp.openSharingSettings";
export const SHARE_SERVICES_STALL_MS = 5000;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const windowOf = (value: unknown) => (typeof value === "string" ? value : null);

export function shareModuleMethod(host: ArdiaHost, name: string, method: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  if (name !== "ArdiaApp" || method !== "shareVia" || !hostSupports(SHARE_VIA, host)) return undefined;
  return (service, url, title, windowId) => {
    const link = cleanUrl(text(url));
    const named = cleanLinkTitle(text(title), text(url)) || null;
    if (service === MORE_SHARE_SERVICE) return hostSupports(OPEN_SHARING_SETTINGS, host) ? invokeHost(OPEN_SHARING_SETTINGS, { args: [] }, host) : Promise.resolve();
    if (isLinkShareService(service)) return shareLinkVia(service, link, named, windowOf(windowId));
    return invokeHost(SHARE_VIA, { args: [text(service), link, named, windowOf(windowId)] }, host);
  };
}

type Deadline = (expire: () => void, ms: number) => () => void;
const timerDeadline: Deadline = (expire, ms) => {
  const timer = setTimeout(expire, ms);
  return () => clearTimeout(timer);
};

export const isMoreShareChoice = (command: string, arg: string | null | undefined) => command === "share" && arg === `via:${MORE_SHARE_SERVICE}`;

export function openSharingSettings(host: ArdiaHost | undefined): Promise<unknown> {
  return host && hostSupports(OPEN_SHARING_SETTINGS, host) ? invokeHost(OPEN_SHARING_SETTINGS, { args: [] }, host) : Promise.resolve();
}

export function loadShareServices(host: ArdiaHost | undefined, deadline: Deadline = timerDeadline) {
  if (!host || !hostSupports(SHARE_SERVICES, host)) return;
  let latest = 0;
  let loading: { id: number; promise: Promise<void> } | null = null;
  const refresh = (): Promise<void> => {
    if (loading) return loading.promise;
    const id = ++latest;
    let expired = false;
    const cancel = deadline(() => {
      expired = true;
      if (loading?.id === id) loading = null;
    }, SHARE_SERVICES_STALL_MS);
    const promise = invokeHost<unknown>(SHARE_SERVICES, { args: [] }, host)
      .then((listed) => {
        if (id === latest && !expired) setShareServices(shareServicesFrom(listed), refresh);
      })
      .catch(reportHostError)
      .finally(() => {
        cancel();
        if (loading?.id === id) loading = null;
      });
    loading = { id, promise };
    return promise;
  };
  setShareServices([], refresh);
  void refresh();
}
