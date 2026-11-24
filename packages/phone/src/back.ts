import { requireOptionalNativeModule } from "expo-modules-core";

type Subscription = { remove(): void };

export type TrayBackHandlers = {
  onProgress?: (progress: number, edge: "left" | "right") => void;
  onCancel?: () => void;
  onCommit?: () => void;
};

export type PredictiveBackHandlers = TrayBackHandlers;

type BackNative = {
  setTrayBackEnabled(enabled: boolean): void;
  addListener(event: "onBackProgress", listener: (event: { progress: number; edge: "left" | "right" }) => void): Subscription;
  addListener(event: "onBackCancel" | "onBackCommit", listener: () => void): Subscription;
};

const native = requireOptionalNativeModule<BackNative>("ArdiaPhoneBack");

export const TRAY_BACK_TRAVEL = 72;

type Claim = { handlers: PredictiveBackHandlers };

const claims: Claim[] = [];
let wired: Subscription | null = null;

const top = (): PredictiveBackHandlers | undefined => claims[claims.length - 1]?.handlers;

function sync() {
  if (!native) return;
  if (claims.length > 0 && !wired) {
    const subscriptions = [
      native.addListener("onBackProgress", ({ progress, edge }) => top()?.onProgress?.(progress, edge)),
      native.addListener("onBackCancel", () => top()?.onCancel?.()),
      native.addListener("onBackCommit", () => top()?.onCommit?.()),
    ];
    wired = { remove: () => subscriptions.forEach((subscription) => subscription.remove()) };
  }
  if (claims.length === 0 && wired) {
    wired.remove();
    wired = null;
  }
  native.setTrayBackEnabled(claims.length > 0);
}

export const predictiveBack = {
  isNative: () => native != null,
  claim: (handlers: PredictiveBackHandlers): Subscription => {
    const claim: Claim = { handlers };
    claims.push(claim);
    sync();
    return {
      remove() {
        const at = claims.indexOf(claim);
        if (at < 0) return;
        claims.splice(at, 1);
        sync();
      },
    };
  },
};

const trayListeners = new Set<TrayBackHandlers>();
let trayClaim: Subscription | null = null;

export const trayBack = {
  isNative: () => native != null,
  setEnabled: (enabled: boolean) => {
    if (enabled && !trayClaim) {
      trayClaim = predictiveBack.claim({
        onProgress: (progress, edge) => trayListeners.forEach((listener) => listener.onProgress?.(progress, edge)),
        onCancel: () => trayListeners.forEach((listener) => listener.onCancel?.()),
        onCommit: () => trayListeners.forEach((listener) => listener.onCommit?.()),
      });
    } else if (!enabled && trayClaim) {
      trayClaim.remove();
      trayClaim = null;
    }
  },
  listen: (handlers: TrayBackHandlers): Subscription => {
    if (!native) return { remove() {} };
    trayListeners.add(handlers);
    return { remove: () => trayListeners.delete(handlers) };
  },
};
