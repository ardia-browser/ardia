import { APP_INGEST_KEY } from "@ardia/core";
import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

export const TELEMETRY_POST = "ArdiaTelemetry.post";
export const TELEMETRY_CANCEL_POST = "ArdiaTelemetry.cancelPost";

const RENDERER_PREFIX = `telemetry-${globalThis.crypto.randomUUID()}`;
let postSequence = 0;

const reportedStatus = (reply: { status?: unknown } | null | undefined) => {
  const status = reply?.status;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : 0;
};

export function hostTelemetrySend(host: ArdiaHost) {
  const cancellable = hostSupports(TELEMETRY_CANCEL_POST, host);
  return (body: string, signal?: AbortSignal): Promise<number> => {
    if (signal?.aborted) return Promise.resolve(0);
    const id = `${RENDERER_PREFIX}-${++postSequence}`;
    const sent = invokeHost<{ status?: unknown } | null>(TELEMETRY_POST, { args: cancellable ? [body, APP_INGEST_KEY, id] : [body, APP_INGEST_KEY] }, host).then(reportedStatus);
    if (!signal) return sent;
    return new Promise<number>((resolve, reject) => {
      const abort = () => {
        if (cancellable) void invokeHost(TELEMETRY_CANCEL_POST, { args: [id] }, host).catch((error: unknown) => console.warn("[ardia linux] telemetry", error));
        resolve(0);
      };
      signal.addEventListener("abort", abort, { once: true });
      sent.then((status) => {
        signal.removeEventListener("abort", abort);
        resolve(status);
      }, (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  };
}
