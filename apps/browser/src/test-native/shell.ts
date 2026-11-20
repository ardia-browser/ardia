import type {
  AppEvent,
  BangListReply,
  CommandEvent,
  CrashReport,
  DiagnosticsSample,
  HardwareInfo,
  LaunchConfig,
  OpenWindowOptions,
  ShellNativeModules,
  SystemInfo,
  SystemSignal,
  UserScriptsFolder,
  WindowEvent,
} from "@ardia/shell";
import { nativeEvents, unfaked } from "./events";
import { reportModule } from "./report";
import { telemetryLocalModule } from "./telemetryLocal";

type Modules = ShellNativeModules;

type UserScriptsHost = {
  watching: boolean[];
  writes: unknown[];
  status: string | null;
  change: (() => void) | null;
  read(): Promise<UserScriptsFolder>;
};

const testGlobals = globalThis as { acTestUserScripts?: UserScriptsHost };

export const docs = new Map<string, string>();
export const stagedDocs = new Map<string, string>();
export const heldSaves = { on: false, queue: [] as (() => void)[] };
export const refusedSaves = { on: false };
export const refusedWrites = { on: false, returnsFalse: false, landingFails: false };
export const bangListServer: { reply: ((etag: string | null) => Promise<BangListReply>) | null } = { reply: null };
export const appInfo: Partial<SystemInfo> = { appVersion: "1.0" };
export const interfaceScaleNative = { scale: 1, applied: [] as number[], refuses: false, asked: [] as number[] };
const clampedScale = (scale: number) => Math.min(1.5, Math.max(0.8, Math.round(scale * 100) / 100));
export const diagnostics: { crashReports: CrashReport[]; hardware: HardwareInfo; sample: DiagnosticsSample } = {
  crashReports: [],
  hardware: { chip: "Apple M1", gpu: "Apple M1", memoryGB: 16, displays: 1, maxScale: 2, hardwareDecode: { av1: false, vp9: true, hevc: true, h264: true } },
  sample: { footprintMB: 500, freeDiskGB: 100 },
};
export const launch: LaunchConfig = {
  dataDirectory: null,
  configDirectory: "/config",
  background: false,
  isolated: false,
  testInstance: false,
  instance: {},
  switches: {},
  trace: [],
  test: {},
};

export type FakeWindow = OpenWindowOptions & { title?: string; trafficLightsCenter?: [number, number] | null; trafficLightsTrailing?: boolean };
const shellEvents = nativeEvents();
export const windows = {
  closeRequests: [] as string[],
  open: new Map<string, FakeWindow>(),
  closed: [] as string[],
  focused: null as string | null,
  emit: (event: WindowEvent) => shellEvents.emit("onWindowEvent", event),
};
export const emitAppEvent = (event: AppEvent) => shellEvents.emit("onAppEvent", event);
export const emitCommand = (event: CommandEvent) => shellEvents.emit("onCommand", event);
export const emitOpenURLs = (urls: string[], pointer?: [number, number], source?: { bundleId: string | null; appName: string | null }) =>
  shellEvents.emit("onOpenURLs", { urls, pointer, source });

const shell: Modules["ArdiaShell"] = {
  addListener: shellEvents.addListener,
  copyText: () => {},
  readText: () => Promise.resolve(""),
  startDictation: () => {},
  fetchBangList: (etag) => (bangListServer.reply ? bangListServer.reply(etag) : unfaked("ArdiaShell", "fetchBangList")),
  setAppearance: () => Promise.resolve(),
  isDarkAppearance: () => Promise.resolve(false),
};

