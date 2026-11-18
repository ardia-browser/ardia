import type { OpenWindowOptions, WindowEvent } from "@ardia/shell";
import { TurboModuleRegistry, type TurboModule } from "react-native";
import { addNativeListener, type EventSubscription } from "../events";
import type { AppWindowsModule } from "../nativeModuleTypes";
import { popupFrame, popupSize, popupTitle, type PopupFeatures } from "./popupPlacement";
import { onEngineTopic } from "./host";
import { privatePopupShown } from "./privateWindows";
import { isPopupWindowId, POPUP_WINDOW_PREFIX } from "@ardia/shell/src/windows.ts";

export { isPopupWindowId, POPUP_WINDOW_PREFIX };

export type PopupWindowInfo = {
  windowId: string;
  pageKey: string;
  adopt: string;
  url: string;
  profile: string;
  openerKey: string;
  focused: boolean;
};

export type PopupWindowAsk = {
  adopt: string;
  url: string;
  profile: string;
  openerKey: string;
  openedFromKey: string;
  openedFromWindowId: string;
  features: PopupFeatures;
};

type PopupWindowOptions = OpenWindowOptions & { focusWhenFront: string; focusWhenPage: string };

type PopupWindows = TurboModule &
  Pick<AppWindowsModule, "closeWindow" | "requestClose" | "windowFrame" | "windowIds" | "setWindowTitle"> & { openWindow(id: string, options: PopupWindowOptions): Promise<void> };

const WINDOWS_MODULE = "ArdiaAppWindows";

const windows = (): PopupWindows => {
  const native = TurboModuleRegistry.get<PopupWindows>(WINDOWS_MODULE);
  if (!native) throw new Error(`${WINDOWS_MODULE} has no native module`);
  return native;
};

export type PopupWindowOutcome = "shown" | "closed" | "failed";

const popups = new Map<string, PopupWindowInfo>();
const privateHolds = new Map<string, () => void>();
const closedListeners = new Set<(popup: PopupWindowInfo) => void>();
let closes: EventSubscription | null = null;
let pageCloses: { remove(): void } | null = null;
let made = 0;


export const popupWindowInfo = (windowId: string): PopupWindowInfo | null => popups.get(windowId) ?? null;

export const popupOpenerKey = (windowId: string) => popups.get(windowId)?.openerKey ?? "";

export const openPopupWindowCount = () => popups.size;

export function onPopupWindowClosed(listener: (popup: PopupWindowInfo) => void): () => void {
  closedListeners.add(listener);
  return () => void closedListeners.delete(listener);
}

function letGoOfPrivateSession(windowId: string) {
  privateHolds.get(windowId)?.();
  privateHolds.delete(windowId);
}

function popupClosed(windowId: string) {
  const popup = popups.get(windowId);
  if (!popup) return;
  popups.delete(windowId);
  letGoOfPrivateSession(windowId);
  for (const listener of [...closedListeners]) listener(popup);
}

function listenForPageCloses() {
  pageCloses ??= onEngineTopic("tab", (event) => {
    if (event.name !== "windowClose" || typeof event.key !== "string") return;
    for (const popup of [...popups.values()]) if (popup.pageKey === event.key) closePopupWindow(popup.windowId);
  });
}

function listenForCloses() {
  closes ??= addNativeListener(WINDOWS_MODULE, "onWindowEvent", (payload) => {
    const event = payload as WindowEvent | null;
    if (event?.type === "close" && isPopupWindowId(event.id)) popupClosed(event.id);
    const activated = event?.type === "focus" && !event.fromPage ? popups.get(event.id) : undefined;
    if (activated) activated.focused = true;
  });
}

const openerFrame = (windowId: string) =>
  windowId
    ? Promise.resolve(windows().windowFrame(windowId)).then(
        (frame) => frame ?? null,
        () => null,
      )
    : Promise.resolve(null);

export async function openPopupWindow(ask: PopupWindowAsk): Promise<PopupWindowOutcome> {
  listenForCloses();
  listenForPageCloses();
  made += 1;
  const windowId = `${POPUP_WINDOW_PREFIX}${Date.now().toString(36)}-${made}`;
  const popup: PopupWindowInfo = { windowId, pageKey: `${windowId}:page`, adopt: ask.adopt, url: ask.url, profile: ask.profile, openerKey: ask.openerKey, focused: false };
  popups.set(windowId, popup);
  privateHolds.set(windowId, privatePopupShown(ask.profile));
  try {
    const frame = popupFrame(ask.features, await openerFrame(ask.openedFromWindowId));
    await windows().openWindow(windowId, {
      kind: "popup",
      title: popupTitle("", ask.url),
      focus: !!ask.openedFromKey && !!ask.openedFromWindowId,
      focusWhenFront: ask.openedFromWindowId,
      focusWhenPage: ask.openedFromKey,
      profile: ask.profile,
      ...(frame ? { frame } : { size: popupSize(ask.features) }),
    });
    if (!popups.has(windowId)) return "closed";
    if ((await windows().windowIds()).includes(windowId)) return "shown";
    if (!popups.has(windowId)) return "closed";
    console.warn("[ardia windows] a pop-up window did not open; its page goes to a tab");
  } catch (error) {
    if (!popups.has(windowId)) return "closed";
    console.warn(`[ardia windows] a pop-up window did not open: ${String((error as Error)?.message ?? error)}`);
  }
  popups.delete(windowId);
  letGoOfPrivateSession(windowId);
  return "failed";
}

export function requestPopupClose(windowId: string) {
  if (!popups.has(windowId)) return;
  void Promise.resolve(windows().requestClose(windowId)).catch(() => {});
}

export function closePopupWindow(windowId: string) {
  if (!popups.has(windowId)) return;
  void Promise.resolve(windows().closeWindow(windowId)).catch(() => {});
}

export function setPopupWindowTitle(windowId: string, title: string) {
  if (!popups.has(windowId)) return;
  void Promise.resolve(windows().setWindowTitle(windowId, title)).catch(() => {});
}
