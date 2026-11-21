import { onAppEvent } from "../../platform/app";
import { onConsentPeriodChange } from "./choice";
import { capture, counted } from "./client";
import { consentedCount } from "./consentedCount";
import { nativeConsent } from "./nativeConsent";

let autoDenied = 0;
let toEngineDelegate = 0;
let shownByHub = 0;
let settings: { notification_authorization: string; notification_alert_setting: string; notification_alert_style: string } | null = null;
const webClicks = consentedCount();
const engineResponses = consentedCount();

const AUTHORIZATION = ["notDetermined", "denied", "authorized", "provisional", "ephemeral", "unknown"];
const ALERT_SETTING = ["notSupported", "disabled", "enabled", "unknown"];
const ALERT_STYLE = ["none", "banner", "alert", "unknown"];
const nameIn = (names: readonly string[], value: unknown) => (typeof value === "string" && names.includes(value) ? value : "other");

onConsentPeriodChange(() => {
  toEngineDelegate = 0;
  shownByHub = 0;
  settings = null;
});

onAppEvent((e) => {
  if (e.type === "engineNotificationPresented") {
    const handed = e.handedToEngine === true;
    counted(
      nativeConsent(e),
      () => void (handed ? toEngineDelegate++ : shownByHub++),
      () => capture("usage_counts", { [handed ? "engine_notifications_to_engine_delegate" : "engine_notifications_shown_by_hub"]: 1 }, null),
    );
  } else if (e.type === "notificationSettings") {
    const read = {
      notification_authorization: nameIn(AUTHORIZATION, e.authorization),
      notification_alert_setting: nameIn(ALERT_SETTING, e.alertSetting),
      notification_alert_style: nameIn(ALERT_STYLE, e.alertStyle),
    };
    counted(
      nativeConsent(e),
      () => void (settings = read),
      () => capture("usage_counts", read, null),
    );
  }
});

export function noteNotificationRequestAutoDenied() {
  autoDenied++;
}

export const noteWebNotificationClicked = webClicks.note;
export const noteEngineNotificationResponse = engineResponses.note;

export function takeNotificationRequestCounts() {
  const taken = {
    notification_requests_auto_denied: autoDenied,
    web_notification_clicks: webClicks.take(),
    worker_notification_responses: engineResponses.take(),
    engine_notifications_to_engine_delegate: toEngineDelegate,
    engine_notifications_shown_by_hub: shownByHub,
    ...settings,
  };
  autoDenied = 0;
  toEngineDelegate = 0;
  shownByHub = 0;
  settings = null;
  return taken;
}
