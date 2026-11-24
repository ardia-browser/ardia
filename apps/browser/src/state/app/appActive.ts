import { onAppEvent } from "../../platform/app";
import { onWindowEvent } from "../../platform/windows";

const resignedKey = new Set<string>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  onAppEvent((e) => {
    if (e.type === "windowResignedKey") resignedKey.add(e.windowId);
  });
  onWindowEvent((e) => {
    if (e.type === "focus" || e.type === "close") resignedKey.delete(e.id);
  });
}

export function startAppActive() {
  listen();
}

export function isWindowResignedKey(windowId: string): boolean {
  listen();
  return resignedKey.has(windowId);
}

export function deferBlurCancel(windowId: string, isEditing: () => boolean, cancel: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (!isEditing() && !isWindowResignedKey(windowId)) cancel();
  }, 50);
}
