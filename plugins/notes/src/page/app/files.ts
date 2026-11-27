import { useCallback, useEffect, useState } from "react";
import type { NotesClient } from "../client/types";

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();

export function fileUrl(client: NotesClient, workspace: string, ref: string): Promise<string> {
  const key = `${workspace}|${ref}`;
  const known = urls.get(key);
  if (known) return Promise.resolve(known);
  let promise = pending.get(key);
  if (!promise) {
    promise = client.fileUrl(workspace, ref).then((url) => {
      urls.set(key, url);
      pending.delete(key);
      for (const listener of [...listeners]) listener();
      return url;
    });
    promise.catch(() => pending.delete(key));
    pending.set(key, promise);
  }
  return promise;
}

export function useFileIcon(client: NotesClient | null, workspace: string) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useCallback(
    (ref: string) => {
      if (!client || !ref.startsWith("file:")) return null;
      const url = urls.get(`${workspace}|${ref}`);
      if (url) return url;
      void fileUrl(client, workspace, ref).catch(() => {});
      return null;
    },
    [client, workspace],
  );
}

export function useFileUrl(client: NotesClient, workspace: string, ref: string): string | null {
  const resolve = useFileIcon(client, workspace);
  return ref.startsWith("file:") ? resolve(ref) : null;
}
