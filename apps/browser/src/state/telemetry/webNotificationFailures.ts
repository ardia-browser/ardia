import type { NotificationPostResult } from "../../platform/notifications";
import type { ConsentToken } from "./choice";
import { capture } from "./client";
import { errorType } from "./sanitize";

export const WEB_NOTIFICATION_FAILED = "web_notification_failed";

type SentWebNotification = {
  titleLength: number;
  bodyLength: number;
  iconRequested: boolean;
  iconSent: boolean;
};

const ICON_STATUSES = new Set(["none", "invalid_url", "attached", "attachment_rejected", "empty", "download_failed", "write_failed", "too_large"]);
const ERROR_DOMAINS = new Set(["UNErrorDomain", "NSCocoaErrorDomain", "NSPOSIXErrorDomain", "NSOSStatusErrorDomain"]);
const known = (names: Set<string>, value: unknown) => (typeof value === "string" && names.has(value) ? value : "other");

export function webNotificationFailureProperties(sent: SentWebNotification, result: NotificationPostResult | null | undefined, thrown?: { error: unknown }) {
  return {
    title_length: sent.titleLength,
    body_length: sent.bodyLength,
    icon_requested: sent.iconRequested,
    icon_sent: sent.iconSent,
    icon_status: result ? known(ICON_STATUSES, result.icon) : "unknown",
    via_shim: true,
    threw: !!thrown,
    ...(thrown ? { error_type: errorType(thrown.error) } : {}),
    ...(typeof result?.errorCode === "number" ? { error_code: result.errorCode } : {}),
    ...(result?.errorDomain ? { error_domain: known(ERROR_DOMAINS, result.errorDomain) } : {}),
    ...(typeof result?.iconErrorCode === "number" ? { icon_error_code: result.iconErrorCode } : {}),
  };
}

export function recordWebNotificationPost(posted: Promise<NotificationPostResult | string | null | undefined>, sent: SentWebNotification, token: ConsentToken | null): Promise<void> {
  return posted.then(
    (result) => {
      if (result && typeof result === "object" && !result.id) capture(WEB_NOTIFICATION_FAILED, webNotificationFailureProperties(sent, result), token);
    },
    (error: unknown) => {
      capture(WEB_NOTIFICATION_FAILED, webNotificationFailureProperties(sent, null, { error }), token);
      throw error;
    },
  );
}
