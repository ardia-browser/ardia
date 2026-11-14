import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { note } from "./log";
import { configDirectory, dataDirectory, isBackground } from "./paths";

export type LaunchConfig = {
  dataDirectory: string | null;
  configDirectory: string;
  background: boolean;
  isolated: boolean;
  testInstance: boolean;
  instance: Record<string, string>;
  switches: Record<string, boolean>;
  trace: string[];
  test: Record<string, string>;
  feedbackURL: string | null;
};

const INSTANCE_KEYS = [
  "jsLocation", "chromiumSwitches", "downloadsDir", "updateFeed", "allowAudio", "allowOcclusion", "releaseNotes",
  "cliHome", "cliBinDir", "cliUrl", "syncFolder", "sharedFolders", "importSourceDir", "importSafariHome",
];

const TEST_KEYS = [
  "keychain", "keychainHiddenReads", "keychainFail", "safeStorageAnswer", "reauth", "bluetoothChooser",
  "externalProtocolNoLaunch", "externalProtocolApp", "mediaRouteProvider", "systemMediaPermission", "applyProfileGate", "contextMenu",
  "loginsDelay", "loginsReleaseAfter", "cdpTabsVisible",
  "pipSelfTest", "pipHover", "fakeFullScreenMs", "shadersKeyWindow", "peekStrict", "importSecret", "importDiaBundleId", "importDiaWindows",
  "cliInstallScript", "legacySource", "legacyCrashAfter", "bangsUrl", "onboarding", "whatsNew", "telemetry",
  "liveMock", "calendarFixture", "appMenu", "appDialog", "loginsTimeout", "externalAppLaunch", "nativeDragRefused", "passwordHelper",
];

const KEYS_WHOSE_VALUES_HOLD_COMMAS = [
  "chromiumSwitches", "downloadsDir", "updateFeed", "cliHome", "cliBinDir", "cliUrl", "syncFolder", "sharedFolders", "importSourceDir",
  "importSafariHome", "importSecret", "cliInstallScript", "legacySource", "bangsUrl", "liveMock", "passwordHelper",
];

const TRACE_AREAS = ["visibility", "pip", "pipZoom", "trafficLights", "profileGate", "keys", "menus"];
const TEST_ONLY_INSTANCE_KEYS = ["updateFeed", "importSourceDir", "importSafariHome"];

export const truthy = (value: string | undefined): boolean => !!value && value !== "0" && value !== "off" && value !== "false";

function keyedEntries(text: string, known: string[], variable: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (!text) return entries;
  const pieces: string[] = [];
  let previousKey = "";
  for (const piece of text.split(",")) {
    const head = piece.split("=")[0]!.trim();
    if (pieces.length && !known.includes(head) && KEYS_WHOSE_VALUES_HOLD_COMMAS.includes(previousKey)) {
      pieces[pieces.length - 1] += `,${piece}`;
      continue;
    }
    pieces.push(piece);
    previousKey = head;
  }
  for (const piece of pieces) {
    const equals = piece.indexOf("=");
    const key = (equals < 0 ? piece : piece.slice(0, equals)).trim();
    if (!key) continue;
    if (!known.includes(key)) {
      note("launch", `${variable}: unknown key ${key} ignored`);
      continue;
    }
    entries[key] = equals < 0 ? "1" : piece.slice(equals + 1).trim();
  }
  return entries;
}

function switchEntries(text: string): Record<string, boolean> {
  const entries: Record<string, boolean> = {};
  for (const piece of text.split(",")) {
    const parts = piece.split("=");
    if (parts.length !== 2) continue;
    const name = parts[0]!.trim();
    const value = parts[1]!.trim();
    if (!name) continue;
    if (value === "on" || value === "1" || value === "true") entries[name] = true;
    else if (value === "off" || value === "0" || value === "false") entries[name] = false;
  }
  return entries;
}

function traceAreas(text: string): string[] {
  const areas = new Set<string>();
  for (const piece of text.split(",")) {
    const area = piece.trim();
    if (!area) continue;
    if (TRACE_AREAS.includes(area)) areas.add(area);
    else note("launch", `ARDIA_TRACE: unknown area ${area} ignored`);
  }
  return [...areas];
}

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const realDataFolders = () => [join(homedir(), ".local/share/ardia"), join(homedir(), ".config/ardia"), join(homedir(), ".config/Ardia")].map(realOrSelf);

function testGateRefusal(customData: string | null): string {
  if (!customData) return "no scratch ARDIA_DATA_DIR";
  const chosen = realOrSelf(customData);
  const clash = realDataFolders().find((real) => chosen === real || chosen.startsWith(`${real}/`));
  return clash ? `ARDIA_DATA_DIR is inside the real data folder ${clash}` : "";
}

function read(): LaunchConfig {
  const env = process.env;
  const customData = env.ARDIA_DATA_DIR ? resolve(env.ARDIA_DATA_DIR) : null;
  const refusal = testGateRefusal(customData);
  const testInstance = refusal === "";
  const config: LaunchConfig = {
    dataDirectory: customData,
    configDirectory: testInstance && env.ARDIA_CONFIG_DIR ? resolve(env.ARDIA_CONFIG_DIR) : configDirectory(),
    background: isBackground(),
    isolated: customData !== null,
    testInstance,
    instance: keyedEntries(env.ARDIA_INSTANCE ?? "", INSTANCE_KEYS, "ARDIA_INSTANCE"),
    switches: switchEntries(env.ARDIA_SWITCHES ?? ""),
    trace: traceAreas(env.ARDIA_TRACE ?? ""),
    test: keyedEntries(env.ARDIA_TEST ?? "", TEST_KEYS, "ARDIA_TEST"),
    feedbackURL: env.ARDIA_FEEDBACK_URL || null,
  };
  try {
    mkdirSync(config.configDirectory, { recursive: true });
    mkdirSync(dataDirectory(), { recursive: true });
  } catch {}
  if (testInstance) return config;
  let asked = config.trace.length > 0 || Object.keys(config.test).length > 0 || !!env.ARDIA_CONFIG_DIR;
  for (const key of TEST_ONLY_INSTANCE_KEYS)
    if (key in config.instance) {
      delete config.instance[key];
      asked = true;
    }
  config.trace = [];
  config.test = {};
  if (asked) note("launch", `ARDIA_TEST, ARDIA_TRACE, ARDIA_CONFIG_DIR and test-only ARDIA_INSTANCE keys ignored: not a test instance (${refusal})`);
  return config;
}

let shared: LaunchConfig | null = null;

export const launchConfig = (): LaunchConfig => (shared ??= read());
export const testValue = (key: string): string | undefined => launchConfig().test[key];
export const testFlag = (key: string): boolean => truthy(testValue(key));
export const tracing = (area: string): boolean => launchConfig().trace.includes(area);
export const instanceFlag = (key: string): boolean => truthy(launchConfig().instance[key]);