const windowsModule: Modules["ArdiaAppWindows"] & { requestClose(id: string): Promise<void> } = {
  windowCornerRadius: () => 19,
  drawnWindowCornerRadius: () => 19,
  addListener: shellEvents.addListener,
  openWindow: (id, options) => {
    windows.open.set(id, { ...options });
    if (options.focus !== false) windows.focused = id;
    return Promise.resolve();
  },
  requestClose: (id) => {
    windows.closeRequests.push(id);
    return Promise.resolve();
  },
  closeWindow: (id) => {
    windows.open.delete(id);
    windows.closed.push(id);
    if (windows.focused === id) windows.focused = null;
    return Promise.resolve();
  },
  focusWindow: (id) => {
    windows.focused = id;
    return Promise.resolve();
  },
  animateWindowClose: () => Promise.resolve(),
  restoreFullScreen: () => Promise.resolve(),
  setTrafficLightsCenter: (id, center, trailing) => {
    const window = windows.open.get(id);
    if (window) Object.assign(window, { trafficLightsCenter: center, trafficLightsTrailing: trailing });
    return Promise.resolve();
  },
  setWindowTitle: (id, title) => {
    const window = windows.open.get(id);
    if (window) window.title = title;
    return Promise.resolve();
  },
  windowIds: () => Promise.resolve([...windows.open.keys()]),
  watchSidebarEdge: () => Promise.resolve(),
  dragPreviewBegin: () => Promise.resolve(),
  dragPreviewPage: () => Promise.resolve(),
  dragPreviewUpdate: () => Promise.resolve(),
  dragPreviewCancel: () => Promise.resolve(),
  dragPreviewPlaceholder: () => Promise.resolve(),
  dragPreviewEnd: () => Promise.resolve(),
  raiseView: () => Promise.resolve(),
  windowFrame: () => Promise.resolve(null),
  frameCornerRadius: () => Promise.resolve(0),
  replyToTerminate: () => Promise.resolve(),
};

export const pressesWithoutRelease = { count: 0 };
export const focusHandoffCounts = {
  pending: {} as Record<string, Record<string, number>>,
  take() {
    const taken = this.pending;
    this.pending = {};
    return taken;
  },
};
export const pressRepeated: { earlier: { landedOn: string; ms: number } | null } = { earlier: null };

const focus: Modules["ArdiaFocus"] = {
  setSwitcherCapture: () => Promise.resolve(),
  setDragEscapeCapture: () => Promise.resolve(),
  saveKeyResponder: () => Promise.resolve(0),
  restoreKeyResponder: () => Promise.resolve(false),
  discardKeyResponder: () => Promise.resolve(),
  takeEditKeyAcks: () => editKeyAcks.take(),
  takeInputSourceKeys: () => inputSourceKeys.take(),
  switcherPointerMoved: () => true,
  cancelFocusMove: () => Promise.resolve(),
  claimFocus: () => Promise.resolve(),
  pressesWithoutRelease: () => pressesWithoutRelease.count,
  takeFocusHandoffCounts: () => focusHandoffCounts.take(),
  pressRepeated: () => Promise.resolve(pressRepeated.earlier),
};

const menus: Modules["ArdiaMenus"] = {
  addListener: shellEvents.addListener,
  showMenu: () => Promise.resolve(null),
  updateMenu: () => Promise.resolve(),
  setMenuState: () => Promise.resolve(),
  setMenuBookmarks: () => Promise.resolve(),
  menuShortcuts: () => Promise.resolve([]),
  recordShortcut: () => Promise.resolve(null),
  cancelRecording: () => Promise.resolve(),
};

const dialogs: Modules["ArdiaDialogs"] = {
  confirm: () => Promise.resolve({ confirmed: false, suppressed: false }),
  dismissesShownOnly: true,
  dismissShownOnly: () => Promise.resolve(),
  prompt: () => Promise.resolve(null),
  pickFiles: () => Promise.resolve([]),
  pickFolder: () => Promise.resolve(null),
};

const documents: Modules["ArdiaDocuments"] = {
  readDocument: (name) => stagedDocs.get(name) ?? docs.get(name) ?? null,
  writeDocument: (name, contents) => {
    if (refusedWrites.on) throw new Error("write refused");
    if (refusedWrites.returnsFalse) return false as unknown as void;
    docs.set(name, contents);
    stagedDocs.delete(name);
  },
  saveDocument: (name, contents) =>
    new Promise((resolve, reject) => {
      stagedDocs.set(name, contents);
      if (refusedSaves.on) return reject(new Error("save refused"));
      const land = () => {
        try {
          docs.set(name, contents);
        } finally {
          if (stagedDocs.get(name) === contents) stagedDocs.delete(name);
        }
        resolve();
      };
      if (heldSaves.on) heldSaves.queue.push(land);
      else land();
    }),
  documentSaved: () => (refusedWrites.on || refusedWrites.landingFails ? Promise.reject(new Error("save refused")) : Promise.resolve()),
  removeDocument: (name) => void (docs.delete(name), stagedDocs.delete(name)),
};

