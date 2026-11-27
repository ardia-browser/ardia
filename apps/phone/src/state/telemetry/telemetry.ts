import { materialColorSource } from "../../lib/material/schemePick";
import { useDynamicScheme } from "../app/dynamicScheme";
import { useAppearanceDesign } from "../settings/appearance";
import { AppState, Platform } from "react-native";
import { lookBudget, nativeGlassRender, systemLook, systemLookNow } from "../../platform/look";
import { create } from "zustand";
import { createGate, DAILY_KEY, type SharingSource } from "../../lib/telemetryGate";
import { backdropProps, COUNTED, launchProps, launchTrayProps, legacyImportOutcome, parseDaily, pendingUsage, type Counted } from "../../lib/telemetrySchema";
import { canPostTelemetry, deviceFacts, JS_STARTED_AT, launchBackdropShownAt, newTelemetryId, postTelemetry, processStartedAt, setUsageConsent, takeExits, takePendingCounts } from "../../platform/telemetry";
import { collectCrashes, jsErrorReason, MOST_CRASHES_PER_LAUNCH, PENDING_CRASH_KEY, pendingJsCrash, previousSession, SESSION_KEY, sessionMark, type PreviousSession } from "../../lib/crashReports";
import { appearanceTelemetry, chromeStyle, colorChoiceTelemetry, glassRenderTelemetry, macLookOf, offeredInterfaceStyle, offeredScheme } from "../../lib/appearance";
import { useBoot } from "../app/bootState";
import { isDemoSession } from "../app/launchFlags";
import { currentPreferences } from "../settings/store";
import { readPreference, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { syncOffered } from "../../platform/system";
import { syncData } from "../sync/store";

const DAILY_CHECK_MS = 60 * 60_000;

export const useUsageSharing = create<{ sharing: boolean }>()(() => ({ sharing: false }));

const gate = createGate({
  store: {
    read: (key) => readPreference(browserDatabase(), key),
    write: (key, value) => writePreference(browserDatabase(), key, value),
  },
  post: postTelemetry,
  canPost: canPostTelemetry,
  newId: newTelemetryId,
  device: deviceFacts,
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  onChange: (sharing) => {
    useUsageSharing.setState({ sharing });
    setUsageConsent(sharing);
    if (!sharing) writePreference(browserDatabase(), PENDING_CRASH_KEY, null);
    markSession(AppState.currentState === "active");
  },
});

let lastMark: string | null | undefined;
let launchPrevious: PreviousSession = "unknown";
let crashesLeft = MOST_CRASHES_PER_LAUNCH;

function markSession(active: boolean) {
  const mark = sessionMark(active, gate.isSharing());
  if (mark === lastMark) return;
  lastMark = mark;
  writePreference(browserDatabase(), SESSION_KEY, mark);
}

function reportCrashes() {
  const db = browserDatabase();
  const crashes = collectCrashes(
    {
      sharing: () => gate.isSharing() && !isDemoSession(),
      readPending: () => readPreference(db, PENDING_CRASH_KEY),
      clearPending: () => writePreference(db, PENDING_CRASH_KEY, null),
      takeExits,
    },
    Date.now(),
    crashesLeft,
  );
  crashesLeft -= crashes.length;
  for (const props of crashes) gate.capture("app_crashed", props);
}

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsShape = { getGlobalHandler(): GlobalErrorHandler | undefined; setGlobalHandler(handler: GlobalErrorHandler): void };

function noteJsError(error: unknown, isFatal: boolean | undefined) {
  if (!gate.isSharing() || isDemoSession()) return;
  if (isFatal) writePreference(browserDatabase(), PENDING_CRASH_KEY, pendingJsCrash(jsErrorReason(error), Date.now(), AppState.currentState));
  else gate.count("js_errors");
}

function watchJsErrors() {
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!utils) return;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    try {
      noteJsError(error, isFatal);
    } catch {}
    previous?.(error, isFatal);
  });
}

let started = false;

function countPendingUsage() {
  for (const field of pendingUsage(takePendingCounts())) gate.count(field);
}

export function startTelemetry() {
  if (started) return;
  started = true;
  gate.load();
  useUsageSharing.setState({ sharing: gate.isSharing() });
  setUsageConsent(gate.isSharing());
  launchPrevious = previousSession(readPreference(browserDatabase(), SESSION_KEY));
  markSession(AppState.currentState === "active");
  watchJsErrors();
  gate.rollDaily();
  countPendingUsage();
  reportCrashes();
  AppState.addEventListener("change", (next) => {
    markSession(next === "active");
    if (next === "active") {
      gate.rollDaily();
      countPendingUsage();
      reportCrashes();
    } else gate.flushNow();
  });
  setInterval(() => gate.rollDaily(), DAILY_CHECK_MS);
}

export const setUsageSharing = (on: boolean, source: SharingSource) => gate.setSharing(on, source);

export function countUsage(field: Counted) {
  if (!isDemoSession()) gate.count(field);
}

export const usageCountingWindow = (): ((field: Counted) => void) => (isDemoSession() ? () => undefined : gate.countingWindow());

let reported = false;

export async function reportLaunch(firstScreenAt: number) {
  if (reported || !gate.isSharing()) return;
  reported = true;
  const boot = useBoot.getState();
  const look = lookBudget.mode(await systemLook());
  const { interfaceStyle, schemeChoice, colorChoice, dynamicColors } = currentPreferences();
  const material_colors = materialColorSource(useAppearanceDesign.getState().design === "material", colorChoice, useDynamicScheme.getState().pair, dynamicColors);
  const color_choice = colorChoiceTelemetry(colorChoice);
  const design = useAppearanceDesign.getState().design;
  const { status, view } = syncData();
  const glass_render = glassRenderTelemetry(Platform.OS, design, chromeStyle(design, interfaceStyle, macLookOf(status.isEnabled, view.look), systemLookNow().reduceTransparency), nativeGlassRender());
  gate.capture("app_launched", { legacy_import: legacyImportOutcome(boot.outcome), legacy_import_failures: boot.failures, look_mode: look, ...appearanceTelemetry(offeredInterfaceStyle(interfaceStyle, syncOffered()), offeredScheme(schemeChoice, syncOffered())), material_colors, color_choice, glass_render, previous_session: launchPrevious });
  const processStart = await processStartedAt();
  const timings = launchProps(processStart, JS_STARTED_AT, firstScreenAt);
  if (timings) gate.capture("perf_launch", timings);
  const backdrop = backdropProps(processStart, launchBackdropShownAt());
  if (backdrop) gate.capture("perf_backdrop", backdrop);
}

let trayReported = false;

export async function reportLaunchTray(trayUpAt: number) {
  if (trayReported || isDemoSession() || !gate.isSharing()) return;
  trayReported = true;
  const props = launchTrayProps(await processStartedAt(), trayUpAt);
  if (props) gate.capture("perf_launch_tray", props);
}

export function usageToday(): { day: string | null; counts: Partial<Record<Counted, number>>; sharing: boolean } {
  const daily = parseDaily(readPreference(browserDatabase(), DAILY_KEY));
  const counts: Partial<Record<Counted, number>> = {};
  if (daily) for (const field of COUNTED) if (daily[field] > 0) counts[field] = daily[field];
  return { day: daily?.day ?? null, counts, sharing: gate.isSharing() };
}
