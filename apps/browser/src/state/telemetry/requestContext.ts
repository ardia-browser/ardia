import { EVENTS_SCOPE, eventRecord, LOGS_SCOPE, logsRequest, type OtlpLogRecord, type QueuedEvent } from "./otlp";
import { appInfo, telemetryHost } from "./transport";
import { savedChoice as saved, sessionId } from "./choice";

let engineVersion: string | null = null;

export const setEngineVersion = (version: string) => void (engineVersion = version);

export const environment = (): "dev" | "test" | "production" =>
  __DEV__ ? "dev" : appInfo().isolatedInstance ? "test" : "production";

export function context(): Record<string, unknown> {
  const info = appInfo();
  return {
    $lib: "ardia-telemetry",
    $lib_version: "1",
    $app_name: "Ardia",
    $app_version: info.appVersion,
    $app_build: info.appBuild,
    $os: telemetryHost().os,
    $os_version: info.osVersion,
    arch: info.arch,
    ...(info.arch === "x86_64" ? { rosetta: info.translated === true } : {}),
    engine_version: engineVersion,
    $environment: environment(),
    $process_person_profile: false,
    $geoip_disable: true,
    $session_id: sessionId(),
    ...watchProperty(),
  };
}

function watchProperty(): Record<string, string> {
  const { watchReport, watchUntil } = saved();
  return watchReport && watchUntil !== null && Date.now() < watchUntil ? { watch_report: watchReport } : {};
}

export function resource(): Record<string, unknown> {
  const info = appInfo();
  return {
    "service.name": "ardia-app",
    "service.version": info.appVersion,
    "deployment.environment": environment() === "production" ? "production" : "development",
    "os.type": telemetryHost().osType,
    "os.version": info.osVersion,
    "host.arch": info.arch,
    "engine.version": engineVersion,
  };
}

export const eventsBody = (batch: QueuedEvent[]) =>
  logsRequest(
    resource(),
    EVENTS_SCOPE,
    batch.map((e) => eventRecord(e.properties.engine_version == null && engineVersion ? { ...e, properties: { ...e.properties, engine_version: engineVersion } } : e)),
  );

export const logsBody = (batch: OtlpLogRecord[]) => logsRequest(resource(), LOGS_SCOPE, batch);
