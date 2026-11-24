import type { ArdiaHost } from "./host";
import { consentToken } from "../../browser/src/state/telemetry/client";
import { warnFor } from "../../browser/src/state/telemetry/logs";

type FrameScheduler = (callback: () => void) => unknown;

export function announceShellPainted(host: Pick<ArdiaHost, "invoke" | "bootstrap">, nextFrame: FrameScheduler = requestAnimationFrame) {
  const consent = consentToken();
  return new Promise<void>((resolve) => {
    nextFrame(() => nextFrame(() => {
      host.invoke("ArdiaShell.shellPainted", { args: [host.bootstrap.windowId] }).catch((error: unknown) => {
        warnFor(consent, "[ardia linux] the window's curtain stays until its deadline", error);
      }).finally(resolve);
    }));
  });
}
