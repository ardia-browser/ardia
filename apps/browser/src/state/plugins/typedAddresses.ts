import { urlParts } from "../../lib/urlParts";
import { isLocalOrigin, switchOrigin } from "../../lib/pluginPageBar";

const TYPED_INTENT_MS = 20_000;
const typed = new Map<string, { url: string; origin: string; at: number }>();

function documentUrl(url: string): string {
  const origin = switchOrigin(url);
  const parts = urlParts(url);
  return origin && parts ? `${origin}${parts.path || "/"}${parts.query}` : url.replace(/#.*$/, "");
}

export function noteTypedAddress(tabId: string, url: string) {
  const origin = switchOrigin(url);
  if (origin && isLocalOrigin(origin)) typed.set(tabId, { url: documentUrl(url), origin, at: Date.now() });
  else typed.delete(tabId);
}

export const dropTypedAddress = (tabId: string) => void typed.delete(tabId);

export function takeTypedAddress(tabId: string, committedUrl: string, committedAt: number, now = Date.now()): string | null {
  const intent = typed.get(tabId);
  if (!intent || !(committedAt > 0) || committedAt < intent.at) return null;
  typed.delete(tabId);
  if (now - intent.at > TYPED_INTENT_MS || documentUrl(committedUrl) !== intent.url || switchOrigin(committedUrl) !== intent.origin) return null;
  return intent.origin;
}
