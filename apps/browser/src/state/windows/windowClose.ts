import { confirm } from "../../platform/dialogs";
import { closeWindow as closeNativeWindow, onWindowEvent } from "../../platform/windows";
import { useBrowser } from "../browser/store";
import { inPinnedContainer, plural, profileFor } from "../browser/model";
import { tabsLostWithWindow } from "../tabs/sharedWindowClose";
import { isLastRegularWindow, isOpenRegularWindow, isSmall } from "./small";
import { closeLittleArdia } from "../littleArdia/actions";
import { closeWindowAnimated } from "./closeAnimated";
import { isEmptyCardTab } from "../omnibox/newTabBarPolicy";
import { askBeforeQuitting } from "./quitWarning";
import { startClosingWindow, stopClosingWindow } from "./closingWindows";
import { noteQuitAskedAfterTabsConfirm } from "../telemetry/quitWarningCounts";

const MIN_TABS = 2;

const pending = new Set<string>();

export function requestWindowClose(windowId: string, onceAgreed?: () => void) {
  if (pending.has(windowId)) return;
  pending.add(windowId);
  void requestClose(windowId, onceAgreed).finally(() => pending.delete(windowId));
}

export function startWindowCloseGuard() {
  onWindowEvent((e) => {
    if (e.type === "closeRequest") requestWindowClose(e.id);
  });
}

let windowsWithoutTabsClosing: Promise<void> = Promise.resolve();

function closeWindowWithoutTabs(windowId: string, onceAgreed?: () => void) {
  const closing = windowsWithoutTabsClosing.then(async () => {
    if ((await askBeforeQuitting(windowId)) === "cancelled") return;
    onceAgreed?.();
    startClosingWindow(windowId);
    try {
      await closeNativeWindow(windowId);
    } finally {
      stopClosingWindow(windowId);
    }
  });
  windowsWithoutTabsClosing = closing.catch(() => undefined);
  return closing;
}

async function requestClose(windowId: string, onceAgreed?: () => void) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w) return closeWindowWithoutTabs(windowId, onceAgreed);
  if (isSmall(s, windowId)) return closeLittleArdia(windowId);
  const { decision, suppressWarning, keepsLastWindow } = await decideWindowClose(windowId);
  if (suppressWarning) useBrowser.getState().updateSettings({ warnBeforeClosingWindow: false });
  if (decision === "cancel") return;
  closeWindowAnimated(windowId, { keepsLastWindow });
}

export type CloseAsk = typeof confirm;
export type WindowCloseDecision = { decision: "allow" | "cancel"; suppressWarning: boolean; keepsLastWindow?: boolean };

const allow = (suppressWarning = false): WindowCloseDecision => ({ decision: "allow", suppressWarning });

async function askToClose(windowId: string, ask: CloseAsk, closing?: string[]): Promise<WindowCloseDecision> {
  const { confirmed, suppressed } = await ask({ ...closeWindowDialog(windowId, closing), suppression: "Don’t ask me again", windowId });
  return { decision: confirmed ? "allow" : "cancel", suppressWarning: suppressed };
}

const cancel = (suppressWarning = false): WindowCloseDecision => ({ decision: "cancel", suppressWarning });

export async function decideWindowClose(windowId: string, ask: CloseAsk = confirm): Promise<WindowCloseDecision> {
  let quitWarning = await askBeforeQuitting(windowId, ask);
  if (quitWarning === "cancelled") return cancel();
  const asked = new Set<string>();
  let suppressWarning = false;
  for (;;) {
    const now = useBrowser.getState();
    if (!now.windows[windowId]) return cancel(suppressWarning);
    if (isLastRegularWindow(now, windowId)) return { ...allow(suppressWarning), keepsLastWindow: true };
    if (quitWarning === "confirmed") return allow(suppressWarning);
    const closing = tabsLostWithWindow(now, windowId, isOpenRegularWindow).map((t) => t.id);
    const warns = now.settings.warnBeforeClosingWindow && !suppressWarning;
    if (!warns || closing.length < MIN_TABS || closing.every((id) => asked.has(id))) return allow(suppressWarning);
    const answer = await askToClose(windowId, ask, closing);
    suppressWarning ||= answer.suppressWarning;
    if (answer.decision === "cancel") return cancel(suppressWarning);
    for (const id of closing) asked.add(id);
    if (quitWarning !== "notAsked") continue;
    quitWarning = await askBeforeQuitting(windowId, ask);
    if (quitWarning !== "notAsked") noteQuitAskedAfterTabsConfirm(quitWarning === "cancelled");
    if (quitWarning === "cancelled") return cancel(suppressWarning);
  }
}

export async function decideLastTabClose(windowId: string, ask: CloseAsk = confirm): Promise<WindowCloseDecision> {
  if (!useBrowser.getState().windows[windowId]) return allow();
  if (asksBeforeClosingLastTab(windowId)) return askToClose(windowId, ask, unpinnedOpenTabIds(windowId));
  return (await askBeforeQuitting(windowId, ask)) === "cancelled" ? cancel() : allow();
}

export function asksBeforeClosingLastTab(windowId: string) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  return !!w && s.settings.warnBeforeClosingLastTab && w.kind !== "private" && unpinnedOpenTabIds(windowId).length > 0;
}

export const unpinnedOpenTabIds = (windowId: string) => {
  const s = useBrowser.getState();
  return (s.windows[windowId]?.tabIds ?? []).filter((id) => !inPinnedContainer(s, id) && !isEmptyCardTab(s, s.tabs[id]));
};

export function closeWindowDialog(windowId: string, closing = unpinnedOpenTabIds(windowId)) {
  const s = useBrowser.getState();
  const w = s.windows[windowId]!;
  const tabs = (n: number) => plural(n, "tab");
  const byProfile = new Map<string, number>();
  for (const id of closing) {
    const profileId = s.tabs[id]?.profileId ?? w.profileId;
    byProfile.set(profileId, (byProfile.get(profileId) ?? 0) + 1);
  }
  const count = closing.length;
  const message =
    byProfile.size > 1
      ? ["Closing this window closes all tabs open across profiles:", ...[...byProfile].map(([id, n]) => `  • ${tabs(n)} in ${profileFor(s, id).name}`)].join("\n")
      : `This window has ${tabs(count)} open in your ${profileFor(s, [...byProfile.keys()][0] ?? w.profileId).name} profile.`;
  return {
    title: count === 1 ? "Close 1 tab?" : `Close ${count} tabs?`,
    message,
    confirmTitle: count === 1 ? "Close Tab" : "Close All Tabs",
  };
}
