import { AppState } from "react-native";
import { lookBudget, systemLook } from "../../platform/look";
import { create } from "zustand";
import { createGate, DAILY_KEY, type SharingSource } from "../../lib/telemetryGate";
import { backdropProps, COUNTED, launchProps, launchTrayProps, legacyImportOutcome, parseDaily, pendingUsage, type Counted } from "../../lib/telemetrySchema";
import { canPostTelemetry, deviceFacts, JS_STARTED_AT, launchBackdropShownAt, newTelemetryId, postTelemetry, processStartedAt, setUsageConsent, takePendingCounts } from "../../platform/telemetry";
import { appearanceTelemetry, offeredInterfaceStyle, offeredScheme } from "../../lib/appearance";
import { useBoot } from "../app/bootState";
import { isDemoSession } from "../app/launchFlags";
import { currentPreferences } from "../settings/store";
import { readPreferences, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { syncOffered } from "../../platform/system";

const DAILY_CHECK_MS = 60 * 60_000;

export const useUsageSharing = create<{ sharing: boolean }>()(() => ({ sharing: false }));

const gate = createGate({
  store: {
    read: (key) => readPreferences(browserDatabase())[key] ?? null,
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
  },
});

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
  gate.rollDaily();
  countPendingUsage();
  AppState.addEventListener("change", (next) => {
    if (next === "active") {
      gate.rollDaily();
      countPendingUsage();
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
  const { interfaceStyle, schemeChoice } = currentPreferences();
  gate.capture("app_launched", { legacy_import: legacyImportOutcome(boot.outcome), legacy_import_failures: boot.failures, look_mode: look, ...appearanceTelemetry(offeredInterfaceStyle(interfaceStyle, syncOffered()), offeredScheme(schemeChoice, syncOffered())) });
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
  const daily = parseDaily(readPreferences(browserDatabase())[DAILY_KEY] ?? null);
  const counts: Partial<Record<Counted, number>> = {};
  if (daily) for (const field of COUNTED) if (daily[field] > 0) counts[field] = daily[field];
  return { day: daily?.day ?? null, counts, sharing: gate.isSharing() };
}
