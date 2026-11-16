import { hostSupports, type ArdiaHost } from "./host.ts";
import { unavailableError } from "./hostCapabilities.ts";
import { linuxIconAccent } from "./iconAccent.ts";
import { TELEMETRY_LOCAL_METHODS } from "./hostTelemetryLocal.ts";
import { hostReportMethod } from "./hostReport.ts";
import { shareLink, shareLinkVia, shareText, type ShareAnchor } from "./linkShare.ts";

type Fallback = (...args: unknown[]) => unknown;

const answer = (value: unknown): Fallback => () => Promise.resolve(value);
const refuse = (feature: string): Fallback => () => Promise.reject(unavailableError(feature));
const refuseNow = (feature: string): Fallback => () => { throw unavailableError(feature); };
const now = (value: unknown): Fallback => () => value;

const APP_FALLBACKS: Record<string, Fallback> = {
  updaterState: answer({ available: false }),
  checkForUpdates: refuse("Checking for updates"),
  setAutomaticUpdateChecks: refuse("Automatic update checks"),
  setAutomaticUpdateDownloads: refuse("Automatic update downloads"),
  setUpdateChannel: refuse("The update channel"),
  setWindowActivity: refuse("Handoff"),
  share: (url, title, windowId, anchor) => shareLink(url as string, title as string | null, windowId as string | null, anchor as ShareAnchor | null),
  shareVia: (service, url, title, windowId) => shareLinkVia(service as string, url as string, title as string | null, windowId as string | null),
  shareText: (text, windowId, anchor) => shareText(text as string, windowId as string | null, anchor as ShareAnchor | null),
  isInDock: refuse("The Dock"),
  addToDock: refuse("The Dock"),
  appIcons: answer([]),
  appIcon: refuse("Alternate app icons"),
  setAppIcon: refuse("Alternate app icons"),
  notificationPermission: refuse("Desktop notifications"),
  requestNotificationPermission: refuse("Desktop notifications"),
  openNotificationSettings: refuse("Desktop notifications"),
  postNotification: answer(null),
  removeNotifications: answer(undefined),
  setScriptState: refuse("AppleScript"),
  replyToScript: refuse("AppleScript"),
  crashReports: answer([]),
  hardwareInfo: refuse("Hardware details"),
  diagnosticsSample: answer({}),
  interfaceScale: now(1),
  interfaceScaleRange: now([1, 1]),
  setInterfaceScale: answer(1),
};

const REPORT_FALLBACKS: Record<string, Fallback> = {
  draftDirectory: refuseNow("Problem report drafts"),
  fileSize: now(0),
  removeFile: now(undefined),
  startRecording: refuse("Recording a window"),
  stopRecording: answer(false),
  cancelRecording: answer(undefined),
  isRecording: now(false),
  recordingThumbnail: answer(false),
  gzipFile: refuse("Compressing report files"),
  gzipText: refuse("Compressing report files"),
  upload: answer({ status: 0, body: "", error: "Sending problem reports is unavailable on Linux" }),
  post: answer({ status: 0, body: "", error: "Sending problem reports is unavailable on Linux" }),
  cancelUploads: now(undefined),
};

const MODULE_FALLBACKS: Record<string, Record<string, Fallback>> = {
  ArdiaApp: APP_FALLBACKS,
  ArdiaKeychain: { get: refuse("The keychain"), set: refuse("The keychain"), delete: refuse("The keychain") },
  ArdiaTranslate: {
    userLanguages: () => [],
    languageName: (identifier) => identifier,
    ...Object.fromEntries(["detect", "status", "supportedLanguages", "prepare", "open", "translate", "translateBlocks", "cancel"].map((method) => [method, refuse("Translation")])),
  },
  ArdiaInlineCompletion: { complete: refuse("Inline completion") },
  ArdiaLocation: { locationPermission: answer("granted"), requestLocationPermission: answer("granted"), openLocationSettings: answer(undefined) },
  ArdiaDockSelection: { iconTheme: refuse("Icon themes"), iconAccent: linuxIconAccent },
  ArdiaReport: REPORT_FALLBACKS,
  ArdiaTelemetryLocal: TELEMETRY_LOCAL_METHODS,
  ArdiaSystem: { runningAppIcon: answer(null) },
  ArdiaCli: { install: refuse("The ardia command") },
  ArdiaSwipe: { haptic: now(undefined) },
  ArdiaWindowBackdrop: { holdKeyLook: answer(undefined) },
  ArdiaConfig: { watch: answer(undefined), writeSchemas: answer([]) },
  ArdiaAutomation: { start: answer({ state: "off", generation: 0, path: "", reason: "the control socket is unavailable on Linux" }), stop: answer(undefined) },
  ArdiaSystemSignals: {
    watchIdle: () => undefined,
    holdsIncomingLinks: () => false,
    setHoldIncomingLinks: () => undefined,
    setApprovedDownloadFolders: () => undefined,
    moveCompletedDownload: refuse("Moving a finished download"),
    devPost: refuse("The developer hook ArdiaSystemSignals.devPost"),
  },
};

const DEVELOPER_MODULES = new Set(["ArdiaApp", "ArdiaMagnifyArea", "ArdiaFileDrop", "ArdiaLocation"]);

export function appModuleFallback(host: ArdiaHost, name: string, method: string): Fallback | undefined {
  if (hostSupports(`${name}.${method}`, host)) return undefined;
  const served = name === "ArdiaReport" ? hostReportMethod(host, method) : undefined;
  if (served) return served;
  const fallback = MODULE_FALLBACKS[name]?.[method];
  if (fallback && Object.hasOwn(MODULE_FALLBACKS[name]!, method)) return fallback;
  if (DEVELOPER_MODULES.has(name) && /^dev[A-Z]/.test(method)) return refuse(`The developer hook ${name}.${method}`);
  return undefined;
}
