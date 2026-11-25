import type { AppIcon, CleanedTitle, CleanedUrl, CrashReport, DiagnosticsSample, HardwareInfo, IntroMusicCues, LaunchConfig, ShareAnchor, SystemInfo } from "../app";
import type { ControlApprovals, ControlPeerAnswer, ControlPeerAsk, ControlPeerOutcome, ControlRequest, ControlSocketStatus, FileArmClaim, FileArmResult, FileArmRow, FileArmSpec, NativeDevtoolsEndpoint, PlacedDownload } from "../automation";
import type { CliInstallResult } from "../cli";
import type { CommandEvent } from "../commands";
import type { ConfigFileRead } from "../config";
import type { Click, ClickResult, KeyPress, KeyPressResult, KeyTiming, PointerSweep, PointerSweepResult, SidebarEdgeStats } from "../dev";
import type { ChooseOptions, ConfirmOptions, PromptOptions } from "../dialogs";
import type { BangListReply } from "../documents";
import type { InlineWrite } from "../inlineCompletion";
import type { AppEvent, AppearanceMode, OpenURLSource } from "../lifecycle";
import type { CalendarAccessRequest, CalendarAuthorization, KeychainReadResult, SystemCalendar, SystemCalendarEvent } from "../live";
import type { LocationPermission } from "../location";
import type { MenuBookmarkKey, MenuItem, MenuPickEvent, MenuState, OpenSurface, SurfaceEvent, SurfaceItem } from "../menus";
import type { NotificationOptions, NotificationPermission, NotificationPostResult, NotificationResponse } from "../notifications";
import type { PeekRect } from "../peekStage";
import type { OfficialFetchProgress, OfficialFetchResult, OfficialPinned, PluginAfterUpdateQuitStops, PluginExit, PluginFetchResult, PluginFetchSpec, PluginFileReadResult, PluginFolderEntry, PluginLine, PluginProgramRegistry, PluginProgramsResult, PluginProgramsSpec, PluginRemoveResult, PluginStartResult, PluginStartSpec, PluginStorageReadResult } from "../plugins";
import type { ReportEvent, UploadReply } from "../report";
import type { ScriptCommand, ScriptState } from "../scripting";
import type { DevDragAction, DevDragPayload, LaunchAtLoginStatus, MagnifyUpdate, MenuShortcut, ShortcutModifier } from "../system";
import type { MovedDownload, SystemSignal } from "../systemSignals";
import type { TelemetryLocalExport, TelemetryLocalStats } from "../telemetryLocal";
import type { UpdateChannel, UpdaterState } from "../updater";
import type { UserScriptsFolder } from "../userScripts";
import type { IconTheme } from "../views";
import type { DragPreviewShape, OpenWindowOptions, Rect4, WindowEvent, WindowGeometry } from "../windows";

export type ShellNative = {
  setAppearance(mode: AppearanceMode): Promise<void>;
  isDarkAppearance(): Promise<boolean>;
  startDictation(): void | Promise<void>;
  fetchBangList(etag: string | null): Promise<BangListReply>;
  copyText(text: string): void | Promise<void>;
  copyURL?(address: CleanedUrl): void | Promise<void>;
  readText(): Promise<string>;
  dictationAvailable?(): boolean;
  addListener(name: "onOpenURLs", listener: (event: ShellNativeEvents["onOpenURLs"]) => void): { remove(): void };
  addListener(name: "onAppEvent", listener: (event: ShellNativeEvents["onAppEvent"]) => void): { remove(): void };
};

export type ShellNativeEvents = {
  onOpenURLs: { urls: string[]; pointer?: [number, number]; source?: OpenURLSource; returnTo?: string };
  onAppEvent: AppEvent;
};

