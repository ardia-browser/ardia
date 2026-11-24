import { consentedCount } from "./consentedCount";

const fromShim = consentedCount();

export const noteWebNotificationFromShim = fromShim.note;

export function takeWebNotificationCounts() {
  return { web_notifications_from_shim: fromShim.take() };
}
