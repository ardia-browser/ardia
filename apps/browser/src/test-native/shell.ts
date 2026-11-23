import type {
  AppEvent,
  BangListReply,
  CommandEvent,
  CrashReport,
  DiagnosticsSample,
  HardwareInfo,
  LaunchConfig,
  NativeDevtoolsEndpoint,
  OpenSurface,
  OpenWindowOptions,
  ShellNativeModules,
  SurfaceEvent,
  SurfaceItem,
  SystemInfo,
  SystemSignal,
  UserScriptsFolder,
  WindowEvent,
} from "@ardia/shell";
import { nativeEvents, unfaked } from "./events";
import { reportModule } from "./report";
import { telemetryLocalModule } from "./telemetryLocal";
import { windowGeometries, windowGeometryFakes } from "./windowGeometry";
import officialPin from "../../official-plugins.json";
import { hexOf, sha256 } from "../lib/sha256";
export { beginWindowControlTransition, finishStalledTransition, geometryWorld } from "./windowGeometry";

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
export const unreadableDocs = new Set<string>();
export const asyncExists = { on: false };
export const copiedDocs: [string, string][] = [];
export const refusedCopies = { on: false, of: new Set<string>() };
export const takenNames = new Set<string>();
export const syncedDocs: string[] = [];
export const refusedSyncs = { on: false };
export const linkedButUnsynced = { on: false };
export const heldCopies = { on: false, queue: [] as (() => void)[] };
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
  geometry: windowGeometries,
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
  ...windowGeometryFakes((id) => windows.open.has(id), (event) => shellEvents.emit("onWindowEvent", event)),
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
  takeHoverCounts: () => hoverCounts.take(),
  cancelFocusMove: () => Promise.resolve(),
  claimFocus: () => Promise.resolve(),
  pressesWithoutRelease: () => pressesWithoutRelease.count,
  takeFocusHandoffCounts: () => focusHandoffCounts.take(),
  pressRepeated: () => Promise.resolve(pressRepeated.earlier),
};

export const surfaces = {
  open: [] as OpenSurface[],
  bar: [] as SurfaceItem[],
  captures: false,
  chosen: [] as { id: string; path: number[] }[],
  performed: [] as { ref: string; windowId: string }[],
  dismissed: [] as string[],
  barHook: null as (() => void) | null,
  emit: (event: SurfaceEvent) => shellEvents.emit("onSurface", event),
};

function surfaceOf(id: string) {
  const found = surfaces.open.find((s) => s.id === id);
  if (!found) throw Object.assign(new Error(`There's no open menu ${id}.`), { code: "no_window" });
  return found;
}

const menus: Modules["ArdiaMenus"] = {
  addListener: shellEvents.addListener,
  openSurfaces: () => Promise.resolve(surfaces.open),
  capturePageMenus: (captures) => Promise.resolve(void (surfaces.captures = captures)),
  dismissSurface: async (id) => {
    surfaceOf(id);
    surfaces.dismissed.push(id);
    surfaces.open = surfaces.open.filter((s) => s.id !== id);
  },
  menuBar: async () => {
    surfaces.barHook?.();
    return surfaces.bar;
  },
  performMenuBarItem: async (ref, windowId) => {
    surfaces.performed.push({ ref, windowId });
    return "performed";
  },
  showMenu: () => Promise.resolve(null),
  updateMenu: () => Promise.resolve(),
  setMenuState: () => Promise.resolve(),
  setMenuBookmarks: () => Promise.resolve(),
  menuShortcuts: () => Promise.resolve([]),
  recordShortcut: () => Promise.resolve(null),
  cancelRecording: () => Promise.resolve(),
  mouseShortcutMonitor: () => Promise.resolve({ installed: false, installs: 0 }),
};

export const controlPeers = {
  chosen: [] as unknown[],
  chooseResult: { choice: -1, unshown: true } as { choice: number; unshown?: boolean },
  dismissed: [] as (string | null)[],
  answers: [] as [number, string][],
  approvals: [] as { key: string; name: string; signedBy: string; added: number; until?: number }[],
  revoked: [] as string[],
};