export type AppWindowsNative = {
  windowCornerRadius(): number;
  drawnWindowCornerRadius(): number;
  frameCornerRadius(id: string): Promise<number>;
  openWindow(id: string, options: OpenWindowOptions): Promise<void>;
  closeWindow(id: string): Promise<void>;
  animateWindowClose(id: string, after: string | null): Promise<void>;
  setTrafficLightsCenter(id: string, center: [number, number] | null, trailing: boolean): Promise<void>;
  watchSidebarEdge(id: string, on: boolean, hold: number, right: boolean, whilePressed: boolean): Promise<void>;
  focusWindow(id: string): Promise<void>;
  setWindowShown?(id: string, shown: boolean, burst: boolean): Promise<void>;
  restoreFullScreen(ids: string[], focus: string | null): Promise<void>;
  dragPreviewBegin(windowId: string, chip: Rect4, grab: [number, number]): Promise<void>;
  dragPreviewPage(base64: string, frame: Rect4): Promise<void>;
  dragPreviewUpdate(shape: DragPreviewShape, point: [number, number]): Promise<void>;
  dragPreviewCancel(): Promise<void>;
  raiseView(tag: number, levels: number, raised: boolean): Promise<void>;
  dragPreviewPlaceholder(title: string, favicon: string | null): Promise<void>;
  windowFrame(id: string): Promise<Rect4 | null>;
  windowGeometry(id: string): Promise<WindowGeometry | null>;
  setWindowFrame(id: string, frame: Rect4): Promise<WindowGeometry | null>;
  setWindowZoomed(id: string, on: boolean): Promise<WindowGeometry | null>;
  setWindowFullScreen(id: string, on: boolean): Promise<WindowGeometry | null>;
  dragPreviewEnd(windowId: string | null, frame: Rect4 | null): Promise<void>;
  setWindowTitle(id: string, title: string): Promise<void>;
  windowIds(): Promise<string[]>;
  replyToTerminate(ok: boolean): Promise<void>;
  addListener(name: "onWindowEvent", listener: (event: AppWindowsNativeEvents["onWindowEvent"]) => void): { remove(): void };
};

export type AppWindowsNativeEvents = {
  onWindowEvent: WindowEvent;
};

export type FocusNative = {
  pressesWithoutRelease(): number;
  takeFocusHandoffCounts?(): Record<string, Record<string, number>>;
  setConsentEpoch?(epoch: string): void;
  pressRepeated(): Promise<{ landedOn: string; ms: number } | null>;
  takeEditKeyAcks?(): Record<string, number>;
  takeInputSourceKeys?(): number;
  cancelFocusMove(generation: number, restoringSource: boolean): Promise<void>;
  claimFocus(generation: number, tag: number): Promise<void>;
  saveKeyResponder(windowId: string): Promise<number>;
  restoreKeyResponder(token: number): Promise<boolean>;
  discardKeyResponder(token: number): Promise<void>;
  setSwitcherCapture(active: boolean): Promise<void>;
  setDragEscapeCapture(active: boolean): Promise<void>;
  takeHoverCounts?(): Record<string, Record<string, number>>;
  switcherPointerMoved(): boolean;
};

export type MenusNative = {
  setMenuState(state: Omit<MenuState, MenuBookmarkKey>): Promise<void>;
  setMenuBookmarks(bookmarks: Pick<MenuState, MenuBookmarkKey>): Promise<void>;
  showMenu(items: MenuItem[]): Promise<string | null>;
  updateMenu(items: MenuItem[]): Promise<void>;
  openSurfaces(): Promise<OpenSurface[]>;
  capturePageMenus(captures: boolean): Promise<void>;
  dismissSurface(id: string): Promise<void>;
  menuBar(): Promise<SurfaceItem[]>;
  performMenuBarItem(ref: string, windowId: string): Promise<string>;
  menuShortcuts(): Promise<MenuShortcut[]>;
  recordShortcut(): Promise<{ key: string; modifiers: ShortcutModifier[] } | null>;
  cancelRecording(): Promise<void>;
  mouseShortcutMonitor(): Promise<{ installed: boolean; installs: number }>;
  addListener(name: "onCommand", listener: (event: MenusNativeEvents["onCommand"]) => void): { remove(): void };
  addListener(name: "onSurface", listener: (event: MenusNativeEvents["onSurface"]) => void): { remove(): void };
};

export type MenusNativeEvents = {
  onCommand: CommandEvent | MenuPickEvent;
  onSurface: SurfaceEvent;
};

export type DialogsNative = {
  dismissesShownOnly?: boolean;
  confirm(options: ConfirmOptions): Promise<{ confirmed: boolean; suppressed: boolean; unshown?: boolean; unavailable?: boolean }>;
  dismissShownOnly?(key: string | null): Promise<void>;
  choose?(options: ChooseOptions): Promise<{ choice: number; unshown?: boolean }>;
  prompt(options: PromptOptions): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickFolder(current: string | null, prompt: string | null): Promise<string | null>;
};

