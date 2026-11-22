import { t } from "../../lib/uiLanguage";
export type InstallResult = { ok: true } | { ok: false; reason: string; cancelled?: true };

const waiters = new Map<string, (result: InstallResult) => void>();

export function settleInstall(name: string, result: InstallResult) {
  const waiter = waiters.get(name);
  if (!waiter) return;
  waiters.delete(name);
  waiter(result);
}

export function waitForInstall(name: string): Promise<InstallResult> {
  settleInstall(name, { ok: false, reason: t(`Another install started.`) });
  return new Promise((resolve) => waiters.set(name, resolve));
}
