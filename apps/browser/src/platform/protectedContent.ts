import { requireOptionalNativeModule } from "expo-modules-core";

export type ProtectedContentComponent = "absent" | "checking" | "downloading" | "installed" | "failed";

export type ProtectedContentState = {
  enabled: boolean;
  component: ProtectedContentComponent;
  version: string | null;
  playsNow: boolean;
  restartNeeded: boolean;
};

type LinuxEngine = {
  protectedContent?: () => ProtectedContentState;
  setProtectedContent: (on: boolean) => Promise<ProtectedContentState>;
  addListener(event: "onProtectedContent", listener: (state: ProtectedContentState) => void): { remove(): void };
};

const engine = requireOptionalNativeModule<LinuxEngine>("ArdiaLinuxEngine");

export const hasProtectedContentSetting = typeof engine?.protectedContent === "function";

export const protectedContentState = (): ProtectedContentState | null => (hasProtectedContentSetting ? (engine?.protectedContent?.() ?? null) : null);

export const setProtectedContent = (on: boolean) => engine?.setProtectedContent(on) ?? Promise.resolve(null);

export const onProtectedContent = (listener: (state: ProtectedContentState) => void) => engine?.addListener("onProtectedContent", listener) ?? { remove: () => {} };
