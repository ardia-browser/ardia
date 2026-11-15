import type { Desktop, PowerReading } from "../../../expo-windows/src/engine/domains/calling";
import { callMain, callMainSync, mainModules } from "../bridge";

const DIALOGS = "ArdiaDialogs";
const FILES = "ArdiaLinuxImport";
const SIGNALS = "ArdiaSystemSignals";

const orNull = <Value>(answer: Value | null | undefined): Value | null => answer ?? null;

export function nativeDesktop(): Desktop | undefined {
  const modules = mainModules();
  if (!modules[DIALOGS] || !modules[FILES]) return undefined;
  return {
    saveFile: async ({ name, extension, kind, message }) => orNull(await callMain<string>(DIALOGS, "saveFile", name, extension, kind, message)),
    pickFolder: async (prompt) => orNull(await callMain<string>(DIALOGS, "pickFolder", null, prompt)),
    readText: async (folder, path, largest) => orNull(await callMain<string>(FILES, "readTextWithin", folder, path, largest)),
    readBase64: async (folder, path, largest) => orNull(await callMain<string>(FILES, "readBase64Within", folder, path, largest)),
    power: () => orNull(callMainSync<PowerReading>(SIGNALS, "powerState")),
    every: (ms, run) => void setInterval(run, ms),
  };
}
