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
  pictureInPictureGestures?: string;
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
  trigger: "move" | "click" | "key";
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
  coverView?: string;
  coverClearView?: string;
  coverSize?: "none" | "small" | "large" | "full";
  responder?: "none" | "window" | "otherWindow" | "page" | "control";
  coverWindow?: string;
  healed: boolean;
  healWorked: boolean | null;
  healRefused?: string;
  healRefusedLast?: string;
  healRefusedWindow?: string;
  otherWindowClicks?: number;
  endedBy: "hover" | "heal" | "appInactive" | "windowClosed" | "quit";
  seconds: number;
  episode: number;
  serial?: number;
  epoch: string;
};

export type WindowUnpaintedRecord = {
  window: "regular" | "private";
  trigger: "seen" | "key" | "profileSwitch";
  seen: boolean;
  occlusion: "visible" | "occluded";
  overruled: boolean;
  appActive: boolean;
  windows: number;
  views: number;
  unpainted: number;
  reasons: number;
  heldMs?: number;
  webkitViews?: number;
  webkitOnTop?: boolean;
  stillUnpainted?: number;
  stillReasons?: number;
  epoch: string;
};

export type PressLoopLongReport = { loop: string; inner: string; open: boolean; buttonsHeld: boolean; epoch: string };

export type CliTabTarget = { targetId: string | null; pageGeneration: number };

type CliDragsEnded = { ownerGone: number; debuggerUnowned: number; nativeRefused: number; sourceGone?: number };

type CliWindowlessPages = { given: number; missed: number };

type CliTokenCommands = Partial<Record<"accessibility" | "ardia" | "browser" | "dom" | "emulation" | "fetch" | "input" | "network" | "page" | "runtime" | "storage" | "target" | "other", number>>;

type CliPageSignals = { consoleReads: number; focusedOrigins: number; originMismatches: number; hitTests: number; hitTestsFailed: number; hitTestsCancelled: number; remoteFrames: number; occluded: number };

type CliConsoleRing = { captured: number; evicted: number; reads: number; rings: number };

export type CliConsoleEntry = { seq: number; level: "warning" | "error"; exception: boolean; mainFrame: boolean; text: string; source: string; line: number; time: number };

export type CliConsoleDelta = { entries: CliConsoleEntry[]; generation: number; reset: boolean; next: number; last: number; dropped: number; withheld: number; errors: number; more: boolean };

export type CliEngineTotals = Record<
  | "sessionsOpened" | "sessionsRefused" | "sessionCommands" | "sessionEvents" | "sessionEventsCut" | "snapshots" | "snapshotsFailed" | "snapshotRefs" | "snapshotsModal" | "occludedRefs"
  | "settles" | "settlesTimedOut" | "settleMs" | "hitTests" | "clicks" | "clicksBlocked" | "dismissFound" | "refsRebound" | "refsStale" | "screenshots" | "screenshotsHidden" | "screenshotsFailed" | "cancelled" | "clicksUnverified" | "refused" | "liveSessions",
  number
>;

export type CliDevToolsOpened = { session: number; targetId: string; scope: "full" | "inspect" };

export type CliDevToolsReply = { result: Record<string, unknown>; offscreen?: boolean };

export type CliDevToolsEvent = { session: number; method?: string; params?: Record<string, unknown>; sessionId?: string; cut?: boolean; bytes?: number; dropped?: number; droppedByHost?: number; closed?: string };

export type CliBox = [number, number, number, number];

export type CliRef = { ref: string; role: string; name?: string; value?: string; box: CliBox; depth: number; frame?: number; disabled?: boolean; checked?: boolean | "mixed"; expanded?: boolean; focused?: boolean; offscreen?: boolean; fp?: string; node?: number; occludedBy?: string; blocker?: boolean; redacted?: boolean };

export type CliSnapshot = {
  generation: number;
  viewport: [number, number];
  scope: "page" | "modal";
  modal?: { ref: string; name: string };
  focused?: string;
  refs: CliRef[];
  truncated: boolean;
  counts: { nodes: number; frames: number; interactive: number; occluded: number; framesTruncated: boolean };
  occlusion?: number | "unavailable";
};

export type CliSettle = {
  settled: boolean;
  waitedMs: number;
  timedOut?: boolean;
  waitingOn?: "navigation" | "network" | "idle" | "frame" | "quiet";
  navigations: { pending: number; seen: number };
  network: { inflight: number; longLived: number; seen: number; tracked: boolean };
  idle: "idle" | "timeout" | "skipped" | "unavailable" | "pending";
  frame: "committed" | "timeout" | "skipped" | "pending";
  loops: number;
  quietAtMs?: number;
  idleMs: number;
  frameMs: number;
};

export type CliHitRef = { ref: string; role: string; name: string; box: CliBox; frame?: number };

export type CliHitTest = {
  point: [number, number];
  verified: boolean;
  hit?: CliHitRef;
  target?: CliHitRef;
  rebound?: boolean;
  reason?: "unverified" | "moved";
  blocked: boolean;
  blocker?: CliHitRef;
  dismiss?: CliHitRef & { kind: "close" | "reject" | "accept" };
  choices?: (CliHitRef & { kind: "close" | "reject" | "accept" })[];
};

export type CliClick = CliHitTest & { clicked: boolean };

export type CliScreenshot = { data: string; format: "png" | "jpeg"; width: number; height: number; hidden: boolean; freshFrame: boolean };

export type CliControlStatus = { dragsEnded?: CliDragsEnded; windowlessPages?: CliWindowlessPages; tokenCommands?: CliTokenCommands; pageSignals?: CliPageSignals; consoleRing?: CliConsoleRing; engineCli?: CliEngineTotals } & (
  | { state: "external" }
  | ({ state: "off" | "starting" } & CliServer)
  | ({ state: "on"; port: number } & CliServer)
);