const app: Modules["ArdiaApp"] = {
  interfaceScale: () => interfaceScaleNative.scale,
  interfaceScaleRange: () => [0.8, 1.5],
  setInterfaceScale: (scale) => {
    interfaceScaleNative.asked.push(scale);
    if (interfaceScaleNative.refuses) return Promise.reject(new Error("refused"));
    interfaceScaleNative.scale = clampedScale(scale);
    interfaceScaleNative.applied.push(interfaceScaleNative.scale);
    return Promise.resolve(interfaceScaleNative.scale);
  },
  setWindowActivity: () => Promise.resolve(),
  share: () => Promise.resolve(),
  shareText: () => Promise.resolve(),
  shareVia: () => Promise.resolve(),
  isInDock: () => Promise.resolve(false),
  addToDock: () => Promise.resolve(false),
  appIcons: () => Promise.resolve([]),
  appIcon: () => Promise.resolve("default"),
  setAppIcon: () => Promise.resolve(),
  systemInfo: () => ({ ...appInfo }) as SystemInfo,
  openExternalURL: () => Promise.resolve(false),
  launchConfig: () => structuredClone(launch),
  playIntroMusic: () => Promise.resolve(),
  setIntroMusicMuted: () => Promise.resolve(),
  stopIntroMusic: () => Promise.resolve(),
  crashReports: (since) => Promise.resolve(diagnostics.crashReports.filter((r) => (r.fileTime ?? r.time) > since)),
  hardwareInfo: () => Promise.resolve(structuredClone(diagnostics.hardware)),
  diagnosticsSample: () => Promise.resolve({ ...diagnostics.sample }),
};

const updater: Modules["ArdiaUpdater"] = {
  updaterState: () => Promise.resolve({ available: false }),
  checkForUpdates: () => Promise.resolve(),
  setAutomaticUpdateChecks: () => Promise.resolve(),
  setAutomaticUpdateDownloads: () => Promise.resolve(),
  setUpdateChannel: () => Promise.resolve(),
};

const notificationEvents = nativeEvents();
const notifications: Modules["ArdiaNotifications"] = {
  addListener: notificationEvents.addListener,
  notificationPermission: () => Promise.resolve("notDetermined"),
  requestNotificationPermission: () => Promise.resolve(false),
  postNotification: (options) => Promise.resolve({ id: options.id, icon: "none" }),
  removeNotifications: () => Promise.resolve(),
  openNotificationSettings: () => Promise.resolve(),
};

const location: Modules["ArdiaLocation"] = {
  locationPermission: () => Promise.resolve("notDetermined"),
  requestLocationPermission: () => Promise.resolve("notDetermined"),
  openLocationSettings: () => Promise.resolve(),
  devLocationRequests: () => Promise.resolve(0),
};

const scriptingEvents = nativeEvents();
const scripting: Modules["ArdiaScripting"] = {
  addListener: scriptingEvents.addListener,
  setScriptState: () => Promise.resolve(),
  replyToScript: () => Promise.resolve(),
};

const dev: Modules["ArdiaDev"] = {
  devCrash: () => Promise.resolve(),
  devBlockMain: (ms) => Promise.resolve(ms),
  devRenderIntroMusic: () => Promise.resolve(null),
  devRunAppleScript: () => Promise.resolve({ ok: false, error: "no AppleScript in tests" }),
  devSnapshotWindow: () => Promise.resolve(false),
  devSetPointer: () => Promise.resolve(false),
  devSetMouseButtons: () => Promise.resolve(false),
  devSidebarEdgePointer: () => Promise.resolve(false),
  devSidebarEdgeStats: () => Promise.resolve({}),
  devHoverStats: () => Promise.resolve({}),
  devMenuCommand: () => Promise.resolve(),
  devTypeKeys: () => Promise.resolve([]),
  devKeyEquivalent: () => Promise.resolve({ handledBy: "none" }),
  devClick: () => Promise.resolve({}),
  devShortcutRecording: () => Promise.resolve(false),
  devReceiveURLsWhenDetached: () => {},
  devOpenURLDeliveries: async () => [],
  devURLDelivery: () => Promise.resolve({}),
};

