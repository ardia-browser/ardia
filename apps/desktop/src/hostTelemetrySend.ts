import { APP_INGEST_KEY } from "@ardia/core";
import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

export const TELEMETRY_POST = "ArdiaTelemetry.post";
export const TELEMETRY_CANCEL_POST = "ArdiaTelemetry.cancelPost";

let renderer: string | undefined;
let sequence = 0;

const requestId = () => `telemetry-${(renderer ??= globalThis.crypto.randomUUID())}-${++sequence}`;

const reportedStatus = (reply: unknown) => {
  const status = reply && typeof reply === "object" ? (reply as { status?: unknown }).status : undefined;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : 0;
};

export function hostTelemetrySend(host: ArdiaHost, report: (error: unknown) => void) {
  const cancellable = hostSupports(TELEMETRY_CANCEL_POST, host);
  return (body: string, signal?: AbortSignal): Promise<number> => {
    if (signal?.aborted) return Promise.resolve(0);
    const id = cancellable ? requestId() : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      let sent = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        if (id && sent) void invokeHost(TELEMETRY_CANCEL_POST, { args: [id] }, host).catch(report);
        resolve(0);
      };
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => {
        if (settled) return null;
        sent = true;
        return host.invoke(TELEMETRY_POST, { args: id ? [body, APP_INGEST_KEY, id] : [body, APP_INGEST_KEY] });
      }).then((reply) => {
        signal?.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        resolve(reportedStatus(reply));
      }, (error: unknown) => {
        signal?.removeEventListener("abort", abort);
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  };
}
