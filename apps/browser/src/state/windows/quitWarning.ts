import { confirm } from "../../platform/dialogs";
import { isPopupWindowId, windowIds } from "../../platform/windows";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { backgroundInstance } from "../app/appSettings";
import { useBrowser } from "../browser/store";
import { isUtilityWindowId } from "../settings/settingsWindows";
import { isWindowClosing } from "./closingWindows";

export const QUIT_WARNING = {
  title: "Are you sure you want to quit Ardia?",
  message: "Your windows and tabs will be restored the next time you open it.",
  confirmTitle: "Quit",
  suppression: "Don’t ask again",
} as const;

export type QuitWarning = "notAsked" | "confirmed" | "cancelled";

type Asking = { quitsWithLastWindow: boolean; background: boolean; warns: boolean; staysOpen: readonly string[] };

export const asksBeforeQuit = (asking: Asking) => asking.quitsWithLastWindow && !asking.background && asking.warns && asking.staysOpen.length === 0;

export function windowsStayingOpen(openWindowIds: readonly string[], closing: string, browserWindowIds: ReadonlySet<string>, isClosing: (id: string) => boolean) {
  if (openWindowIds.length === 0) return [closing];
  return openWindowIds.filter((id) => id !== closing && !isClosing(id) && (browserWindowIds.has(id) || isUtilityWindowId(id) || isPopupWindowId(id)));
}

export const quitWarningMayAsk = () => PLATFORM_FEATURES.quitsWithLastWindow && !backgroundInstance && useBrowser.getState().settings.warnBeforeQuitting;

const asking = new Set<string>();

export async function askBeforeQuitting(windowId: string, ask: typeof confirm = confirm, mayWrite: () => boolean = () => true): Promise<QuitWarning> {
  if (!quitWarningMayAsk()) return "notAsked";
  if (asking.has(windowId)) return "cancelled";
  asking.add(windowId);
  try {
    const wasBrowserWindow = windowId in useBrowser.getState().windows;
    const openWindowIds = await windowIds().catch(() => [] as string[]);
    const s = useBrowser.getState();
    if (wasBrowserWindow && !s.windows[windowId]) return "notAsked";
    const staysOpen = windowsStayingOpen(openWindowIds, windowId, new Set(Object.keys(s.windows)), isWindowClosing);
    if (!asksBeforeQuit({ quitsWithLastWindow: true, background: false, warns: s.settings.warnBeforeQuitting, staysOpen })) return "notAsked";
    const { confirmed, suppressed } = await ask({ ...QUIT_WARNING, windowId });
    if (suppressed && mayWrite()) useBrowser.getState().updateSettings({ warnBeforeQuitting: false });
    return confirmed ? "confirmed" : "cancelled";
  } finally {
    asking.delete(windowId);
  }
}
