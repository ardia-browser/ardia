import { useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { Subscription } from "./pageTypes";
import { createSystemLookStore, type SystemLookNow } from "./systemLookRules";

type SystemLookNative = {
  systemLook?: () => SystemLookNow;
  addListener?: (eventName: "onSystemLookChange", listener: (now: SystemLookNow) => void) => Subscription;
};

const native = requireOptionalNativeModule<SystemLookNative>("ArdiaPhoneLook");
const nativeReads = Platform.OS === "android" && typeof native?.systemLook === "function";

const store = createSystemLookStore({
  read: () => (nativeReads ? native!.systemLook!() : null),
  readLater: async () => {
    const [reduceMotion, reduceTransparency] = await Promise.all([
      AccessibilityInfo.isReduceMotionEnabled().catch(() => false),
      Platform.OS === "ios" ? AccessibilityInfo.isReduceTransparencyEnabled().catch(() => false) : Promise.resolve(false),
    ]);
    return { reduceMotion, reduceTransparency };
  },
  watch: (changed) => {
    if (nativeReads && native?.addListener) {
      const subscription = native.addListener("onSystemLookChange", changed);
      return () => subscription.remove();
    }
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", () => store.refresh());
    const transparency = Platform.OS === "ios" ? AccessibilityInfo.addEventListener("reduceTransparencyChanged", () => store.refresh()) : null;
    return () => {
      motion.remove();
      transparency?.remove();
    };
  },
  onResume: (resumed) => {
    const subscription = AppState.addEventListener("change", (next) => next === "active" && resumed());
    return () => subscription.remove();
  },
});

export const systemLookNow = (): SystemLookNow => store.get();

export function useSystemLook(): SystemLookNow {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useSystemReduceMotion(): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get().reduceMotion);
}

export function useSystemReduceTransparency(): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get().reduceTransparency);
}