export type DocumentsNative = {
  readDocument(name: string): string | null;
  documentExists(name: string): boolean | Promise<boolean>;
  writeDocument(name: string, contents: string): void;
  documentSaved(name: string): Promise<void>;
  createDocument(name: string, contents: string): Promise<void>;
  listDocuments(prefix: string): string[];
  removeDocument(name: string): void;
  copyDocument(name: string, copyName: string): Promise<void>;
  syncDocument(name: string): Promise<void>;
  saveDocument(name: string, contents: string): Promise<void>;
};

export type AppNative = {
  apiVersion?: number;
  interfaceScale(): number;
  interfaceScaleRange(): [min: number, max: number];
  setInterfaceScale(scale: number): Promise<number>;
  setWindowActivity(windowId: string, url: string | null, title: string | null): Promise<void>;
  share(url: CleanedUrl, title: CleanedTitle | null, windowId: string | null, anchor: ShareAnchor | null): Promise<void>;
  shareText(text: string, windowId: string | null, anchor: ShareAnchor | null): Promise<void>;
  shareVia(service: string, url: CleanedUrl, title: CleanedTitle | null, windowId: string | null): Promise<void>;
  isInDock(): Promise<boolean>;
  addToDock(): Promise<boolean>;
  appIcons(size: number): Promise<AppIcon[]>;
  appIcon(): Promise<string>;
  setAppIcon(id: string): Promise<void>;
  systemInfo(): SystemInfo;
  crashReports(since: number): Promise<CrashReport[]>;
  hardwareInfo(): Promise<HardwareInfo>;
  diagnosticsSample(): Promise<DiagnosticsSample>;
  openExternalURL(url: string): Promise<boolean>;
  playIntroMusic(cues: IntroMusicCues, muted: boolean): Promise<void>;
  setIntroMusicMuted(muted: boolean): Promise<void>;
  stopIntroMusic(fade: number): Promise<void>;
  launchConfig(): LaunchConfig;
};

export type UpdaterNative = {
  updaterState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<void>;
  setAutomaticUpdateChecks(on: boolean): Promise<void>;
  setAutomaticUpdateDownloads(on: boolean): Promise<void>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
};

export type NotificationsNative = {
  notificationPermission(): Promise<NotificationPermission>;
  requestNotificationPermission(): Promise<boolean>;
  postNotification(options: NotificationOptions): Promise<NotificationPostResult | string | null>;
  removeNotifications(ids: string[]): Promise<void>;
  openNotificationSettings(): Promise<void>;
  addListener(name: "onNotificationResponse", listener: (event: NotificationsNativeEvents["onNotificationResponse"]) => void): { remove(): void };
};

export type NotificationsNativeEvents = {
  onNotificationResponse: NotificationResponse;
};

export type LocationNative = {
  locationPermission(): Promise<LocationPermission>;
  requestLocationPermission(): Promise<LocationPermission>;
  openLocationSettings(): Promise<void>;
  devLocationRequests(): Promise<number>;
};

export type ScriptingNative = {
  setScriptState(state: ScriptState): Promise<void>;
  replyToScript(id: string, result: Record<string, unknown> | null, error: string | null): Promise<void>;
  addListener(name: "onScriptCommand", listener: (event: ScriptingNativeEvents["onScriptCommand"]) => void): { remove(): void };
};

export type ScriptingNativeEvents = {
  onScriptCommand: ScriptCommand;
};

