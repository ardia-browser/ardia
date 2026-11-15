import type { MenuItem } from "@ardia-real/shell";

export type ShareAnchor = readonly [number, number, number, number];
export type ShareSurface = {
  menu(items: MenuItem[], at?: { x: number; y: number }): Promise<string | null>;
  copy(text: string): void;
  openInActivePage(url: string, windowId: string | null): boolean;
};

const COPY = "copy";
const EMAIL = "email";
const SHARE_SERVICE = ":via:";

let surface: ShareSurface | null = null;
export const setShareSurface = (next: ShareSurface | null) => void (surface = next);

const unavailable = () => Object.assign(new Error("Sharing is unavailable in this window"), { code: "ERR_UNAVAILABLE" });
const mailable = (url: string) => /^https?:/i.test(url);
const below = (anchor: ShareAnchor | null | undefined) => anchor ? { x: anchor[0], y: anchor[1] + anchor[3] + 4 } : undefined;

export const mailtoLink = (url: string, title?: string | null) => `mailto:?subject=${encodeURIComponent(title || url)}&body=${encodeURIComponent(url)}`;

export const linkShareItems = (url: string, prefix = ""): MenuItem[] => [
  { id: `${prefix}${COPY}`, title: "Copy Link", symbol: "link" },
  ...(mailable(url) ? [{ id: `${prefix}${EMAIL}`, title: "Email Link", symbol: "envelope" }] : []),
];

export const textShareItems = (): MenuItem[] => [{ id: COPY, title: "Copy", symbol: "doc.on.doc" }];

export const withShareMenus = (items: MenuItem[]): MenuItem[] => items.map((item) => {
  if ("separator" in item) return item;
  if (item.share && !item.children) return { ...item, children: linkShareItems("https:", `${item.id}${SHARE_SERVICE}`) };
  return item.children ? { ...item, children: withShareMenus(item.children) } : item;
});

export function openMailLink(url: string, windowId: string | null = null): boolean {
  return /^mailto:/i.test(url) && !!surface?.openInActivePage(url, windowId);
}

export async function shareLinkVia(service: string, url: string, title: string | null, windowId: string | null): Promise<void> {
  if (!surface) throw unavailable();
  if (service === COPY) return surface.copy(url);
  if (service === EMAIL && mailable(url) && surface.openInActivePage(mailtoLink(url, title), windowId)) return;
  throw unavailable();
}

export async function shareLink(url: string, title: string | null, windowId: string | null, anchor?: ShareAnchor | null): Promise<void> {
  if (!surface) throw unavailable();
  const choice = await surface.menu(linkShareItems(url), below(anchor));
  if (choice) await shareLinkVia(choice, url, title, windowId);
}

export async function shareText(text: string, _windowId: string | null, anchor?: ShareAnchor | null): Promise<void> {
  if (!surface) throw unavailable();
  if (await surface.menu(textShareItems(), below(anchor)) === COPY) surface.copy(text);
}
