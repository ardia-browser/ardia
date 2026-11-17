import { invokeHost, reportHostError, type ArdiaHost } from "./host.ts";
import { fillsScreen, isWindowFrame, type WorkArea } from "./windowFrame.ts";
import { noteMaximized } from "../../browser/src/state/windows/captionRegions.ts";

type ShellWindow = {
  screen?: WorkArea;
  outerWidth: number;
  outerHeight: number;
  addEventListener(type: "resize", listener: () => void): void;
  requestAnimationFrame(callback: () => void): number;
};

export function followWindowMaximized(host: ArdiaHost, windowId: string, shell: ShellWindow | null = typeof window === "undefined" ? null : window, note = noteMaximized) {
  if (!shell) return;
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
