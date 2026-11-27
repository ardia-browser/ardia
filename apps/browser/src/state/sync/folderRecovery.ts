import { compact, folderTransport, type Clock, type FolderInfo, type LogFile, type ScopeState, type SyncNative } from "../../platform/sync";
import { errorText } from "../../lib/errors";
import { isQuitting } from "../app/quit";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import type { ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { noteChainStatus, noteFolderRecreate, noteFolderUnavailable } from "./cycleWork";
import { historyExpired } from "./historyAdapter";
import { APP_SCOPE, type SyncDoc, type SyncStatus, type SyncUi } from "./syncDoc";

type SyncNativeApi = NonNullable<typeof SyncNative>;

export type FolderRecreateResult =
  | { ok: "recreated" | "existing" }
  | { error: "cloudDriveOff" | "exists" | "busy" | "locked" }
  | { error: "failed" | "uploadFailed"; message: string };

export function syncStatusLine(status: SyncStatus, lastSyncedAt: number | null, pending: number, formatAgo: (at: number) => string, firstSync = false): string {
  const since = lastSyncedAt ? formatAgo(lastSyncedAt) : null;
  const line = (() => {
    if (firstSync && (status === "starting" || status === "updating" || status === "updated")) return "First sync in progress";
    switch (status) {
      case "starting":
        return "Starting up";
      case "updating":
        return "Updating";
      case "offline":
        return since ? `Sync folder unavailable · last synced ${since}` : "Sync folder unavailable";
      case "stalled":
      case "locked":
        return since ? `Not syncing · last synced ${since}` : "Not syncing";
      default:
        return since && since !== "just now" ? `Updated ${since}` : "Updated just now";
    }
  })();
  return pending ? `${line} · waiting for ${pending === 1 ? "1 file" : `${pending} files`} to download` : line;
}

export function unavailableFolderError(info: Pick<FolderInfo, "inICloud" | "iCloudAvailable" | "exists"> | null): string {
  if (info && info.inICloud && !info.iCloudAvailable) {
    return `${PLATFORM_TERMS.cloudDrive} is off on this ${PLATFORM_TERMS.computer}. ${PLATFORM_TERMS.turnOnCloudDrive} to keep syncing.`;
  }
  if (info && !info.exists) {
    return "The sync folder is missing. Reconnect its drive, wait for it to finish syncing, or recreate it to resume syncing.";
  }
  return "The sync folder isn’t available. Check that it’s still there and that Ardia can open it.";
}

export const CHAIN_MISSING_TEXT = `This device is out of sync. Sync may have been reset from another device, or the sync folder hasn’t finished syncing. Everything on this ${PLATFORM_TERMS.computer} is kept, and sync carries on once its data is back. To set sync up again, choose Stop Syncing.`;

type ChainGoneContext = { native: SyncNativeApi; folder: string; device: string; consent: ConsentToken | null; wasOffline: boolean; publish: (patch: Partial<SyncUi>) => void };

export async function publishChainGone(status: string, { native, folder, device, consent, wasOffline, publish }: ChainGoneContext): Promise<boolean> {
  if (status === "unavailable") {
    if (!wasOffline) noteFolderUnavailable(consent);
    publish({ status: "offline", error: unavailableFolderError((await native.folderInfo?.(folder).catch(() => null)) ?? null), dataMissing: false });
    return true;
  }
  if (status !== "missing") return false;
  noteChainStatus(consent, device, "missing");
  publish({ status: "stalled", error: CHAIN_MISSING_TEXT, dataMissing: true });
  return true;
}

export const chainStatusAfterMissingWrite = (native: SyncNativeApi, folder: string) =>
  native.chainStatus(folder).then((status) => (status === "unavailable" ? status : "missing"), () => "missing");

const createInNewFolder = (native: SyncNativeApi, folder: string) => (native.createChainInNewFolder ? native.createChainInNewFolder(folder) : native.createChain(folder));

const folderExistsError = (error: unknown) => (error as { code?: unknown } | null)?.code === "ERR_SYNC_FOLDER_EXISTS";

export function folderRecreateMessage(result: FolderRecreateResult, label: string): string | null {
  if ("ok" in result) return null;
  switch (result.error) {
    case "cloudDriveOff":
      return `${PLATFORM_TERMS.cloudDrive} is off on this ${PLATFORM_TERMS.computer}. ${PLATFORM_TERMS.turnOnCloudDrive} to keep syncing.`;
    case "exists":
      return "A folder already exists there. Sync will check it in a moment.";
    case "busy":
      return "Sync is busy. Try again in a moment.";
    case "locked":
      return "Enter your recovery phrase before recreating the sync folder.";
    case "uploadFailed":
      return null;
    case "failed":
      return `Couldn’t recreate the sync folder at ${label}: ${result.message.replace(/\.+$/, "")}.`;
  }
}

export const hasScopeData = (state: ScopeState) =>
  Object.keys(state.records).length > 0 || state.outbox.length > 0 || (state.journal?.length ?? 0) > 0 || Object.keys(state.vv).length > 0;

export type ReseedContext = {
  native: SyncNativeApi;
  doc: SyncDoc;
  folder: string;
  device: string;
  clock: Clock;
  watchScope: (scope: string, state: ScopeState, clock: Clock) => () => Promise<void>;
  persistJournal: (scope: string) => (batches: LogFile[]) => Promise<void>;
  save: () => void;
};

export async function reseedPendingScopes({ native, doc, folder, device, clock, watchScope, persistJournal, save }: ReseedContext) {
  const transport = folderTransport(native, folder);
  for (const scope of [...(doc.reseedScopes ?? [])]) {
    const state = doc.scopes[scope];
    if (state && hasScopeData(state)) {
      const settled = watchScope(scope, state, clock);
      try {
        state.files = {};
        state.damaged = {};
        delete state.pendingSince;
        state.pending = 0;
        await compact(
          state,
          transport,
          scope,
          device,
          Date.now(),
          { ...(scope === APP_SCOPE ? {} : { expired: historyExpired }), persist: persistJournal(scope) },
          true,
        );
      } finally {
        await settled();
      }
    }
    if (!state || !hasScopeData(state)) continue;
    const left = (doc.reseedScopes ?? []).filter((entry) => entry !== scope);
    if (left.length) doc.reseedScopes = left;
    else delete doc.reseedScopes;
    save();
  }
}

export async function recreateChainFolder(
  ctx: ReseedContext & { saveNow: () => Promise<void>; consent: ConsentToken | null; onUpdating: () => void; onUploadError: (message: string) => void },
): Promise<FolderRecreateResult> {
  const { native, doc, folder, consent, onUpdating, onUploadError } = ctx;
  let created = false;
  try {
    const chain = await native.chainStatus(folder);
    if (chain === "ok") return { ok: "existing" };
    if (chain === "missing") {
      noteFolderRecreate("failed", consent);
      return { error: "exists" };
    }
    const info = await native.folderInfo?.(folder).catch(() => null);
    if (info && info.inICloud && !info.iCloudAvailable) {
      noteFolderRecreate("failed", consent);
      return { error: "cloudDriveOff" };
    }
    if (info?.exists) {
      noteFolderRecreate("failed", consent);
      return { error: "exists" };
    }
    const queued = doc.reseedScopes;
    const putBack = async () => {
      if (queued) doc.reseedScopes = queued;
      else delete doc.reseedScopes;
      await ctx.saveNow().catch(() => ctx.save());
    };
    const scopes = Object.entries(doc.scopes)
      .filter(([, state]) => hasScopeData(state))
      .map(([scope]) => scope);
    try {
      doc.reseedScopes = [...new Set([...(queued ?? []), APP_SCOPE, ...scopes])];
      await ctx.saveNow();
      if ((await native.folderInfo?.(folder).catch(() => null))?.exists) {
        await putBack();
        noteFolderRecreate("failed", consent);
        return { error: "exists" };
      }
      if (isQuitting()) {
        await putBack();
        return { error: "busy" };
      }
      await createInNewFolder(native, folder);
    } catch (error) {
      await putBack();
      if (!folderExistsError(error)) throw error;
      noteFolderRecreate("failed", consent);
      return { error: "exists" };
    }
    created = true;
    onUpdating();
    if (doc.reseedScopes?.length) await reseedPendingScopes(ctx);
    noteFolderRecreate("recreated", consent);
    return { ok: "recreated" };
  } catch (error) {
    const message = errorText(error);
    noteFolderRecreate("failed", consent);
    if (created) {
      warnFor(consent, "[sync] recreating sync folder failed while uploading data", error);
      onUploadError(message);
      return { error: "uploadFailed", message };
    }
    return { error: "failed", message };
  }
}
