let checks = { asked: 0, automatic: 0, failed: 0, found: 0, pageOpens: 0, switchRefreshes: 0, switchRefreshFailures: 0, unsandboxed: 0, passwordGranted: 0, passwordDenied: 0, passwordCancelled: 0 };

export function noteUpdateCheck(asked: boolean, outcome: "found" | "upToDate" | "failed") {
  if (asked) checks.asked += 1;
  else checks.automatic += 1;
  if (outcome === "failed") checks.failed += 1;
  if (outcome === "found") checks.found += 1;
}

export const noteUpdatePageOpened = () => void (checks.pageOpens += 1);

export function noteSwitchRefresh(result: "updated" | "failed" | "already") {
  if (result === "updated") checks.switchRefreshes += 1;
  if (result === "failed") checks.switchRefreshFailures += 1;
}

export const noteUnsandboxedLaunch = () => void (checks.unsandboxed += 1);

export function noteLoginPasswordCheck(result: unknown) {
  if (result === "granted") checks.passwordGranted += 1;
  else if (result === "denied") checks.passwordDenied += 1;
  else if (result === "cancelled") checks.passwordCancelled += 1;
}

export function takeUpdateCounts() {
  const taken = {
    update_checks_asked: checks.asked,
    update_checks_automatic: checks.automatic,
    update_check_failures: checks.failed,
    update_checks_found: checks.found,
    update_release_page_opens: checks.pageOpens,
    kill_switch_refreshes: checks.switchRefreshes,
    kill_switch_refresh_failures: checks.switchRefreshFailures,
    launches_without_sandbox: checks.unsandboxed,
    login_password_checks_granted: checks.passwordGranted,
    login_password_checks_denied: checks.passwordDenied,
    login_password_checks_cancelled: checks.passwordCancelled,
  };
  checks = { asked: 0, automatic: 0, failed: 0, found: 0, pageOpens: 0, switchRefreshes: 0, switchRefreshFailures: 0, unsandboxed: 0, passwordGranted: 0, passwordDenied: 0, passwordCancelled: 0 };
  return taken;
}