const dialogs: Modules["ArdiaDialogs"] = {
  choose: (options) => {
    controlPeers.chosen.push(options);
    return Promise.resolve(controlPeers.chooseResult);
  },
  confirm: () => Promise.resolve({ confirmed: false, suppressed: false }),
  dismissesShownOnly: true,
  dismissShownOnly: (key) => {
    controlPeers.dismissed.push(key);
    return Promise.resolve();
  },
  prompt: () => Promise.resolve(null),
  pickFiles: () => Promise.resolve([]),
  pickFolder: () => Promise.resolve(null),
};

const documents: Modules["ArdiaDocuments"] = {
  readDocument: (name) => (unreadableDocs.has(name) ? null : stagedDocs.get(name) ?? docs.get(name) ?? null),
  documentExists: (name) => {
    const exists = stagedDocs.has(name) || docs.has(name) || unreadableDocs.has(name);
    return asyncExists.on ? Promise.resolve(exists) : exists;
  },
  writeDocument: (name, contents) => {
    if (refusedWrites.on) throw new Error("write refused");
    if (refusedWrites.returnsFalse) return false as unknown as void;
    docs.set(name, contents);
    stagedDocs.delete(name);
    unreadableDocs.delete(name);
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
        unreadableDocs.delete(name);
        resolve();
      };
      if (heldSaves.on) heldSaves.queue.push(land);
      else land();
    }),
  documentSaved: () => (refusedWrites.on || refusedWrites.landingFails ? Promise.reject(new Error("save refused")) : Promise.resolve()),
  removeDocument: (name) => void (docs.delete(name), stagedDocs.delete(name), unreadableDocs.delete(name)),
  listDocuments: (prefix) => [...new Set([...docs.keys(), ...unreadableDocs])].filter((name) => name.startsWith(prefix)),
  syncDocument: (name) => {
    syncedDocs.push(name);
    if (!docs.has(name)) return Promise.reject(Object.assign(new Error("gone"), { code: "ERR_DOCUMENT_GONE" }));
    return refusedSyncs.on ? Promise.reject(new Error("sync refused")) : Promise.resolve();
  },
  createDocument: (name, contents) => {
    if (docs.has(name) || unreadableDocs.has(name) || takenNames.has(name)) return Promise.reject(Object.assign(new Error("exists"), { code: "ERR_DOCUMENT_EXISTS" }));
    if (refusedSaves.on) return Promise.reject(new Error("create refused"));
    if (linkedButUnsynced.on) {
      docs.set(name, contents);
      return Promise.reject(new Error("folder sync failed"));
    }
    return new Promise((resolve) => {
      const land = () => {
        docs.set(name, contents);
        resolve();
      };
      if (heldSaves.on) heldSaves.queue.push(land);
      else land();
    });
  },
  copyDocument: (name, copyName) => {
    copiedDocs.push([name, copyName]);
    if (refusedCopies.on || refusedCopies.of.has(name)) return Promise.reject(new Error("copy refused"));
    if (!unreadableDocs.has(name) && !docs.has(name)) return Promise.reject(Object.assign(new Error("nothing to copy"), { code: "ERR_DOCUMENT_GONE" }));
    const land = () => {
      if (unreadableDocs.has(name)) unreadableDocs.add(copyName);
      else if (docs.has(name)) docs.set(copyName, docs.get(name)!);
    };
    if (!heldCopies.on) return Promise.resolve(land());
    return new Promise<void>((resolve) => heldCopies.queue.push(() => (land(), resolve())));
  },
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
  devPointerSweep: () => Promise.resolve(null),
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

export const keychainReads = { values: new Map<string, string>(), errors: new Map<string, string>() };