export type DevNative = {
  devCrash?(kind?: "exception"): Promise<void>;
  devBlockMain?(ms: number): Promise<number>;
  devNotificationCenter?(actAsEngine: boolean): Promise<unknown>;
  devNotificationCategoryRace?(): Promise<unknown>;
  devRenderIntroMusic?(cues: IntroMusicCues, path: string): Promise<number | null>;
  devLittleArdiaHotKey?(press: boolean): Promise<Record<string, unknown>>;
  devMenuCommand?(command: string, arg: string | null): Promise<void>;
  devPostKey?(windowId: string, key: string, keyCode: number, modifiers: string[]): Promise<boolean>;
  devPostKeys?(windowId: string, presses: (Record<string, unknown>)[]): Promise<unknown>;
  devMenuItems?(title: string, perform: string[] | null, asTitleBar: boolean | null): Promise<(Record<string, unknown>)[]>;
  devDragBlockedRects?(windowId: string): Promise<number[][]>;
  devDragRegionRects?(windowId: string): Promise<number[][]>;
  devDragRegionState?(windowId: string): Promise<Record<string, unknown>>;
  devDragRegionPointer?(windowId: string, x: number, top: number, on: boolean): Promise<boolean>;
  devReceiveURLsWhenDetached?(urls: string[], timeoutMs: number): void;
  devURLDelivery?(): Promise<{ state?: "waiting" | "received" | "neverDetached"; waitedMs?: number; attachedAfter?: boolean }>;
  devOpenURLDeliveries?(): Promise<{ urls: string[]; pointer: [number, number]; source?: { bundleId: string | null; appName: string | null } }[]>;
  devShortcutRecording?(): Promise<boolean>;
  devDragPreviewState?(): Promise<Record<string, unknown>>;
  devWindowMoveProbe?(id: string, probe: Record<string, number>): Promise<unknown>;
  devWindowResizeProbe?(id: string, probe: Record<string, number>): Promise<unknown>;
  devWindowReplayAfterMove?(id: string, rect: number[]): Promise<Record<string, unknown>>;
  devSetWindowFrame?(id: string, rect: number[]): Promise<number[]>;
  devSnapshotWindow?(windowId: string, path: string, transparent?: boolean): Promise<boolean>;
  devSnapshotBurst?(windowId: string, dir: string, rect: number[], durationMs: number): Promise<unknown>;
  devSetPointer?(windowId: string, x: number, y: number, on: boolean): Promise<boolean>;
  devPointerSweep?(windowId: string, sweep: PointerSweep): Promise<PointerSweepResult | null>;
  devSidebarEdgePointer?(windowId: string, x: number, y: number, on: boolean): Promise<boolean>;
  devSidebarEdgeStats?(reset: boolean): Promise<SidebarEdgeStats>;
  devHoverStats?(reset: boolean): Promise<{ passes?: number; log?: [string, number, number][]; registered?: number }>;
  devSetMouseButtons?(pressed: number): Promise<boolean>;
  devTypeKeys?(windowId: string, text: string, interval: number): Promise<KeyTiming[]>;
  devFieldTrace?(on: boolean): Promise<{ at: number; text: string; start: number; end: number }[]>;
  devKeyEquivalent?(windowId: string, press: KeyPress): Promise<KeyPressResult>;
  devMenuBar?(): Promise<(Record<string, unknown>)[]>;
  devKeyEquivalentTrace?(): Promise<string[]>;
  devFocusHandoffTrace?(): Promise<string[]>;
  devClick?(windowId: string, click: Click): Promise<ClickResult>;
  devRunAppleScript?(source: string): Promise<{ ok: boolean; result?: unknown; error?: string; number?: number }>;
};

export type SystemNative = {
  backgroundInstance?: boolean;
  isDefaultBrowser(): Promise<boolean>;
  setAsDefaultBrowser(): Promise<boolean>;
  launchAtLoginStatus(): Promise<LaunchAtLoginStatus>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  fileExists(path: string): boolean;
  openFile(path: string): Promise<boolean>;
  revealFile(path: string): Promise<boolean>;
  moveToTrash(path: string): Promise<boolean>;
  fileIcon(path: string, size: number): Promise<string | null>;
  runningAppIcon(pid: number, size: number): Promise<string | null>;
  hapticTick(): void | Promise<void>;
  setThinScrollBars(thin: boolean): Promise<void>;
};

export type CalendarNative = {
  authorizationStatus(): CalendarAuthorization;
  requestAccess(): Promise<CalendarAccessRequest>;
  calendars(): Promise<SystemCalendar[]>;
  events(start: number, end: number, calendarIds: string[]): Promise<SystemCalendarEvent[]>;
  addListener(name: "onCalendarChanged", listener: () => void): { remove(): void };
};

export type CalendarNativeEvents = {
  onCalendarChanged: void;
};

