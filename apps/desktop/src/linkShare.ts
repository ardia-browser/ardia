import type { CleanedTitle, CleanedUrl } from "@ardia/core";
import type { MenuItem } from "@ardia-real/shell";

export type ShareAnchor = readonly [number, number, number, number];
type ShareSurface = {
  menu(items: MenuItem[], at?: { x: number; y: number }): Promise<string | null>;
  copy(text: string): void;
  openInActivePage(url: string, windowId: string | null): boolean;
};

export type ShareService = { title: string; menuTitle: string };

const COPY = "copy";
const EMAIL = "email";
const SHARE_SERVICE = ":via:";
export const MORE_SHARE_SERVICE = "ardia.more";
const MAX_SERVICES = 64;
const MAX_SERVICE_BYTES = 200;

let surface: ShareSurface | null = null;
export const setShareSurface = (next: ShareSurface | null) => void (surface = next);

let services: readonly ShareService[] = [];
type ServicesRefresh = () => Promise<void> | void;

let refreshServices: ServicesRefresh | null = null;
export const SHARE_SERVICES_WAIT_MS = 250;
const serviceName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_SERVICE_BYTES && !/[\u0000-\u001f\u007f]/.test(value);
export const shareServicesFrom = (value: unknown): ShareService[] => {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const title = entry && typeof entry === "object" ? (entry as Record<string, unknown>).title : undefined;
    const menuTitle = entry && typeof entry === "object" ? (entry as Record<string, unknown>).menuTitle : undefined;
    if (!serviceName(title) || title === COPY || title === EMAIL || title === MORE_SHARE_SERVICE || seen.has(title)) return [];
    seen.add(title);
    return [{ title, menuTitle: serviceName(menuTitle) ? menuTitle : title }];
  }).slice(0, MAX_SERVICES);
};
export const setShareServices = (next: readonly ShareService[], refresh: ServicesRefresh | null = refreshServices) => {
  services = next;
  refreshServices = refresh;
};
export const shareServices = (): readonly ShareService[] => services;
export const shareServicesListed = () => refreshServices !== null;
export const refreshShareServices = async (waitMs = SHARE_SERVICES_WAIT_MS): Promise<void> => {
  if (!refreshServices) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => void (timer = setTimeout(resolve, waitMs)));
  try {
    await Promise.race([Promise.resolve(refreshServices()).catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
};
export const isLinkShareService = (service: unknown): service is "copy" | "email" => service === COPY || service === EMAIL;

const unavailable = () => Object.assign(new Error("Sharing is unavailable in this window"), { code: "ERR_UNAVAILABLE" });
const mailable = (url: string) => /^https?:/i.test(url);
const below = (anchor: ShareAnchor | null | undefined) => anchor ? { x: anchor[0], y: anchor[1] + anchor[3] + 4 } : undefined;

export const mailtoLink = (url: CleanedUrl, title?: CleanedTitle | null) => `mailto:?subject=${encodeURIComponent(title || url)}&body=${encodeURIComponent(url)}`;

const serviceItems = (prefix: string): MenuItem[] => [
  ...services.map((service) => ({ id: `${prefix}${service.title}`, title: service.menuTitle })),
  { id: `${prefix}${MORE_SHARE_SERVICE}`, title: "More\u2026", symbol: "ellipsis.circle" },
];

export const linkShareItems = (url: string, prefix = ""): MenuItem[] => services.length && mailable(url) ? serviceItems(prefix) : [
  { id: `${prefix}${COPY}`, title: "Copy Link", symbol: "link" },
  ...(mailable(url) ? [{ id: `${prefix}${EMAIL}`, title: "Email Link", symbol: "envelope" }] : []),
];

const textShareItems = (): MenuItem[] => [{ id: COPY, title: "Copy", symbol: "doc.on.doc" }];

const expandShareMenus = (items: MenuItem[], seen: { share: boolean }): MenuItem[] => items.map((item) => {
  if ("separator" in item) return item;
  if (item.share && !item.children) {
    seen.share = true;
    return { ...item, children: linkShareItems("https:", `${item.id}${SHARE_SERVICE}`) };
  }
  return item.children ? { ...item, children: expandShareMenus(item.children, seen) } : item;
});

export const withShareMenus = (items: MenuItem[]): MenuItem[] => {
  const seen = { share: false };
  const expanded = expandShareMenus(items, seen);
  if (seen.share) void refreshServices?.();
  return expanded;
};

export function openMailLink(url: string, windowId: string | null = null): boolean {
  return /^mailto:/i.test(url) && !!surface?.openInActivePage(url, windowId);
}

export async function shareLinkVia(service: string, url: CleanedUrl, title: CleanedTitle | null, windowId: string | null): Promise<void> {
  if (!surface) throw unavailable();
  if (service === COPY) return surface.copy(url);
  if (service === EMAIL && mailable(url) && surface.openInActivePage(mailtoLink(url, title), windowId)) return;
  throw unavailable();
}

export async function shareLink(url: CleanedUrl, title: CleanedTitle | null, windowId: string | null, anchor?: ShareAnchor | null): Promise<void> {
  if (!surface) throw unavailable();
  const choice = await surface.menu(linkShareItems(url), below(anchor));
  if (choice) await shareLinkVia(choice, url, title, windowId);
}

export async function shareText(text: string, _windowId: string | null, anchor?: ShareAnchor | null): Promise<void> {
  if (!surface) throw unavailable();
  if (await surface.menu(textShareItems(), below(anchor)) === COPY) surface.copy(text);
}
