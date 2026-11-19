import type { LivePersistenceBinding } from "../../browser/src/platform/livePersistence";
import { ardiaHost } from "./host";
import { createLiveDocumentClient } from "./liveDocumentClient";
import { registerDocumentProducer } from "./documentFlush";
import { documentError } from "./liveDocumentTypes";

let markLoaded: () => void = () => {};
export const liveDocumentLoaded = new Promise<void>((resolve) => { markLoaded = resolve; });

let current: ReturnType<typeof createLiveDocumentClient> | undefined;
export const liveDurability = {
  mark: () => current?.drops() ?? 0,
  save: (mark: number) => current ? current.flushDurably(mark) : Promise.reject(documentError("ERR_DOCUMENT_AUTH", "Linux Live persistence requires a native shell")),
};

export function createLivePersistence(onSave?: (changed: boolean, kind?: "write" | "intent") => void): LivePersistenceBinding {
  if (!ardiaHost) throw documentError("ERR_DOCUMENT_AUTH", "Linux Live persistence requires a native shell");
  const client = createLiveDocumentClient(ardiaHost);
  current = client;
  registerDocumentProducer(client);
  return {
    load: () => ({}),
    start: (apply) => client.start((payload, invalidated) => {
      apply(payload, invalidated);
      if (client.state().canonical.revision >= 0) markLoaded();
    }),
    changed: (before, after, intent) => {
      const queued = client.changed(before, after, intent);
      if (queued !== undefined) onSave?.(queued, "intent");
    },
    newFolderId: () => `lf-${crypto.randomUUID()}`,
    completionFence: client.completionFence,
    beginRefresh: client.beginRefresh,
    flush: () => { void client.flush(); },
    saveDurably: () => client.flushDurably(),
  };
}
