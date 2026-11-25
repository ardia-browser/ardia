import type { LivePersistenceBinding, LiveProjection } from "../../browser/src/platform/livePersistence";
import { ardiaHost } from "./host";
import { createLiveDocumentClient } from "./liveDocumentClient";
import { registerDocumentProducer } from "./documentFlush";
import { documentError } from "./liveDocumentTypes";

function nativeProjection(projection: LiveProjection): LiveProjection {
  const folders = projection.folders;
  if (!folders || typeof folders !== "object") return projection;
  return {
    ...projection,
    folders: Object.fromEntries(Object.entries(folders).map(([id, folder]) => {
      const { spaceId, ...fields } = folder as Record<string, unknown>;
      return [id, spaceId === undefined ? fields : { ...fields, profileId: spaceId }];
    })),
  };
}

export function createLivePersistence(onSave?: (changed: boolean, kind?: "write" | "intent") => void): LivePersistenceBinding {
  if (!ardiaHost) throw documentError("ERR_DOCUMENT_AUTH", "Linux Live persistence requires a native shell");
  const client = createLiveDocumentClient(ardiaHost);
  registerDocumentProducer(client);
  return {
    load: () => ({}),
    start: client.start,
    changed: (before, after, intent) => {
      const queued = client.changed(nativeProjection(before), nativeProjection(after), intent);
      if (queued !== undefined) onSave?.(queued, "intent");
    },
    newFolderId: () => `lf-${crypto.randomUUID()}`,
    completionFence: client.completionFence,
    beginRefresh: client.beginRefresh,
    flush: () => { void client.flush(); },
  };
}
