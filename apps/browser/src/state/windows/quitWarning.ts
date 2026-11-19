import { confirm } from "../../platform/dialogs";
import { isPopupWindowId, windowIds } from "../../platform/windows";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { backgroundInstance } from "../app/appSettings";
import { useBrowser } from "../browser/store";
import { isUtilityWindowId } from "../settings/settingsWindows";
import { isWindowClosing } from "./closingWindows";
import { downloadsInProgress } from "../downloads/status";
import type { ConsentToken } from "../telemetry/choice";
import { noteQuitAskedWithDownloads } from "../telemetry/quitWarningCounts";

export const QUIT_WARNING = {
  title: "Are you sure you want to quit Ardia?",
  message: "Your windows and tabs will be restored the next time you open it.",
  confirmTitle: "Quit",
  suppression: "Don’t ask again",
} as const;

export const downloadsQuitWarning = (count: number) =>
  ({
    title: QUIT_WARNING.title,
    message: count === 1 ? "You have 1 download in progress. If you quit now, this download will be cancelled." : `You have ${count} downloads in progress. If you quit now, these downloads will be cancelled.`,
    confirmTitle: QUIT_WARNING.confirmTitle,
  }) as const;

export type QuitWarning = "notAsked" | "confirmed" | "cancelled";

type Closing = { quitsWithLastWindow: boolean; background: boolean; staysOpen: readonly string[] };
type Asking = Closing & { warns: boolean };

export const closeQuits = (closing: Closing) => closing.quitsWithLastWindow && !closing.background && closing.staysOpen.length === 0;

export const asksBeforeQuit = (asking: Asking) => closeQuits(asking) && asking.warns;

export function windowsStayingOpen(openWindowIds: readonly string[], closing: string, browserWindowIds: ReadonlySet<string>, isClosing: (id: string) => boolean) {
  if (openWindowIds.length === 0) return [closing];
  return openWindowIds.filter((id) => id !== closing && !isClosing(id) && (browserWindowIds.has(id) || isUtilityWindowId(id) || isPopupWindowId(id)));
}

export function quitWarningMayAsk() {
  if (!PLATFORM_FEATURES.quitsWithLastWindow || backgroundInstance) return false;
  const s = useBrowser.getState();
  return s.settings.warnBeforeQuitting || downloadsInProgress(s.downloads) > 0;
}

const asking = new Set<string>();
const notedWhenHidden = new Set<string>();

async function closeStillQuits(windowId: string) {
  const openWindowIds = await windowIds().catch(() => [] as string[]);
  const staysOpen = windowsStayingOpen(openWindowIds, windowId, new Set(Object.keys(useBrowser.getState().windows)), isWindowClosing);
  return closeQuits({ quitsWithLastWindow: true, background: false, staysOpen });
}

const quitFacts = (downloads: number, warns: boolean) => `${downloads} ${downloads === 1 ? "download" : "downloads"} in progress, warning ${warns ? "on" : "off"}`;

export function noteQuitNotAskedWhenHidden(windowId: string) {
  if (!PLATFORM_FEATURES.quitsWithLastWindow || !backgroundInstance || notedWhenHidden.has(windowId)) return;
  const s = useBrowser.getState();
  const downloads = downloadsInProgress(s.downloads);
  const warns = s.settings.warnBeforeQuitting;
  if (!warns && downloads === 0) return;
  notedWhenHidden.add(windowId);
  void closeStillQuits(windowId).then((quits) => {
    if (quits) console.info(`[quit] not asked on a hidden instance: ${quitFacts(downloads, warns)}`);
    else notedWhenHidden.delete(windowId);
  });
}

export async function askBeforeQuitting(windowId: string, ask: typeof confirm = confirm, { warning = true, consent }: { warning?: boolean; consent?: ConsentToken | null } = {}): Promise<QuitWarning> {
  if (!quitWarningMayAsk()) {
    noteQuitNotAskedWhenHidden(windowId);
    return "notAsked";
  }
  if (asking.has(windowId)) return "cancelled";
  asking.add(windowId);
  try {
    const wasBrowserWindow = windowId in useBrowser.getState().windows;
    const quits = await closeStillQuits(windowId);
    if (wasBrowserWindow && !useBrowser.getState().windows[windowId]) return "notAsked";
    if (!quits) return "notAsked";
    const warns = useBrowser.getState().settings.warnBeforeQuitting;
    const answered = (answer: Exclude<QuitWarning, "notAsked">) => {
      console.info(`[quit] asked: ${quitFacts(downloadsInProgress(useBrowser.getState().downloads), warns)}; answered ${answer === "confirmed" ? "quit" : "cancel"}`);
      return answer;
    };
    let answer: QuitWarning = "notAsked";
    if (warning && warns) {
      const { confirmed, suppressed } = await ask({ ...QUIT_WARNING, windowId });
      if (suppressed) useBrowser.getState().updateSettings({ warnBeforeQuitting: false });
      if (!confirmed) return answered("cancelled");
      answer = "confirmed";
      if (!(await closeStillQuits(windowId))) return answered(answer);
    }
    const running = downloadsInProgress(useBrowser.getState().downloads);
    if (running > 0) {
      const { confirmed } = await ask({ ...downloadsQuitWarning(running), windowId });
      noteQuitAskedWithDownloads(!confirmed, consent);
      if (!confirmed) return answered("cancelled");
      answer = "confirmed";
    }
    return answer === "confirmed" ? answered(answer) : answer;
  } finally {
    asking.delete(windowId);
  }
}