export type KeychainNative = {
  get(account: string): Promise<string | null>;
  read(account: string): Promise<KeychainReadResult>;
  set(account: string, secret: string): Promise<boolean>;
  delete(account: string): Promise<boolean>;
};

export type GlassEffectNative = {
  isLiquidGlass(): boolean;
};

export type DockSelectionNative = {
  iconTheme(uri: string | null, emoji: string | null): Promise<IconTheme | null>;
  iconAccent(uri: string): Promise<string | null>;
};

export type InlineCompletionNative = {
  complete(tag: number, typed: string, completion: string): Promise<InlineWrite>;
  keepWhileTyping?(tag: number, on: boolean): Promise<void>;
  takeKept?(tag: number, start: number, end: number): string[];
  copyFieldAs(shown: string | null, url: string | null): Promise<void>;
};

export type TranslateNative = {
  available: boolean;
  userLanguages(): string[];
  languageName(identifier: string): string;
  detect(text: string): Promise<string | null>;
  status(source: string, target: string): Promise<"installed" | "supported" | "unsupported">;
  supportedLanguages(): Promise<string[]>;
  prepare(source: string, target: string): Promise<void>;
  translateBlocks(source: string, target: string, blocks: string[][], owner: string): Promise<(string[] | null)[]>;
  open(owner: string): Promise<void>;
  cancel(owner: string): Promise<void>;
  translate(source: string, target: string, texts: string[]): Promise<(string | null)[]>;
};

export type MagnifyAreaNative = {
  devMagnify(windowId: string, x: number, y: number, steps: MagnifyUpdate[]): Promise<{ claimed?: boolean[]; hit?: string; error?: string }>;
};

export type WheelAreaNative = {
  devWheel(windowId: string, x: number, y: number, steps: { phase?: string; dy: number; momentum?: boolean; precise?: boolean; afterMs?: number }[]): Promise<{ claimed?: boolean[]; inputs?: { t: number; dy: number }[]; frames?: { t: number; model: number; shown: number }[]; error?: string }>;
  glideScroll(tag: number, y: number, durationMs: number): Promise<void>;
  steerScroll(tag: number, lo: number, hi: number, glideMs: number, canForward: boolean, canBack: boolean): Promise<void>;
};

export type PeekStageNative = {
  devState(windowId: string): Promise<Record<string, unknown>[]>;
  devPageFrames(windowId: string): Promise<{ tabId: string; browserId: number; visible: boolean; inPeek: boolean; frame: PeekRect }[]>;
  devPostMagnify?(windowId: string, x: number, y: number, phase: string, magnification: number): Promise<Record<string, unknown>>;
  devPostScroll?(windowId: string, x: number, y: number, dy: number): Promise<Record<string, unknown>>;
  devPostButton?(windowId: string, x: number, y: number, button: number): Promise<Record<string, unknown>>;
};

export type FileDropNative = {
  devDrag(windowId: string, action: DevDragAction, x: number, y: number, payload: DevDragPayload | null): Promise<string>;
  devLastFileDrag(): Promise<string[]>;
};

export type CliNative = {
  installedVersion(): string | null;
  canInstallUnattended(): boolean;
  install(): Promise<CliInstallResult>;
  addListener(name: "onInstallLine", listener: (event: CliNativeEvents["onInstallLine"]) => void): { remove(): void };
};

export type CliNativeEvents = {
  onInstallLine: { line: string };
};

export type UserScriptsNative = {
  watch(on: boolean): void;
  read(): Promise<UserScriptsFolder>;
  readStatus(): Promise<string | null>;
  writeStatus(json: string): Promise<void>;
  addListener(name: "onChange", listener: () => void): { remove(): void };
};

export type UserScriptsNativeEvents = {
  onChange: void;
};

export type ConfigNative = {
  readFile(name: string): ConfigFileRead;
  watch(names: string[]): Promise<void>;
  writeSchemas(files: Record<string, string>): Promise<string[]>;
  addListener(name: "onChange", listener: () => void): { remove(): void };
};

export type ConfigNativeEvents = {
  onChange: void;
};

