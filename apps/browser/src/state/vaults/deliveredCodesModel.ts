import type { DeliveredCode, DeliveredCodeAccess, DeliveredCodes, DeliveredCodeSource, VaultItem } from "../../platform/vaults";
import { siteKey } from "./originMatch";

export const DELIVERED = "delivered";
export const MAX_DELIVERED_ROWS = 3;
const MINUTE_MS = 60_000;

export type DeliveredItem = VaultItem & { delivered: DeliveredCode };

export const isDeliveredItem = (item: VaultItem): item is DeliveredItem => item.provider === DELIVERED && "delivered" in item;

export const deliveredItem = (code: DeliveredCode): DeliveredItem => ({
  provider: DELIVERED,
  id: code.id,
  title: code.sender,
  username: "",
  urls: code.site ? [`https://${code.site}`] : [],
  hasTotp: true,
  delivered: code,
});

const SOURCES: ReadonlySet<string> = new Set<DeliveredCodeSource>(["messages", "mail"]);
const ACCESS: ReadonlySet<string> = new Set<DeliveredCodeAccess>(["off", "needsAccess", "on"]);

const isCode = (c: unknown): c is DeliveredCode => {
  if (!c || typeof c !== "object") return false;
  const v = c as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.startsWith(`${DELIVERED}.`) &&
    SOURCES.has(v.source as string) &&
    typeof v.sender === "string" &&
    (v.site === null || typeof v.site === "string") &&
    typeof v.bound === "boolean" &&
    Number.isFinite(v.receivedAt) &&
    Number.isFinite(v.expiresAt)
  );
};

export function liveDelivered(state: unknown, now: number): DeliveredCodes {
  const s = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  const access = ACCESS.has(s.access as string) ? (s.access as DeliveredCodeAccess) : "off";
  const codes = access === "on" && Array.isArray(s.codes) ? s.codes.filter(isCode).filter((c) => c.expiresAt > now) : [];
  return { access, codes: codes.sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? -1 : 1)) };
}

export const nextExpiry = (codes: readonly DeliveredCode[]): number | null => (codes.length ? Math.min(...codes.map((c) => c.expiresAt)) : null);

const onPage = (code: DeliveredCode, page: string) => !!code.site && !!page && siteKey(`https://${code.site}`) === page;
const pageKey = (site: string) => siteKey(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`);

export const fillsOnSite = (code: DeliveredCode, page: string) => code.bound && onPage(code, pageKey(page));
export const anyFillsOnSite = (items: readonly DeliveredItem[], page: string) => items.some((item) => fillsOnSite(item.delivered, page));

export function deliveredFirst(items: readonly DeliveredItem[], origin: string): { item: DeliveredItem; userChose: boolean }[] {
  const page = siteKey(origin);
  return items
    .map((item, order) => ({ item, order, here: onPage(item.delivered, page) }))
    .filter(({ item, here }) => here || !item.delivered.bound)
    .sort((a, b) => Number(b.here) - Number(a.here) || b.item.delivered.receivedAt - a.item.delivered.receivedAt || a.order - b.order)
    .slice(0, MAX_DELIVERED_ROWS)
    .map(({ item, here }) => ({ item, userChose: !(item.delivered.bound && here) }));
}

export const SOURCE_NAME: Record<DeliveredCodeSource, string> = { messages: "Messages", mail: "Mail" };

export function deliveredAge(receivedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - receivedAt) / MINUTE_MS);
  return minutes < 1 ? "now" : `${minutes} min ago`;
}

export const nextAgeChange = (receivedAt: number, now: number) => MINUTE_MS - (Math.max(0, now - receivedAt) % MINUTE_MS);

function fromOf(code: DeliveredCode, page: string) {
  if (!code.site) return code.sender;
  return onPage(code, pageKey(page)) ? code.site : `for ${code.site}`;
}

export function deliveredLines(code: DeliveredCode, now: number, page: string): { source: string; from: string; age: string } {
  return { source: `From ${SOURCE_NAME[code.source]}`, from: fromOf(code, page), age: deliveredAge(code.receivedAt, now) };
}

export function deliveredFillError(error: string): string | null {
  switch (error) {
    case "originMismatch":
      return "This code was sent for another site, so it wasn't filled.";
    case "notFound":
      return "This code has expired.";
    case "insecure":
      return null;
    default:
      return "Couldn't fill this code. Try again.";
  }
}
