import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

const KILL_SWITCHES_METHOD = "ArdiaShell.fetchKillSwitches";
const KILL_SWITCHES_URL = "https://ardia.dev/switches.json";

type Fetched = { status: number; body: string };
type AbortListening = Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener">;

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

export function untilAborted<T>(work: Promise<T>, signal: AbortListening | null | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    const settle = <V>(finish: (value: V) => void) => (value: V) => {
      signal.removeEventListener("abort", abort);
      finish(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(settle(resolve), settle(reject));
  });
}

export const killSwitchesAvailable = (host: ArdiaHost) => hostSupports(KILL_SWITCHES_METHOD, host);

export function hostSwitchesFetch(host: ArdiaHost, original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== KILL_SWITCHES_URL) return original(input, init);
    if (init?.signal?.aborted) throw abortError();
    const fetched = await untilAborted(invokeHost<Fetched>(KILL_SWITCHES_METHOD, { args: [] }, host), init?.signal);
    if (!fetched || !fetched.status || typeof fetched.body !== "string") throw new TypeError("Failed to fetch");
    return new Response(fetched.body, { status: fetched.status });
  };
}
