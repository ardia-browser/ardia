import type { ArdiaHost } from "./host";

type FrameScheduler = (callback: () => void) => unknown;

export function announceShellPainted(host: Pick<ArdiaHost, "invoke" | "bootstrap">, nextFrame: FrameScheduler = requestAnimationFrame) {
  return new Promise<void>((resolve) => {
    nextFrame(() => nextFrame(() => {
      host.invoke("ArdiaShell.shellPainted", { args: [host.bootstrap.windowId] }).catch((error: unknown) => {
        console.warn("[ardia linux] the window's curtain stays until its deadline", error);
      }).finally(resolve);
    }));
  });
}
