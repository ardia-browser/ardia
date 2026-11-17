import type { NotificationPostResult } from "../../platform/notifications";
import { isSharing, useTelemetry } from "./choice";
import { capture } from "./client";
import { errorType } from "./sanitize";

export const WEB_NOTIFICATION_FAILED = "web_notification_failed";

export type SentWebNotification = {
  titleLength: number;
  bodyLength: number;
  iconRequested: boolean;
  iconSent: boolean;
};

export function webNotificationFailureProperties(sent: SentWebNotification, result: NotificationPostResult | null | undefined, thrown?: { error: unknown }) {
  return {
    title_length: sent.titleLength,
    body_length: sent.bodyLength,
    icon_requested: sent.iconRequested,
    icon_sent: sent.iconSent,
    icon_status: result?.icon ?? "unknown",
    via_shim: true,
    threw: !!thrown,
    ...(thrown ? { error_type: errorType(thrown.error) } : {}),
    ...(typeof result?.errorCode === "number" ? { error_code: result.errorCode } : {}),
    ...(result?.errorDomain ? { error_domain: result.errorDomain } : {}),
    ...(typeof result?.iconErrorCode === "number" ? { icon_error_code: result.iconErrorCode } : {}),
  };
}

let consentGeneration = 0;

useTelemetry.subscribe((current, previous) => {
  if (current.sharing !== previous.sharing) consentGeneration++;
});

export function recordWebNotificationPost(posted: Promise<NotificationPostResult | string | null | undefined>, sent: SentWebNotification): Promise<void> {
  const sharedAtStart = isSharing();
  const generation = consentGeneration;
  const consented = () => sharedAtStart && isSharing() && generation === consentGeneration;
  return posted.then(
    (result) => {
      if (consented() && result && typeof result === "object" && !result.id) capture(WEB_NOTIFICATION_FAILED, webNotificationFailureProperties(sent, result));
    },
    (error: unknown) => {
      if (consented()) capture(WEB_NOTIFICATION_FAILED, webNotificationFailureProperties(sent, null, { error }));
      throw error;
    },
  );
}
