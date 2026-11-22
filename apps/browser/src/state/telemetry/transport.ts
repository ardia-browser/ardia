import { systemInfo, type SystemInfo } from "../../platform/app";
import { devTestValue } from "../../platform/launchConfig";
import { PLATFORM_IDS, PLATFORM_TERMS } from "../../lib/platformTerms";
import { APP_INGEST_KEY, INGEST_KEY_HEADER } from "@ardia/core";
import { DEV_SEND_TEST_KEY, LOGS_URL } from "./config";
import { logRequest, type RequestLogEntry } from "./requestLog";
import { consentToken, counted } from "./choice";

let app: SystemInfo | null = null;
export const appInfo = () => (app ??= systemInfo());

const devSendAllowed = () => devTestValue(DEV_SEND_TEST_KEY) === "1";

export const mayPost = (kind: RequestLogEntry["kind"]) =>
  kind === "daily" ? devSendAllowed() || (!__DEV__ && appInfo().isolatedInstance === false) : !__DEV__ || devSendAllowed();

export type TelemetrySend = (body: string, signal?: AbortSignal) => Promise<number>;
export type TelemetryHost = { os: string; osType: string; send: TelemetrySend | null };

const PLATFORM_HOST: TelemetryHost = { os: PLATFORM_TERMS.os, osType: PLATFORM_IDS.otel, send: null };
let host = PLATFORM_HOST;

export const telemetryHost = (): Readonly<TelemetryHost> => host;
export const setTelemetryHost = (next: TelemetryHost) => void (host = next);

const posted = { bytes: 0, failed: 0, requests: 0 };

export function takePostStats() {
  const taken = { ...posted };
  Object.assign(posted, { bytes: 0, failed: 0, requests: 0 });
  return taken;
}

export const resetPostStats = () => void takePostStats();

export const POST_HEADERS: Readonly<Record<string, string>> = { "Content-Type": "application/json", [INGEST_KEY_HEADER]: APP_INGEST_KEY };

export async function post(kind: RequestLogEntry["kind"], body: string, count: number, signal?: AbortSignal): Promise<number> {
  const entry: RequestLogEntry = { at: new Date().toISOString(), kind, url: LOGS_URL, count, bytes: body.length, status: null };
  const consent = consentToken();
  if (!mayPost(kind)) {
    logRequest({ ...entry, dryRun: true }, body);
    return 200;
  }
  try {
    entry.status = host.send ? await host.send(body, signal) : (await fetch(LOGS_URL, { method: "POST", headers: POST_HEADERS, body, signal })).status;
  } catch {
    entry.status = 0;
  }
  const status = entry.status;
  counted(consent, () => {
    posted.requests++;
    if (status >= 200 && status < 300) posted.bytes += body.length;
    else posted.failed++;
  });
  logRequest(entry, body);
  return entry.status;
}

export const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
