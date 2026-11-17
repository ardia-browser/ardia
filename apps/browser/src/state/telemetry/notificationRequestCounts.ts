import { consentedCount } from "./consentedCount";

let autoDenied = 0;
const webClicks = consentedCount();
const engineResponses = consentedCount();

export function noteNotificationRequestAutoDenied() {
  autoDenied++;
}

export const noteWebNotificationClicked = webClicks.note;
export const noteEngineNotificationResponse = engineResponses.note;

export function takeNotificationRequestCounts() {
  const taken = { notification_requests_auto_denied: autoDenied, web_notification_clicks: webClicks.take(), worker_notification_responses: engineResponses.take() };
  autoDenied = 0;
  return taken;
}
