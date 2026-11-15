export const KILL_SWITCHES_URL = "https://ardia.dev/switches.json";

type Fetched = { status: number; body: string };
type Fetch = typeof fetch;

const urlOf = (input: RequestInfo | URL): string => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const aborted = () => new DOMException("The operation was aborted.", "AbortError");

export function nativeSwitchesFetch(fetchNative: () => Promise<Fetched | undefined>, original: Fetch): Fetch {
  return (input, init) => {
    if (urlOf(input) !== KILL_SWITCHES_URL) return original(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise<Response>((resolve, reject) => {
      const stop = () => reject(aborted());
      signal?.addEventListener("abort", stop, { once: true });
      fetchNative().then(
        (fetched) => {
          signal?.removeEventListener("abort", stop);
          if (!fetched?.status) return reject(new TypeError("Failed to fetch"));
          resolve(new Response(fetched.body, { status: fetched.status }));
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", stop);
          reject(error instanceof Error ? error : new TypeError("Failed to fetch"));
        },
      );
    });
  };
}

