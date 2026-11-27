import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";
import type { resumeTelemetry, settleTelemetry } from "./telemetrySettle.ts";

export const SESSION_ENDED_METHOD = "ArdiaShell.sessionEnded";
export const SESSION_ENDING_EVENT = "shell.sessionEnding";
export const SESSION_RESUMED_EVENT = "shell.sessionResumed";

const SESSION_TOKEN = /^[A-Za-z0-9-]{1,64}$/;

type ShellEnvelope = { name?: unknown; data?: { token?: unknown } | null };
type SessionEndHooks = {
  host: ArdiaHost;
  settle: typeof settleTelemetry;
  resume: typeof resumeTelemetry;
  report(error: unknown): void;
};

export const sessionTokenOf = (payload: unknown): string | null => {
  const token = ((payload ?? {}) as ShellEnvelope).data?.token;
  return typeof token === "string" && SESSION_TOKEN.test(token) ? token : null;
};

export function answerSessionEnds({ host, settle, resume, report }: SessionEndHooks): () => void {
  if (!hostSupports(SESSION_ENDED_METHOD, host)) return () => {};
  return host.onEvent((module, event, payload) => {
    if (module !== "ArdiaShell" || event !== "shell") return;
    const name = ((payload ?? {}) as ShellEnvelope).name;
    if (name !== SESSION_ENDING_EVENT && name !== SESSION_RESUMED_EVENT) return;
    const token = sessionTokenOf(payload);
    if (!token) return;
    if (name === SESSION_ENDING_EVENT) {
      void settle(true, token)
        .catch((error) => { report(error); return null; })
        .then(() => invokeHost(SESSION_ENDED_METHOD, { args: [token] }, host))
        .catch(report);
    } else {
      void resume(token).catch(report);
    }
  });
}