const system: Modules["ArdiaSystem"] = {
  isDefaultBrowser: () => Promise.resolve(false),
  setAsDefaultBrowser: () => Promise.resolve(false),
  launchAtLoginStatus: () => Promise.resolve("notRegistered"),
  setLaunchAtLogin: () => Promise.resolve(),
  fileExists: () => false,
  openFile: () => Promise.resolve(false),
  revealFile: () => Promise.resolve(false),
  moveToTrash: () => Promise.resolve(false),
  fileIcon: () => Promise.resolve(null),
  runningAppIcon: () => Promise.resolve(null),
  hapticTick: () => {},
  setThinScrollBars: () => Promise.resolve(),
};

const calendarEvents = nativeEvents();
const calendar: Modules["ArdiaCalendar"] = {
  addListener: calendarEvents.addListener,
  authorizationStatus: () => "notDetermined",
  requestAccess: () => Promise.resolve({ granted: false, status: "notDetermined", error: null, responsible: "self", ms: 0 }),
  calendars: () => Promise.resolve([]),
  events: () => Promise.resolve([]),
};

const keychain: Modules["ArdiaKeychain"] = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(true),
  delete: () => Promise.resolve(true),
};

const translate: Modules["ArdiaTranslate"] = {
  available: false,
  userLanguages: () => ["en"],
  languageName: (identifier) => identifier,
  detect: () => Promise.resolve(null),
  status: () => Promise.resolve("unsupported"),
  supportedLanguages: () => Promise.resolve([]),
  prepare: () => Promise.resolve(),
  translate: (_source, _target, texts) => Promise.resolve(texts),
  translateBlocks: (_source, _target, blocks) => Promise.resolve(blocks),
  open: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
};

const magnifyArea: Modules["ArdiaMagnifyArea"] = { devMagnify: () => unfaked("ArdiaMagnifyArea", "devMagnify") };
const fileDrop: Modules["ArdiaFileDrop"] = {
  devDrag: () => unfaked("ArdiaFileDrop", "devDrag"),
  devLastFileDrag: () => Promise.resolve([]),
};


const cliEvents = nativeEvents();
const cli: Modules["ArdiaCli"] = {
  installedVersion: () => null,
  canInstallUnattended: () => false,
  install: () => Promise.resolve({ ok: false, appVersion: appInfo.appVersion ?? "", error: "no installs in tests", lines: [] }),
  addListener: cliEvents.addListener,
};

const noUserScripts: UserScriptsHost = { watching: [], writes: [], status: null, change: null, read: async () => ({ state: "empty" }) };
const userScriptsHost = () => testGlobals.acTestUserScripts ?? noUserScripts;
const userScripts: Modules["ArdiaUserScripts"] = {
  watch: (on) => void userScriptsHost().watching.push(on),
  read: () => userScriptsHost().read(),
  readStatus: async () => userScriptsHost().status,
  writeStatus: async (json) => {
    userScriptsHost().status = json;
    userScriptsHost().writes.push(JSON.parse(json));
  },
  addListener: (_name, listener) => {
    userScriptsHost().change = listener;
    return { remove() {} };
  },
};

export const configFolder = { files: new Map<string, string>(), stamps: new Map<string, string>(), watched: [] as string[][], schemaWrites: [] as Record<string, string>[], arming: null as Promise<void> | null };
const configEvents = nativeEvents();
export const emitConfigChange = () => configEvents.emit("onChange", {});
const config: Modules["ArdiaConfig"] = {
  addListener: configEvents.addListener,
  readFile: (name) => {
    const text = configFolder.files.get(name);
    const stamp = configFolder.stamps.get(name);
    const read = text === undefined ? ({ status: "missing" } as const) : ({ status: "ok", text } as const);
    return stamp === undefined ? read : { ...read, stamp };
  },
  watch: (names) => {
    configFolder.watched.push(names);
    return configFolder.arming ?? Promise.resolve();
  },
  writeSchemas: (files) => {
    configFolder.schemaWrites.push(files);
    return Promise.resolve([]);
  },
};