const keychain: Modules["ArdiaKeychain"] = {
  get: () => Promise.resolve(null),
  read: (account) => {
    const reason = keychainReads.errors.get(account);
    if (reason !== undefined) return Promise.resolve({ status: "error", reason });
    const value = keychainReads.values.get(account);
    return Promise.resolve(value === undefined ? { status: "missing" } : { status: "ok", value });
  },
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
  devtoolsEndpoint: ((_connection: number): NativeDevtoolsEndpoint | Promise<NativeDevtoolsEndpoint> => ({ problem: "off" })) as ((connection: number) => NativeDevtoolsEndpoint | Promise<NativeDevtoolsEndpoint>) | null,
  devtoolsEndpointAsks: [] as number[],
  calls: [] as string[],
};
const controlEvents = nativeEvents();
export const emitControlRequest = (request: { connection: number; generation: number; line: string }) => controlEvents.emit("onRequest", request);
export const emitControlClose = (connection: number) => controlEvents.emit("onClose", { connection });
export const emitControlPeerAsk = (ask: { ask: number; name: string; signedBy: string; path: string; identifier: string; remember: boolean; deadline: number }) => controlEvents.emit("onPeerAsk", ask);
export const emitControlPeerAskEnded = (ask: number, outcome: string) => controlEvents.emit("onPeerAskEnded", { ask, outcome });
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
    controlSocket.calls.push("stop");
    controlSocket.running = false;
  },
  cutOff: () => (controlSocket.calls.push("cutOff"), true),
  reply: (connection, line, ticket) => {
    controlSocket.replies.push({ connection, line });
    if (ticket > 0) controlSocket.held.push(ticket);
    if (!controlSocket.holdWrites) writeHeldReplies();
  },
  broadcast: (connections, line) => void controlSocket.broadcasts.push({ connections, line }),
  answerPeer: (ask, outcome) => {
    controlPeers.answers.push([ask, outcome]);
    return Promise.resolve(true);
  },
  approvals: () => Promise.resolve({ approvals: [...controlPeers.approvals], doorbell: true }),
  revokeApproval: (key) => {
    controlPeers.revoked.push(key);
    const before = controlPeers.approvals.length;
    controlPeers.approvals = controlPeers.approvals.filter((a) => a.key !== key);
    return Promise.resolve(controlPeers.approvals.length !== before);
  },
  addListener: controlEvents.addListener,
};
Object.defineProperty(automation, "devtoolsEndpoint", {
  enumerable: true,
  get: () =>
    controlSocket.devtoolsEndpoint &&
    (async (connection: number) => {
      controlSocket.devtoolsEndpointAsks.push(connection);
      return controlSocket.devtoolsEndpoint!(connection);
    }),
});

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
  folders: [] as {
    name: string;
    status: "ok" | "missing" | "link" | "notFile" | "tooBig" | "unreadable";
    text?: string;
    folderId?: string;
    official?: boolean;
    legacy?: boolean;
    legacyHash?: string;
    candidateOnly?: boolean;
    candidate?: { folderId: string; text: string; legacyHash: string; version: string };
    ignoresUserFolder?: boolean;
  }[],
  pinned: undefined as undefined | null | { name: string; version: string; folderId: string }[],
  officialArtifacts: {} as Record<string, string>,
  officialFetchResults: {} as Record<string, { ok: false; code: "offline" | "failed" | "verify" | "cancelled" | "unsupported"; reason: string }>,
  officialFetchGate: null as null | Promise<void>,
  officialFetchLog: [] as string[],
  officialCancels: [] as string[],
  promotes: [] as { name: string; folderId: string; approved: string }[],
  promoteResult: null as null | { ok: false; reason: string },
  starts: [] as { name: string; run: string[]; memoryMB: number; network: boolean; folderId: string; approved: string; page: boolean; runtime?: "js" | "process"; entry?: string }[],
  fetches: [] as { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowedHosts: string[] }[],
  fetchResult: null as null | { ok: true; status: number; statusText: string; url: string; headers: Record<string, string>; body: string } | { ok: false; reason: string },
  storage: {} as Record<string, string>,
  storageWrites: [] as { name: string; text: string }[],
  storageResult: null as null | { ok: false; reason: string },
  storageReadResult: null as null | { status: "error"; reason: string },
  files: {} as Record<string, string>,
  fileReads: [] as { name: string; folderId: string; approved: string; path: string }[],
  stops: [] as { name: string; run: number; graceMs: number }[],
  replies: [] as { name: string; run: number; line: string }[],
  events: [] as { name: string; run: number; line: string }[],
  removed: [] as string[],
  removeFolderIds: [] as (string | null)[],
  links: [] as { name: string; folderId: string; approved: string; version: string | null; programs: { name: string; path: string; afterUpdate?: string[][] }[] }[],
  unlinks: [] as { name: string; programs: string[]; remove: boolean }[],
  sweeps: [] as string[][],
  afterUpdateQuitStops: null as null | { consent: string; exitedOnTerm: number; killed: number },
  afterUpdateQuitConsent: null as null | string,
  legacyInstalled: [] as string[],
  registry: null as null | { claims: Record<string, string>; failClosed: boolean; legacyOwners: string[] },
  linkResult: null as null | { ok: false; reason?: string; stale?: true } | { ok: true; linked: string[]; refused: Record<string, string>; binDir: string; adopted: boolean },
  startResult: null as null | { ok: false; reason: string },
  removeGate: null as null | Promise<void>,
  stopGate: null as null | Promise<void>,
  startGate: null as null | Promise<void>,
  listGate: null as null | Promise<void>,
  listFails: false,
  nextRun: 0,
};
function derivedRegistry() {
  const claims: Record<string, string> = {};
  const declared: Record<string, string[]> = {};
  for (const folder of pluginHost.folders) {
    if (!folder.official || !folder.text) continue;
    try {
      const doc = JSON.parse(folder.text) as { programs?: unknown; contributes?: { programs?: unknown } };
      const programs = (doc.contributes?.programs ?? doc.programs) as { name?: unknown; claim?: unknown }[] | undefined;
      declared[folder.name] = (Array.isArray(programs) ? programs : []).flatMap((p) => (typeof p.name === "string" ? [p.name] : []));
      for (const p of Array.isArray(programs) ? programs : []) if (p.claim === true && typeof p.name === "string") claims[p.name] ??= folder.name;
    } catch {}
  }
  for (const plugin of (officialPin as { plugins: { name: string; reservedPrograms?: string[] }[] }).plugins)
    for (const program of plugin.reservedPrograms ?? []) if (declared[plugin.name]?.includes(program)) claims[program] ??= plugin.name;
  return { claims, failClosed: false, legacyOwners: [] };
}
export const officialLegacyHash = (text: string) => hexOf(sha256(`${text}\u0000bundled`));
export function officialPinnedFromPin(): { name: string; version: string; folderId: string }[] {
  return (officialPin as { plugins: { name: string; version: string; artifacts: Record<string, { sha256?: string | null }> }[] }).plugins.flatMap((p) => {
    const sha = p.artifacts["macos-arm64"]?.sha256;
    return sha ? [{ name: p.name, version: p.version, folderId: `official-${sha}` }] : [];
  });
}
const pinnedNow = () => (pluginHost.pinned === undefined ? officialPinnedFromPin() : pluginHost.pinned);
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
  remove: async (name, official, folderId) => (await pluginHost.removeGate, pluginHost.removeFolderIds.push(folderId), pluginHost.removed.push(official ? `official:${name}` : name), (pluginHost.folders = pluginHost.folders.filter((f) => f.name !== name)), { ok: true }),
  linkPrograms: async (spec) => {
    pluginHost.links.push({ ...spec, programs: spec.programs.map((p) => ({ ...p })) });
    if (pluginHost.linkResult) return pluginHost.linkResult;
    return { ok: true, linked: spec.programs.map((p) => p.name), refused: {}, binDir: "/home/.local/bin", adopted: false };
  },
  unlinkPrograms: async (name, programs, remove) => (pluginHost.unlinks.push({ name, programs: [...programs], remove }), { ok: true }),
  sweepPrograms: async (active) => void pluginHost.sweeps.push([...active]),
  takeAfterUpdateQuitStops: async () => {
    const stops = pluginHost.afterUpdateQuitStops ?? { consent: "", exitedOnTerm: 0, killed: 0 };
    pluginHost.afterUpdateQuitStops = null;
    return stops;
  },
  setAfterUpdateQuitConsent: (consent) => void (pluginHost.afterUpdateQuitConsent = consent),
  legacyProgramsInstalled: async () => [...pluginHost.legacyInstalled],
  programRegistry: async () => pluginHost.registry ?? derivedRegistry(),
  revealLog: () => {},
  revealFolder: () => {},
  devSnapshotPage: async () => false,
  officialPlugins: async () => pinnedNow(),
  fetchOfficial: async (name) => {
    pluginHost.officialFetchLog.push(name);
    await pluginHost.officialFetchGate;
    if (pluginHost.officialCancels.includes(name)) {
      pluginHost.officialCancels = pluginHost.officialCancels.filter((n) => n !== name);
      return { ok: false, code: "cancelled", reason: "Cancelled." };
    }
    const refused = pluginHost.officialFetchResults[name];
    if (refused) return refused;
    const text = pluginHost.officialArtifacts[name];
    const pinned = pinnedNow()?.find((p) => p.name === name);
    if (text === undefined || !pinned) return { ok: false, code: "offline", reason: "The Internet connection appears to be offline." };
    const candidate = { folderId: pinned.folderId, text, legacyHash: officialLegacyHash(text), version: pinned.version };
    const at = pluginHost.folders.findIndex((f) => f.name === name);
    if (at < 0) pluginHost.folders.push({ name, status: "missing", official: true, candidateOnly: true, candidate });
    else pluginHost.folders[at] = { ...pluginHost.folders[at]!, candidate };
    return { ok: true, candidate };
  },
  cancelOfficialFetch: (name) => void pluginHost.officialCancels.push(name),
  promoteOfficial: async (name, folderId, approved) => {
    pluginHost.promotes.push({ name, folderId, approved });
    if (pluginHost.promoteResult) return pluginHost.promoteResult;
    const at = pluginHost.folders.findIndex((f) => f.name === name);
    const candidate = at < 0 ? undefined : pluginHost.folders[at]!.candidate;
    if (!candidate || candidate.folderId !== folderId) return { ok: false, reason: "Its download is gone. Try again." };
    pluginHost.folders[at] = { name, status: "ok", official: true, folderId, text: candidate.text, legacyHash: candidate.legacyHash };
    return { ok: true };
  },
  hostFetch: async (spec) => {
    pluginHost.fetches.push({ ...spec, headers: { ...spec.headers }, allowedHosts: [...spec.allowedHosts] });
    return pluginHost.fetchResult ?? { ok: true, status: 200, statusText: "OK", url: spec.url, headers: {}, body: "" };
  },
  storageRead: async (name) => {
    if (pluginHost.storageReadResult) return pluginHost.storageReadResult;
    const text = pluginHost.storage[name];
    return text === undefined ? { status: "missing" } : { status: "ok", text };
  },
  storageWrite: async (name, text) => {
    pluginHost.storageWrites.push({ name, text });
    if (pluginHost.storageResult) return pluginHost.storageResult;
    pluginHost.storage[name] = text;
    return { ok: true };
  },
  readPluginFile: async (name, folderId, approved, path) => {
    pluginHost.fileReads.push({ name, folderId, approved, path });
    const text = pluginHost.files[`${name}/${path}`];
    return text === undefined ? { ok: false, reason: "the file wasn't found" } : { ok: true, text };
  },
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

export const hoverCounts = {
  pending: {} as Record<string, Record<string, number>>,
  take() {
    const taken = this.pending;
    this.pending = {};
    return taken;
  },
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
