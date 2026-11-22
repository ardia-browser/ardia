import { hostSupports, invokeHost, reportHostError, type ArdiaHost } from "./host.ts";
import { fillsScreen, isWindowFrame, type WorkArea } from "./windowFrame.ts";
import { noteMaximized } from "../../browser/src/state/windows/captionRegions.ts";

export const WINDOW_STATE_METHOD = "ArdiaShell.windowState";
const WINDOW_STATE_EVENT = "windowState";

type ShellWindow = {
  screen?: WorkArea;
  outerWidth: number;
  outerHeight: number;
  addEventListener(type: "resize", listener: () => void): void;
  requestAnimationFrame(callback: () => void): number;
};

export function reportedMaximized(payload: unknown): boolean | undefined {
  if (!payload || typeof payload !== "object" || !("maximized" in payload)) return undefined;
  const { maximized } = payload as { maximized: unknown };
  return typeof maximized === "boolean" ? maximized : undefined;
}

const stateWindowId = (payload: unknown): unknown => (payload && typeof payload === "object" && "windowId" in payload ? (payload as { windowId: unknown }).windowId : undefined);

function followEngineState(host: ArdiaHost, windowId: string, note: typeof noteMaximized) {
  let heard = false;
  host.onEvent((module, event, payload) => {
    if (module !== "ArdiaShell" || event !== WINDOW_STATE_EVENT || stateWindowId(payload) !== windowId) return;
    const maximized = reportedMaximized(payload);
    if (maximized === undefined) return;
    heard = true;
    note(windowId, maximized);
  });
  void invokeHost<unknown>(WINDOW_STATE_METHOD, { args: [windowId] }, host).then((state) => {
    const maximized = reportedMaximized(state);
    if (!heard && maximized !== undefined) note(windowId, maximized);
  }, reportHostError);
}

function followFrame(host: ArdiaHost, windowId: string, shell: ShellWindow, note: typeof noteMaximized) {
  let latest = 0;
  let scheduled = false;
  const read = () => {
    scheduled = false;
    const asked = ++latest;
    void invokeHost<unknown>("ArdiaShell.windowFrame", { args: [windowId] }, host).then((frame) => {
      if (asked !== latest) return;
      note(windowId, fillsScreen(isWindowFrame(frame) ? frame : [0, 0, shell.outerWidth, shell.outerHeight], shell.screen));
    }, reportHostError);
  };
  read();
  shell.addEventListener("resize", () => {
    if (scheduled) return;
    scheduled = true;
    shell.requestAnimationFrame(read);
  });
}

export function followWindowMaximized(host: ArdiaHost, windowId: string, shell: ShellWindow | null = typeof window === "undefined" ? null : window, note = noteMaximized) {
  if (hostSupports(WINDOW_STATE_METHOD, host)) return followEngineState(host, windowId, note);
  if (shell) followFrame(host, windowId, shell, note);
}
