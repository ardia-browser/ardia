import type { ConfirmOptions, DialogsNative } from "@ardia-real/shell";
import { useBrowser } from "../../browser/src/state/browser/store";
import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import { PLATFORM_TERMS } from "../../browser/src/lib/platformTerms";

export const QUIT_COMMAND = "quit";
export const QUIT_LOCK = "ardia.linux.quit";

export type QuitOutcome = "quitting" | "cancelled" | "busy";
type QuitAsk = DialogsNative["confirm"];
type QuitLocks = {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<QuitOutcome>): Promise<QuitOutcome>;
};
type LinuxQuitHooks = {
  appName: () => string;
  warnBeforeQuitting: () => boolean;
  stopWarning: () => void;
  ask: QuitAsk;
  downloadsInProgress: () => Promise<number>;
  quit: () => Promise<unknown>;
  locks?: QuitLocks;
};

export const quitWarning = (app: string): ConfirmOptions => ({
  title: `Are you sure you want to quit ${app}?`,
  message: "Your windows and tabs will be restored the next time you open it.",
  confirmTitle: "Quit",
  cancelTitle: "Cancel",
  suppression: "Don't ask again",
});

export const downloadsWarning = (app: string, count: number): ConfirmOptions => ({
  title: `Are you sure you want to quit ${app}?`,
  message: count === 1
    ? "You have 1 download in progress. If you quit now, this download will be cancelled."
    : `You have ${count} downloads in progress. If you quit now, these downloads will be cancelled.`,
  confirmTitle: "Quit",
  cancelTitle: "Cancel",
});

const quitError = (code: string, message: string) => Object.assign(new Error(message), { code });

export function createLinuxQuit(hooks: LinuxQuitHooks) {
  let running: Promise<QuitOutcome> | null = null;
  const attempt = async (): Promise<QuitOutcome> => {
    if (hooks.warnBeforeQuitting()) {
      const answer = await hooks.ask(quitWarning(hooks.appName()));
      if (!answer.confirmed) return "cancelled";
      if (answer.suppressed) hooks.stopWarning();
    }
    const downloads = await hooks.downloadsInProgress();
    if (downloads > 0 && !(await hooks.ask(downloadsWarning(hooks.appName(), downloads))).confirmed) return "cancelled";
    await hooks.quit();
    return "quitting";
  };
  const claimed = (): Promise<QuitOutcome> => hooks.locks
    ? hooks.locks.request(QUIT_LOCK, { ifAvailable: true }, (lock) => lock ? attempt() : Promise.resolve("busy"))
    : attempt();
  return (): Promise<QuitOutcome> => running ??= claimed().finally(() => { running = null; });
}

const browserLocks = (): QuitLocks | undefined => typeof navigator === "undefined" ? undefined : (navigator as { locks?: QuitLocks }).locks;

const QUIT_ROUTE = "ArdiaShell.quit";
const DOWNLOADS_IN_PROGRESS = "ArdiaShell.downloadsInProgress";

export function createHostQuit(host: ArdiaHost, ask: QuitAsk, locks: QuitLocks | undefined = browserLocks()) {
  if (!hostSupports(QUIT_ROUTE, host))
    return () => Promise.reject(quitError("ERR_UNAVAILABLE", `Quitting isn't available in this ${PLATFORM_TERMS.os} build`));
  return createLinuxQuit({
    appName: () => "Ardia",
    warnBeforeQuitting: () => useBrowser.getState().settings.warnBeforeQuitting,
    stopWarning: () => useBrowser.getState().updateSettings({ warnBeforeQuitting: false }),
    ask,
    downloadsInProgress: async () => {
      if (!hostSupports(DOWNLOADS_IN_PROGRESS, host)) return 0;
      const count = await invokeHost<unknown>("ArdiaShell.downloadsInProgress", { args: [] }, host);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw quitError("ERR_QUIT", "The download count is unreadable");
      return count;
    },
    quit: () => invokeHost("ArdiaShell.quit", { args: [] }, host),
    locks,
  });
}
