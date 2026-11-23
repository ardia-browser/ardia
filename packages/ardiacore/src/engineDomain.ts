import { nativeModule } from "./nativeModules";

export type EngineInfo = {
  pid: number;
  dataDirectory: string;
  engine: string;
  chromiumVersion: string;
  liveBrowsers: number;
  popupWindows: number;
  chromeWindows: number;
  focus?: string;
  pictureInPictureCloses?: string;
};

export type EngineComponent = {
  id: string;
  name: string;
  version: string;
  state:
    | "new" | "checking" | "canUpdate" | "downloading" | "decompressing" | "patching" | "updating" | "updated"
    | "upToDate" | "updateError" | "run" | "unknown";
};

export type EngineTask = {
  id: number;
  type:
    | "browser" | "gpu" | "zygote" | "utility" | "renderer" | "extension" | "guest" | "plugin" | "sandboxHelper"
    | "dedicatedWorker" | "sharedWorker" | "serviceWorker" | "unknown";
  title: string;
  killable: boolean;
  cpu: number;
  processors: number;
  memory: number;
  gpuMemory: number;
  tabIds: (string | null)[];
  pid?: number;
};

export type ChildProcessCpu = {
  pid: number;
  started: number;
  cpuMs: number;
};

export type SystemState = {
  onBattery: boolean;
  batteryLevel: number | null;
  lowPowerMode: boolean;
  memoryPressure: "normal" | "warning" | "critical";
  physicalMemory: number;
};

export const WIDEVINE_COMPONENT_ID = "oimompecagnajdejgnnjijobebaeigek";

export type BatterySaverMode = "on" | "off" | "default";

export type BatterySaverState = { state: number; active: boolean };

export type MemorySaverMode = "moderate" | "balanced" | "maximum";

export type MemorySaverRequest = { state?: "on" | "off"; aggressiveness?: MemorySaverMode; sites?: string[] };

export type MemorySaverState = { state: "on" | "off"; aggressiveness: MemorySaverMode; active: boolean; sites: string[]; invalid: string[] };

export const inputIdleSeconds = () => nativeModule("ArdiaEngine").inputIdleSeconds();

type CliServer = { connections: number; generation: number; file: string; reason?: string };

export type PopupProtectedMedia = { family: "widevine" | "playready" | "fairplay" | "other" | "none"; listed: boolean; epoch: string };

export type CursorRestore = { hidden: boolean; epoch: string };

export type HoverLostEpisode = {
  reason: "halfActive" | "staleMenu" | "notKeyOrMain" | "coveredByView" | "responderLost" | "coveredByWindow";
  trigger: "move" | "click";
  keyWindow: string;
  mainWindow: string;
  preventKey: boolean;
  canKey: boolean;
  windowMain: boolean;
  halfActive: boolean;
  appActive: boolean;
  runningActive: boolean;
  frontmost: boolean;
  menuActive: boolean;
  overPage: boolean;
  cover: "none" | "reactNative" | "chromium" | "other";
  coverClear: boolean;
  responder?: "none" | "window" | "otherWindow" | "page" | "control";
  coverWindow?: string;
  healed: boolean;
  healWorked: boolean | null;
  healRefused?: string;
  healRefusedLast?: string;
  healRefusedWindow?: string;
  otherWindowClicks?: number;
  endedBy: "hover" | "heal" | "appInactive" | "windowClosed";
  seconds: number;
  episode: number;
  epoch: string;
};

export type WindowUnpaintedRecord = {
  window: "regular" | "private";
  trigger: "seen" | "key";
  seen: boolean;
  occlusion: "visible" | "occluded";
  overruled: boolean;
  appActive: boolean;
  windows: number;
  views: number;
  unpainted: number;
  reasons: number;
  epoch: string;
};

export type PressLoopLongReport = { loop: string; inner: string; open: boolean; buttonsHeld: boolean; epoch: string };

export type CliTabTarget = { targetId: string | null; pageGeneration: number };

type CliDragsEnded = { ownerGone: number; debuggerUnowned: number; nativeRefused: number; sourceGone?: number };

type CliWindowlessPages = { given: number; missed: number };

type CliTokenCommands = Partial<Record<"accessibility" | "browser" | "dom" | "emulation" | "fetch" | "input" | "network" | "page" | "runtime" | "storage" | "target" | "other", number>>;

export type CliControlStatus = { dragsEnded?: CliDragsEnded; windowlessPages?: CliWindowlessPages; tokenCommands?: CliTokenCommands } & (
  | { state: "external" }
  | ({ state: "off" | "starting" } & CliServer)
  | ({ state: "on"; port: number } & CliServer)
);
