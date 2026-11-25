const exitListeners = new Map<string, Set<() => void>>();

export function signalFullScreenExit(windowId: string) {
  const runs = exitListeners.get(windowId);
  if (runs) for (const run of [...runs]) run();
}

export function onFullScreenExit(windowId: string, run: () => void): () => void {
  let runs = exitListeners.get(windowId);
  if (!runs) exitListeners.set(windowId, (runs = new Set()));
  runs.add(run);
  return () => {
    runs.delete(run);
    if (!runs.size && exitListeners.get(windowId) === runs) exitListeners.delete(windowId);
  };
}
