import { nativeModule, type LaunchConfig } from "@ardia/shell";

let config: LaunchConfig | null = null;

const current = (): LaunchConfig => (config ??= nativeModule("ArdiaApp").launchConfig());

export const configDirectory = (): string => current().configDirectory;

export const isTestInstance = (): boolean => current().testInstance;

export const recoveredStart = (): boolean => current().recoveredStart === true;

export const feedbackURLOverride = (): string | null => current().feedbackURL ?? null;

export const switchOverride = (name: string): boolean | undefined => current().switches[name];

const testValue = (key: string): string | null => current().test[key] ?? null;

export const introStartDelayMs = (): number => {
  const asked = Number(testValue("introStartDelayMs"));
  return Number.isFinite(asked) && asked > 0 ? asked : 0;
};

export const syncTurnOnRequested = (): boolean => testValue("syncTurnOn") === "1";

export const downloadFlightFromPageCentre = (): boolean => testValue("downloadFlightFromPage") === "1";

export const devTestValue = (key: string): string | null => (typeof __DEV__ !== "undefined" && __DEV__ ? testValue(key) : null);

export const reloadLaunchConfigForTests = () => void (config = null);

export const httpPagesPort = (): string | null => {
  const port = testValue("httpPages");
  return port && /^\d+$/.test(port) ? port : null;
};
