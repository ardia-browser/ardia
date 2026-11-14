import { callMain } from "./bridge";

export function announceListener(module: string, event: string): void {
  if (module === "ArdiaShell" && event === "onOpenURLs") void callMain("ArdiaLaunchLinks", "listening").catch(() => undefined);
}
