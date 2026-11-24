type IdleScheduler = { request: (run: () => void, timeoutMs: number) => unknown; cancel: (handle: unknown) => void };

const idleScheduler = (): IdleScheduler => {
  const host = globalThis as { requestIdleCallback?: (run: () => void, options: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void };
  if (typeof host.requestIdleCallback === "function" && typeof host.cancelIdleCallback === "function") {
    const request = host.requestIdleCallback;
    const cancel = host.cancelIdleCallback;
    return { request: (run, timeoutMs) => request(run, { timeout: timeoutMs }), cancel: (handle) => cancel(handle as number) };
  }
  return { request: (run) => setTimeout(run, 0), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
};

export function whenIdle(run: () => void, afterMs: number, timeoutMs: number): () => void {
  const scheduler = idleScheduler();
  let handle: unknown = null;
  const quiet = setTimeout(() => {
    handle = scheduler.request(run, timeoutMs);
  }, afterMs);
  return () => {
    clearTimeout(quiet);
    if (handle !== null) scheduler.cancel(handle);
  };
}
