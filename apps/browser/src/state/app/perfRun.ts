import { t } from "../../lib/uiLanguage";
if (!(globalThis as { expo?: unknown }).expo) {
  try {
    const { TurboModuleRegistry } = require("react-native") as typeof import("react-native");
    (TurboModuleRegistry.get(t(`ExpoModulesCore`)) as { installModules?: () => void } | null)?.installModules?.();
  } catch {}
}
const modules = (globalThis as { expo?: { modules?: Record<string, Record<string, (...a: unknown[]) => unknown>> } }).expo?.modules;
const documents = modules?.ArdiaDocuments;

export const perfProbeOptions: string | null = (() => {
  try {
    const info = modules?.ArdiaApp?.systemInfo?.() as { isolatedInstance?: boolean } | undefined;
    if (!info?.isolatedInstance || typeof documents?.readDocument !== "function") return null;
    const file = documents.readDocument("perf-probe");
    return typeof file === "string" ? file : null;
  } catch {
    return null;
  }
})();

export const isPerfRun = perfProbeOptions !== null;
