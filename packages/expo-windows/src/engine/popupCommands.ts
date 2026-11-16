import { callPage } from "./pages";
import { isPopupWindowId, popupWindowInfo, requestPopupClose } from "./popupWindows";

type Listener = (payload: unknown) => void;
type PageCall = { method: string; args?: Record<string, unknown> };
type Command = { command?: unknown; windowId?: unknown };

const MENU_PICK = "menu.pick";

const PAGE_CALLS: Record<string, PageCall> = {
  reload: { method: "reload" },
  forceReload: { method: "forceReload" },
  stop: { method: "stopLoading" },
  back: { method: "goBack" },
  forward: { method: "goForward" },
  zoomIn: { method: "zoomStep", args: { direction: 1 } },
  zoomOut: { method: "zoomStep", args: { direction: -1 } },
  zoomReset: { method: "zoomStep", args: { direction: 0 } },
  print: { method: "print" },
  printWithSystemDialog: { method: "runPageCommand", args: { name: "systemPrint" } },
  devTools: { method: "showDevTools", args: { panel: "toggle" } },
  toggleDevTools: { method: "showDevTools", args: { panel: "toggle" } },
  inspectElements: { method: "showDevTools", args: { panel: "inspect" } },
  javaScriptConsole: { method: "showDevTools", args: { panel: "console" } },
};

const settled = new WeakSet<object>();

function runInPopup(windowId: string, command: unknown) {
  const popup = popupWindowInfo(windowId);
  if (!popup || typeof command !== "string") return;
  if (command === "closeTab") return requestPopupClose(windowId);
  const call = Object.hasOwn(PAGE_CALLS, command) ? PAGE_CALLS[command] : undefined;
  if (call) void callPage(popup.pageKey, call.method, call.args ?? {}).catch(() => {});
}

function settledInPopup(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const { command, windowId } = payload as Command;
  if (command === MENU_PICK || typeof windowId !== "string" || !isPopupWindowId(windowId)) return false;
  if (settled.has(payload)) return true;
  settled.add(payload);
  runInPopup(windowId, command);
  return true;
}

export function listenedOnWindows(module: string, event: string, listener: Listener): Listener {
  if (module !== "ArdiaMenus" || event !== "onCommand") return listener;
  return (payload) => {
    if (!settledInPopup(payload)) listener(payload);
  };
}