export const controlSocket = {
  generation: 0,
  running: false,
  holdWrites: false,
  held: [] as number[],
  replies: [] as { connection: number; line: string }[],
  broadcasts: [] as { connections: number[]; line: string }[],
};
const controlEvents = nativeEvents();
export const emitControlRequest = (request: { connection: number; generation: number; line: string }) => controlEvents.emit("onRequest", request);
export const emitControlClose = (connection: number) => controlEvents.emit("onClose", { connection });
export function writeHeldReplies() {
  const tickets = controlSocket.held.splice(0);
  if (tickets.length) controlEvents.emit("onWritten", { tickets });
}
const automation: Modules["ArdiaAutomation"] = {
  start: async () => {
    if (!controlSocket.running) controlSocket.generation++;
    controlSocket.running = true;
    return { state: "on", generation: controlSocket.generation, path: "/data/ArdiaControl.sock" };
  },
  stop: async () => {
    controlSocket.running = false;
  },
  reply: (connection, line, ticket) => {
    controlSocket.replies.push({ connection, line });
    if (ticket > 0) controlSocket.held.push(ticket);
    if (!controlSocket.holdWrites) writeHeldReplies();
  },
  broadcast: (connections, line) => void controlSocket.broadcasts.push({ connections, line }),
  addListener: controlEvents.addListener,
};

export const systemSignals = {
  idleThresholds: [] as number[],
  holdsIncomingLinks: false,
  hooksStamp: null as string | null,
  approvedDownloadFolders: [] as string[],
  moves: [] as { path: string; folder: string }[],
  moveResult: { ok: false, reason: "notADownload" } as { ok: true; path: string } | { ok: false; reason: string },
};
const systemSignalEvents = nativeEvents();
export const emitSystemSignal = (signal: SystemSignal) => systemSignalEvents.emit("onSystemSignal", signal);
const systemSignalsModule: Modules["ArdiaSystemSignals"] = {
  watchIdle: (thresholds) => void (systemSignals.idleThresholds = [...thresholds]),
  holdsIncomingLinks: () => systemSignals.holdsIncomingLinks,
  setHoldIncomingLinks: (hold, hooksStamp) => void Object.assign(systemSignals, { holdsIncomingLinks: hold, hooksStamp }),
  setApprovedDownloadFolders: (folders) => void (systemSignals.approvedDownloadFolders = [...folders]),
  moveCompletedDownload: async (path, folder) => (systemSignals.moves.push({ path, folder }), systemSignals.moveResult),
  devPost: async (name) => (emitSystemSignal({ type: name === "willSleep" ? "sleep" : "wake" }), true),
  addListener: systemSignalEvents.addListener,
};

