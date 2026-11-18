import { changedIds } from "./changes";

export type RecordReads = { enumerated: boolean; entries: Map<string, Set<string> | null> };

export const noRecordReads = (): RecordReads => ({ enumerated: false, entries: new Map() });

export function trackedRecord<T extends object>(record: Record<string, T>, reads: RecordReads): Record<string, T> {
  const proxies = new Map<string, T>();
  const whole = (id: string) => void reads.entries.set(id, null);
  const trackedEntry = (id: string, entry: T) =>
    new Proxy(entry, {
      get(target, field, receiver) {
        if (typeof field === "string") reads.entries.get(id)?.add(field);
        return Reflect.get(target, field, receiver);
      },
      has(target, field) {
        whole(id);
        return Reflect.has(target, field);
      },
      ownKeys(target) {
        whole(id);
        return Reflect.ownKeys(target);
      },
    });
  return new Proxy(record, {
    get(target, id, receiver) {
      const entry = Reflect.get(target, id, receiver) as T | undefined;
      if (typeof id !== "string") return entry;
      if (!reads.entries.has(id)) reads.entries.set(id, new Set());
      if (!entry || typeof entry !== "object") return entry;
      let proxy = proxies.get(id);
      if (!proxy) proxies.set(id, (proxy = trackedEntry(id, entry)));
      return proxy;
    },
    has(target, id) {
      reads.enumerated = true;
      return Reflect.has(target, id);
    },
    ownKeys(target) {
      reads.enumerated = true;
      return Reflect.ownKeys(target);
    },
  });
}

export function recordReadsChanged<T extends object>(reads: RecordReads, next: Record<string, T>, prev: Record<string, T>): boolean {
  for (const id of changedIds(next, prev)) {
    const now = next[id] as Record<string, unknown> | undefined;
    const was = prev[id] as Record<string, unknown> | undefined;
    if (!now || !was) {
      if (reads.enumerated || reads.entries.has(id)) return true;
      continue;
    }
    const fields = reads.entries.get(id);
    if (fields === undefined) continue;
    if (fields === null) return true;
    for (const field of fields) if (now[field] !== was[field]) return true;
  }
  return false;
}
