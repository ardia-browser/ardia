import { hostSupports, type ArdiaHost } from "./host.ts";
import { isLinuxUtility } from "./session.ts";

export const CLOSE_DRAIN_METHOD = "ArdiaShell.beginWindowCloseDrain";

export const closesWithoutDrain = (host: ArdiaHost) => !hostSupports(CLOSE_DRAIN_METHOD, host);

export const otherOpenWindows = (windowOrder: readonly string[], windowId: string) =>
  windowOrder.filter((id) => id !== windowId && !isLinuxUtility(id)).length;

type NativeCloseHooks = {
  host: ArdiaHost;
  windowId: string;
  leading: () => boolean;
  windowOrder: () => readonly string[];
  end: () => void;
};

export function endSessionAtNativeClose({ host, windowId, leading, windowOrder, end }: NativeCloseHooks): () => void {
  if (!closesWithoutDrain(host) || isLinuxUtility(windowId) || !host.onBeforeClose) return () => {};
  return host.onBeforeClose(() => {
    if (leading() && otherOpenWindows(windowOrder(), windowId) === 0) end();
  });
}
