import { DeviceEventEmitter, TurboModuleRegistry, type EmitterSubscription, type TurboModule } from "react-native";

export type MaterialCapabilities = {
  build: number;
  systemBackdrop: boolean;
  systemBackdropSupported: boolean;
  inWindowBlur: boolean;
  gradient: boolean;
  background: boolean;
};

export type MaterialPath = { path: string; reason: string; step?: string };

export type MaterialsNative = {
  capabilities(): MaterialCapabilities;
  applyWindowMaterial(windowId: string, material: string): Promise<MaterialPath>;
  clearWindowMaterial(windowId: string): Promise<boolean>;
  probeBlur(): Promise<MaterialPath>;
  probeGradient(): Promise<MaterialPath>;
};

let capabilities: MaterialCapabilities | null | undefined;

export function materialCapabilities(): MaterialCapabilities | null {
  if (capabilities !== undefined) return capabilities;
  capabilities = null;
  try {
    const native = TurboModuleRegistry.get<TurboModule & MaterialsNative>("ArdiaMaterials");
    const answer = native?.capabilities?.();
    if (answer && typeof answer === "object" && typeof answer.build === "number") capabilities = answer;
  } catch {
    capabilities = null;
  }
  return capabilities;
}

export const nativeWindowMaterial = () => materialCapabilities() !== null;

export const nativeBlur = () => materialCapabilities()?.inWindowBlur === true;

export const nativeGradient = () => materialCapabilities()?.gradient === true;

export function gradientDrawsNow(): boolean {
  if (!nativeGradient()) return false;
  try {
    const native = TurboModuleRegistry.get<TurboModule & MaterialsNative>("ArdiaMaterials");
    const draws = native?.capabilities?.().gradient === true;
    if (!draws && capabilities) capabilities = { ...capabilities, gradient: false };
    return draws;
  } catch {
    return false;
  }
}

export const GRADIENT_FAILED_EVENT = "ArdiaMaterials:gradientFailed";

const failureListeners = new Set<() => void>();
let failures: EmitterSubscription | null = null;

function gradientFailed() {
  if (capabilities) capabilities = { ...capabilities, gradient: false };
  for (const listener of [...failureListeners]) listener();
}

export function onGradientFailure(listener: () => void): () => void {
  failureListeners.add(listener);
  failures ??= DeviceEventEmitter.addListener(GRADIENT_FAILED_EVENT, gradientFailed);
  return () => {
    failureListeners.delete(listener);
    if (failureListeners.size > 0) return;
    failures?.remove();
    failures = null;
  };
}

export function followGradientFailure(onFailed: () => void): () => void {
  const stop = onGradientFailure(onFailed);
  if (!gradientDrawsNow()) onFailed();
  return stop;
}