export const pluginHost = {
  folders: [] as { name: string; status: "ok" | "missing" | "link" | "notFile" | "tooBig" | "unreadable"; text?: string; folderId?: string; bundled?: boolean; replacesBundled?: boolean; ignoresUserFolder?: boolean }[],
  starts: [] as { name: string; run: string[]; memoryMB: number; network: boolean; folderId: string; approved: string; page: boolean }[],
  stops: [] as { name: string; run: number; graceMs: number }[],
  replies: [] as { name: string; run: number; line: string }[],
  events: [] as { name: string; run: number; line: string }[],
  removed: [] as string[],
  links: [] as { name: string; folderId: string; approved: string; version: string | null; programs: { name: string; path: string; afterUpdate?: string[][] }[]; adopt: boolean }[],
  unlinks: [] as { name: string; programs: string[]; remove: boolean }[],
  sweeps: [] as string[][],
  legacyInstalled: false,
  linkResult: null as null | { ok: false; reason?: string; stale?: true } | { ok: true; linked: string[]; refused: Record<string, string>; binDir: string; adopted: boolean },
  startResult: null as null | { ok: false; reason: string },
  removeGate: null as null | Promise<void>,
  stopGate: null as null | Promise<void>,
  startGate: null as null | Promise<void>,
  listGate: null as null | Promise<void>,
  listFails: false,
  nextRun: 0,
};
const pluginEvents = nativeEvents();
export const emitPluginLine = (line: { name: string; run: number; line: string }) => pluginEvents.emit("onLine", line);
export const emitPluginExit = (exit: { name: string; run: number; status: number | null; signal: number | null; overMemory: boolean }) => pluginEvents.emit("onExit", exit);
const plugins: Modules["ArdiaPlugins"] = {
  folder: () => "/config/plugins",
  list: async () => {
    await pluginHost.listGate;
    if (pluginHost.listFails) throw new Error("the plugins folder couldn't be listed");
    return pluginHost.folders.map((f) => ({ ...f }));
  },
  start: async (spec) => {
    pluginHost.starts.push({ ...spec, run: [...spec.run] });
    if (pluginHost.startResult) return pluginHost.startResult;
    const run = ++pluginHost.nextRun;
    await pluginHost.startGate;
    return { ok: true, run, pid: 1000 + run };
  },
  stop: async (name, run, graceMs) => void (pluginHost.stops.push({ name, run, graceMs }), await pluginHost.stopGate),
  reply: (name, run, line) => void pluginHost.replies.push({ name, run, line }),
  event: (name, run, line) => void pluginHost.events.push({ name, run, line }),
  call: (name, run, line) => void pluginHost.events.push({ name, run, line }),
  remove: async (name) => (await pluginHost.removeGate, pluginHost.removed.push(name), (pluginHost.folders = pluginHost.folders.filter((f) => f.name !== name)), { ok: true }),
  linkPrograms: async (spec) => {
    pluginHost.links.push({ ...spec, programs: spec.programs.map((p) => ({ ...p })) });
    if (pluginHost.linkResult) return pluginHost.linkResult;
    return { ok: true, linked: spec.programs.map((p) => p.name), refused: {}, binDir: "/home/.local/bin", adopted: false };
  },
  unlinkPrograms: async (name, programs, remove) => (pluginHost.unlinks.push({ name, programs: [...programs], remove }), { ok: true }),
  sweepPrograms: async (active) => void pluginHost.sweeps.push([...active]),
  legacyProgramsInstalled: async () => pluginHost.legacyInstalled,
  revealLog: () => {},
  revealFolder: () => {},
  devSnapshotPage: async () => false,
  addListener: pluginEvents.addListener,
};

export const shellNativeModules: Modules = {
  ArdiaShell: shell,
  ArdiaAppWindows: windowsModule,
  ArdiaFocus: focus,
  ArdiaMenus: menus,
  ArdiaDialogs: dialogs,
  ArdiaDocuments: documents,
  ArdiaApp: app,
  ArdiaUpdater: updater,
  ArdiaNotifications: notifications,
  ArdiaLocation: location,
  ArdiaScripting: scripting,
  ArdiaDev: dev,
  ArdiaSystem: system,
  ArdiaCalendar: calendar,
  ArdiaKeychain: keychain,
  ArdiaGlassEffect: { isLiquidGlass: () => false },
  ArdiaDockSelection: { iconTheme: () => Promise.resolve(null), iconAccent: () => Promise.resolve(null) },
  ArdiaInlineCompletion: { complete: () => Promise.resolve(0), copyFieldAs: () => Promise.resolve() },
  ArdiaTranslate: translate,
  ArdiaMagnifyArea: magnifyArea,
  ArdiaPeekStage: { devState: () => Promise.resolve([]), devPageFrames: () => Promise.resolve([]) },
  ArdiaFileDrop: fileDrop,
  ArdiaCli: cli,
  ArdiaUserScripts: userScripts,
  ArdiaConfig: config,
  ArdiaAutomation: automation,
  ArdiaPlugins: plugins,
  ArdiaSystemSignals: systemSignalsModule,
  ArdiaTelemetryLocal: telemetryLocalModule,
  ArdiaReport: reportModule,
};

export const inputSourceKeys = {
  pending: 0,
  take() {
    const taken = this.pending;
    this.pending = 0;
    return taken;
  },
};

export const editKeyAcks = {
  pending: {} as Record<string, number>,
  take() {
    const taken = this.pending;
    this.pending = {};
    return taken;
  },
};
