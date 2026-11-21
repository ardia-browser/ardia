export type SystemLookNow = { reduceMotion: boolean; reduceTransparency: boolean };

export type SystemLookSource = {
  read: () => SystemLookNow | null;
  readLater: () => Promise<SystemLookNow>;
  watch: (changed: (now: SystemLookNow) => void) => () => void;
  onResume: (resumed: () => void) => () => void;
};

const unknown: SystemLookNow = { reduceMotion: false, reduceTransparency: false };

export function createSystemLookStore(source: SystemLookSource) {
  let now = source.read() ?? unknown;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const set = (next: SystemLookNow) => {
    if (next.reduceMotion === now.reduceMotion && next.reduceTransparency === now.reduceTransparency) return;
    now = { reduceMotion: next.reduceMotion, reduceTransparency: next.reduceTransparency };
    for (const listener of [...listeners]) listener();
  };
  const refresh = () => {
    const known = source.read();
    if (known) set(known);
    else source.readLater().then(set, () => undefined);
  };
  return {
    get: () => now,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) {
        const unwatch = source.watch(set);
        const unresume = source.onResume(refresh);
        stop = () => {
          unwatch();
          unresume();
        };
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
}
