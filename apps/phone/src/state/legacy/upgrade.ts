import { Platform } from "react-native";
import { canStartWithoutImport, legacyImport } from "../../platform/legacy";
import { browserDatabase, browserDatabaseIsDurable } from "../store/database";
import { runLegacyImport, startWithoutImport, type ImportDeps, type ImportResult } from "./importer";

let running: Promise<ImportResult> | null = null;

const deps = (): ImportDeps => ({
  legacy: legacyImport,
  db: browserDatabase(),
  durable: browserDatabaseIsDurable(),
  platform: Platform.OS === "ios" ? "ios" : "android",
  log: (line) => console.log(line),
});

async function importOnce(): Promise<ImportResult> {
  try {
    return await runLegacyImport(deps());
  } catch {
    console.log("ardia-legacy failed reason=write");
    return { kind: "failed", reason: "write" };
  }
}

export function importOldApp(): Promise<ImportResult> {
  running ??= importOnce().finally(() => {
    running = null;
  });
  return running;
}

export const offersStartWithout = canStartWithoutImport;

export async function startWithoutOldApp(): Promise<boolean> {
  try {
    return await startWithoutImport(deps());
  } catch {
    console.log("ardia-legacy start-fresh failed");
    return false;
  }
}