export type AutomationNative = {
  start(): Promise<ControlSocketStatus>;
  stop(): Promise<void>;
  reply(connection: number, line: string, ticket: number): void;
  cutOff?(): boolean;
  broadcast(connections: number[], line: string): void;
  devtoolsEndpoint?(connection: number): Promise<NativeDevtoolsEndpoint>;
  answerPeer?(ask: number, outcome: ControlPeerAnswer): Promise<boolean>;
  approvals?(): Promise<ControlApprovals>;
  revokeApproval?(key: string): Promise<boolean>;
  armFiles?(spec: FileArmSpec): Promise<FileArmResult>;
  disarmFiles?(ids: string[] | null, purge: boolean): number;
  fileArms?(): Promise<FileArmRow[]>;
  claimArmedDownload?(arm: string, download: string, path: string): FileArmClaim;
  placeArmedDownload?(arm: string, download: string, path: string): Promise<PlacedDownload>;
  releaseArmedDownload?(arm: string, download: string, state: string): boolean;
  addListener(name: "onRequest", listener: (event: AutomationNativeEvents["onRequest"]) => void): { remove(): void };
  addListener(name: "onClose", listener: (event: AutomationNativeEvents["onClose"]) => void): { remove(): void };
  addListener(name: "onWritten", listener: (event: AutomationNativeEvents["onWritten"]) => void): { remove(): void };
  addListener(name: "onPeerAsk", listener: (event: AutomationNativeEvents["onPeerAsk"]) => void): { remove(): void };
  addListener(name: "onPeerAskEnded", listener: (event: AutomationNativeEvents["onPeerAskEnded"]) => void): { remove(): void };
};

export type AutomationNativeEvents = {
  onRequest: ControlRequest;
  onClose: { connection: number };
  onWritten: { tickets: number[] };
  onPeerAsk: ControlPeerAsk;
  onPeerAskEnded: { ask: number; outcome: ControlPeerOutcome };
};

