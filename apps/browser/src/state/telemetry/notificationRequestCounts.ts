let autoDenied = 0;

export function noteNotificationRequestAutoDenied() {
  autoDenied++;
}

export function takeNotificationRequestCounts() {
  const taken = { notification_requests_auto_denied: autoDenied };
  autoDenied = 0;
  return taken;
}
