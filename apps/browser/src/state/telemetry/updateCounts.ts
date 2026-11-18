import { countFor, type ConsentToken } from "./consentPeriod";

let checks = { asked: 0, automatic: 0, failed: 0, found: 0, pageOpens: 0, switchRefreshes: 0, switchRefreshFailures: 0, unsandboxed: 0, passwordGranted: 0, passwordDenied: 0, passwordCancelled: 0, passwordUnverifiable: 0, passwordHelperFailed: 0 };

export function noteUpdateCheck(asked: boolean, outcome: "found" | "upToDate" | "failed", consent?: ConsentToken | null) {
  const fields = { update_checks_asked: +asked, update_checks_automatic: +!asked, update_check_failures: +(outcome === "failed"), update_checks_found: +(outcome === "found") };
  countFor(consent, () => {
    checks.asked += fields.update_checks_asked;
    checks.automatic += fields.update_checks_automatic;
    checks.failed += fields.update_check_failures;
    checks.found += fields.update_checks_found;
  }, fields);
}

export const noteUpdatePageOpened = (consent?: ConsentToken | null) => countFor(consent, () => void (checks.pageOpens += 1), { update_release_page_opens: 1 });

export function noteSwitchRefresh(result: "updated" | "failed" | "already") {
  if (result === "updated") checks.switchRefreshes += 1;
  if (result === "failed") checks.switchRefreshFailures += 1;
}

export const noteUnsandboxedLaunch = (consent?: ConsentToken | null) => countFor(consent, () => void (checks.unsandboxed += 1), { launches_without_sandbox: 1 });

export function noteLoginPasswordCheck(result: unknown) {
  if (result === "granted") checks.passwordGranted += 1;
  else if (result === "denied") checks.passwordDenied += 1;
  else if (result === "cancelled") checks.passwordCancelled += 1;
  else if (result === "unverifiable") checks.passwordUnverifiable += 1;
  else if (result === "helperFailed") checks.passwordHelperFailed += 1;
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
    login_password_checks_unverifiable: checks.passwordUnverifiable,
    login_password_checks_helper_failed: checks.passwordHelperFailed,
  };
  checks = { asked: 0, automatic: 0, failed: 0, found: 0, pageOpens: 0, switchRefreshes: 0, switchRefreshFailures: 0, unsandboxed: 0, passwordGranted: 0, passwordDenied: 0, passwordCancelled: 0, passwordUnverifiable: 0, passwordHelperFailed: 0 };
  return taken;
}
