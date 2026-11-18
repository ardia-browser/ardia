import { requireNativeModule, type EventSubscription } from "expo-modules-core";

type HighContrastShell = {
  isHighContrast?: () => Promise<boolean>;
  addListener?: (eventName: "onAppEvent", listener: (event: { type?: string; on?: unknown } | null) => void) => EventSubscription;
};

const shell = () => requireNativeModule<HighContrastShell>("ArdiaShell");

export const highContrastOn = (): Promise<boolean> =>
  Promise.resolve(shell().isHighContrast?.() ?? false).then(
    (on) => on === true,
    () => false,
  );

export function onHighContrast(listener: (on: boolean) => void): () => void {
  const subscription = shell().addListener?.("onAppEvent", (event) => {
    if (event?.type === "highContrast" && typeof event.on === "boolean") listener(event.on);
  });
  return () => subscription?.remove();
}
