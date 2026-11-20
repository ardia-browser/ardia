import { forgetThumbnails as forgetStoredThumbnails } from "../../platform/files";

type ForgetListener = (paths: readonly string[] | null) => void;

const listeners = new Set<ForgetListener>();

export function onThumbnailsForgotten(listener: ForgetListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function forgetThumbnails(paths?: readonly string[]) {
  const named = paths?.filter((path) => !!path);
  if (named && !named.length) return;
  for (const listener of listeners) listener(named ?? null);
  void forgetStoredThumbnails(named).catch(() => {});
}