export type PluginsNative = {
  folder(): string;
  list(): Promise<PluginFolderEntry[]>;
  start(spec: PluginStartSpec): Promise<PluginStartResult>;
  stop(name: string, run: number, graceMs: number): Promise<void>;
  reply(name: string, run: number, line: string): void;
  event(name: string, run: number, line: string): void;
  call(name: string, run: number, line: string): void;
  linkPrograms(spec: PluginProgramsSpec): Promise<PluginProgramsResult>;
  takeAfterUpdateQuitStops(): Promise<PluginAfterUpdateQuitStops>;
  setAfterUpdateQuitConsent(consent: string): void;
  legacyProgramsInstalled(): Promise<string[]>;
  programRegistry(): Promise<PluginProgramRegistry>;
  sweepPrograms(active: string[]): Promise<void>;
  unlinkPrograms(name: string, programs: string[], remove: boolean): Promise<{ ok: boolean }>;
  officialPlugins(): Promise<OfficialPinned[] | null>;
  fetchOfficial(name: string): Promise<OfficialFetchResult>;
  cancelOfficialFetch(name: string): void;
  promoteOfficial(name: string, folderId: string, approved: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  hostFetch(spec: PluginFetchSpec): Promise<PluginFetchResult>;
  storageRead(name: string): Promise<PluginStorageReadResult>;
  storageWrite(name: string, text: string): Promise<{ ok: boolean; reason?: string }>;
  readPluginFile(name: string, folderId: string, approved: string, path: string): Promise<PluginFileReadResult>;
  remove(name: string, official: boolean, folderId: string | null): Promise<PluginRemoveResult>;
  revealLog(name: string): void;
  revealFolder(): void;
  devSnapshotPage(name: string, path: string): Promise<boolean>;
  addListener(name: "onLine", listener: (event: PluginsNativeEvents["onLine"]) => void): { remove(): void };
  addListener(name: "onExit", listener: (event: PluginsNativeEvents["onExit"]) => void): { remove(): void };
  addListener(name: "onOfficialFetch", listener: (event: PluginsNativeEvents["onOfficialFetch"]) => void): { remove(): void };
};

export type PluginsNativeEvents = {
  onLine: PluginLine;
  onExit: PluginExit;
  onOfficialFetch: OfficialFetchProgress;
};

export type SystemSignalsNative = {
  watchIdle(thresholds: number[]): void | Promise<void>;
  holdsIncomingLinks(): boolean;
  setHoldIncomingLinks(hold: boolean, hooksStamp: string | null): void;
  setApprovedDownloadFolders(folders: string[]): void;
  moveCompletedDownload(path: string, folder: string): Promise<MovedDownload>;
  devPost(name: "willSleep" | "didWake"): Promise<boolean>;
  addListener(name: "onSystemSignal", listener: (event: SystemSignalsNativeEvents["onSystemSignal"]) => void): { remove(): void };
};

export type SystemSignalsNativeEvents = {
  onSystemSignal: SystemSignal;
};

export type ReportNative = {
  draftDirectory(): string | Promise<string>;
  fileSize(path: string): number | Promise<number>;
  removeFile(path: string): void | Promise<void>;
  startRecording(windowId: string, includePages: boolean, path: string, maxSeconds: number | null, fps?: number | null, maxPixelWidth?: number | null): Promise<boolean>;
  stopRecording(): Promise<boolean>;
  cancelRecording(): Promise<void>;
  isRecording(): boolean;
  recordingThumbnail(path: string, out: string): Promise<boolean>;
  gzipFile(source: string, destination: string, removeSource: boolean): Promise<number>;
  gzipText(text: string, destination: string): Promise<number>;
  upload(id: string, url: string, method: string, headers: Record<string, string>, path: string): Promise<UploadReply>;
  cancelUploads(): void | Promise<void>;
  devRenderCost?(windowId: string): Promise<(Record<string, unknown>)[]>;
  devSnapshotPill?(path: string): Promise<Record<string, number> | null>;
  devRecordingPages?(windowId: string): Promise<(Record<string, unknown>)[]>;
  devPlaceWindow?(windowId: string, frame: number[]): Promise<boolean>;
  devWindowServerAlpha?(windowNumber: number, alpha: number): Promise<boolean>;
  devPages?(windowId: string): Promise<(Record<string, unknown>)[]>;
  addListener(name: "onReport", listener: (event: ReportNativeEvents["onReport"]) => void): { remove(): void };
};

export type ReportNativeEvents = {
  onReport: ReportEvent;
};

export type TelemetryLocalNative = {
  append(day: string, text: string): void;
  appendNow(day: string, text: string): void;
  configure(maxBytes: number, keepDays: number): void;
  prune(now: number): Promise<TelemetryLocalStats>;
  clear(): Promise<void>;
  exportForReport(since: number): Promise<TelemetryLocalExport | null>;
  exportToDownloads(now: number): Promise<TelemetryLocalExport | null>;
};

export type FieldGlowNative = {
  show(id: string, timings: number[]): void;
  progress(id: string, progress: number, still: boolean): void;
  pulse(id: string, period: number, low: number): void;
  finish(id: string, still: boolean): void;
  reset(id: string): void;
};

export type ShellModules = {
  ArdiaShell: ShellNative;
  ArdiaAppWindows: AppWindowsNative;
  ArdiaFocus: FocusNative;
  ArdiaMenus: MenusNative;
  ArdiaDialogs: DialogsNative;
  ArdiaDocuments: DocumentsNative;
  ArdiaApp: AppNative;
  ArdiaUpdater: UpdaterNative;
  ArdiaNotifications: NotificationsNative;
  ArdiaLocation: LocationNative;
  ArdiaScripting: ScriptingNative;
  ArdiaDev: DevNative;
  ArdiaSystem: SystemNative;
  ArdiaCalendar: CalendarNative;
  ArdiaKeychain: KeychainNative;
  ArdiaGlassEffect: GlassEffectNative;
  ArdiaDockSelection: DockSelectionNative;
  ArdiaInlineCompletion: InlineCompletionNative;
  ArdiaTranslate: TranslateNative;
  ArdiaMagnifyArea: MagnifyAreaNative;
  ArdiaWheelArea: WheelAreaNative;
  ArdiaPeekStage: PeekStageNative;
  ArdiaFileDrop: FileDropNative;
  ArdiaCli: CliNative;
  ArdiaUserScripts: UserScriptsNative;
  ArdiaConfig: ConfigNative;
  ArdiaAutomation: AutomationNative;
  ArdiaPlugins: PluginsNative;
  ArdiaSystemSignals: SystemSignalsNative;
  ArdiaReport: ReportNative;
  ArdiaTelemetryLocal: TelemetryLocalNative;
  ArdiaFieldGlow: FieldGlowNative;
};
