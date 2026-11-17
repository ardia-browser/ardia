import { requireOptionalNativeModule } from "expo-modules-core";

type Subscription = { remove(): void };

export type TrayBackHandlers = {
  onProgress?: (progress: number, edge: "left" | "right") => void;
  onCancel?: () => void;
  onCommit?: () => void;
};

type BackNative = {
  setTrayBackEnabled(enabled: boolean): void;
  addListener(event: "onBackProgress", listener: (event: { progress: number; edge: "left" | "right" }) => void): Subscription;
  addListener(event: "onBackCancel" | "onBackCommit", listener: () => void): Subscription;
};

const native = requireOptionalNativeModule<BackNative>("ArdiaPhoneBack");

export const TRAY_BACK_TRAVEL = 72;

export const trayBack = {
  isNative: () => native != null,
  setEnabled: (enabled: boolean) => native?.setTrayBackEnabled(enabled),
  listen: (handlers: TrayBackHandlers): Subscription => {
    if (!native) return { remove() {} };
    const subscriptions = [
      native.addListener("onBackProgress", ({ progress, edge }) => handlers.onProgress?.(progress, edge)),
      native.addListener("onBackCancel", () => handlers.onCancel?.()),
      native.addListener("onBackCommit", () => handlers.onCommit?.()),
    ];
    return { remove: () => subscriptions.forEach((subscription) => subscription.remove()) };
  },
};
