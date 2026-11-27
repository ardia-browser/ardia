import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

export const SESSION_ENDED_METHOD = "ArdiaShell.sessionEnded";
export const SESSION_ENDING_EVENT = "shell.sessionEnding";
export const SESSION_RESUMED_EVENT = "shell.sessionResumed";

type ShellEnvelope = { name?: unknown; data?: { token?: unknown } | null };
type SessionEndHooks = {
  host: ArdiaHost;
  settle(endsSession: boolean): Promise<string | null>;
  reopen(token: string): Promise<void>;
  report(error: unknown): void;
};

export function answerSessionEnds({ host, settle, reopen, report }: SessionEndHooks): () => void {
  if (!hostSupports(SESSION_ENDED_METHOD, host)) return () => {};
  let ended: string | null = null;
  return host.onEvent((module, event, payload) => {
    if (module !== "ArdiaShell" || event !== "shell") return;
    const { name, data } = (payload ?? {}) as ShellEnvelope;
    const token = data?.token;
    if (typeof token !== "string" || !token) return;
    if (name === SESSION_ENDING_EVENT) {
      void settle(true)
        .catch((error) => { report(error); return null; })
        .then((settled) => {
          if (settled) ended = settled;
          return invokeHost(SESSION_ENDED_METHOD, { args: [token] }, host);
        })
        .catch(report);
    } else if (name === SESSION_RESUMED_EVENT && ended) {
      const reopening = ended;
      ended = null;
      void reopen(reopening).catch(report);
    }
  });
}
