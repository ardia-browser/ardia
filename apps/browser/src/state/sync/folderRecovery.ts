import { compact, folderTransport, type Clock, type FolderInfo, type LogFile, type ScopeState, type SyncNative, type Transport } from "../../platform/sync";
import { errorText } from "../../lib/errors";
import { isQuitting } from "../app/quit";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import type { ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { noteChainMissing, noteFolderRecreate, noteFolderUnavailable } from "./cycleWork";
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

type ChainGoneContext = { native: SyncNativeApi; doc: SyncDoc; folder: string; consent: ConsentToken | null; wasOffline: boolean; publish: (patch: Partial<SyncUi>) => void };

export async function publishChainGone(status: string, { native, doc, folder, consent, wasOffline, publish }: ChainGoneContext): Promise<boolean> {
  if (status === "unavailable") {
    if (!wasOffline) noteFolderUnavailable(consent);
    publish({ status: "offline", error: unavailableFolderError((await native.folderInfo?.(folder).catch(() => null)) ?? null), dataMissing: false });
    return true;
  }
  if (status !== "missing") return false;
  noteChainMissing(doc, folder, consent);
  publish({ status: "stalled", error: CHAIN_MISSING_TEXT, dataMissing: true });
  return true;
}

const chainGoneError = () => Object.assign(new Error("This device's data is gone from the sync folder"), { code: "ERR_SYNC_CHAIN_MISSING" });

export function chainCheckedTransport(native: SyncNativeApi, folder: string): { transport: Transport; confirmChain: () => Promise<void> } {
  const transport = folderTransport(native, folder);
  let unconfirmedEmptyRead = false;
  const read: Transport["read"] = async (scope, known) => {
    const listing = await transport.read(scope, known);
    if (listing.present.length) return listing;
    if (!known.length) unconfirmedEmptyRead = true;
    else if ((await native.chainStatus(folder)) !== "ok") throw chainGoneError();
    return listing;
  };
  const confirmChain = async () => {
    if (unconfirmedEmptyRead && (await native.chainStatus(folder)) !== "ok") throw chainGoneError();
  };
  return { transport: { ...transport, read }, confirmChain };
}

export type FolderLoss = "unavailable" | "missing" | "back" | null;

export async function folderLossAfter(native: SyncNativeApi, folder: string, error: unknown, firstLook: boolean): Promise<FolderLoss> {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "ERR_SYNC_CHAIN_MISSING" && code !== "ERR_SYNC_FOLDER") return null;
  const status = await native.chainStatus(folder).catch(() => null);
  if (status === "unavailable" || status === "missing") return status;
  if (status === "ok" && firstLook) return "back";
  return code === "ERR_SYNC_CHAIN_MISSING" ? "missing" : null;
}

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
    const left = (doc.reseedScopes ?? []).filter((entry) => entry !== scope);
    if (left.length) doc.reseedScopes = left;
    else delete doc.reseedScopes;
    save();
  }
}

export async function recreateChainFolder(
  ctx: ReseedContext & { saveNow: () => Promise<void>; consent: ConsentToken | null; onUpdating: () => void; publish: (patch: Partial<SyncUi>) => void },
): Promise<FolderRecreateResult> {
  const { native, doc, folder, consent, onUpdating, publish } = ctx;
  let created = false;
  try {
    const chain = await native.chainStatus(folder);
    if (chain === "ok") return { ok: "existing" };
    const info = await native.folderInfo?.(folder).catch(() => null);
    if (info && info.inICloud && !info.iCloudAvailable) {
      noteFolderRecreate("failed", consent);
      return { error: "cloudDriveOff" };
    }
    if (chain === "missing" || info?.exists) {
      noteFolderRecreate("failed", consent);
      return { error: "exists" };
    }
    const queued = doc.reseedScopes;
    const cycleOwed = doc.reseedCycleOwed;
    const putBack = async () => {
      if (queued) doc.reseedScopes = queued;
      else delete doc.reseedScopes;
      if (cycleOwed) doc.reseedCycleOwed = cycleOwed;
      else delete doc.reseedCycleOwed;
      await ctx.saveNow().catch(() => ctx.save());
    };
    const scopes = Object.entries(doc.scopes)
      .filter(([, state]) => hasScopeData(state))
      .map(([scope]) => scope);
    try {
      if (scopes.length) doc.reseedScopes = [...new Set([...(queued ?? []), ...scopes])];
      doc.reseedCycleOwed = true;
      await ctx.saveNow();
      const again = await native.folderInfo?.(folder).catch(() => null);
      if (again?.exists) {
        await putBack();
        noteFolderRecreate("failed", consent);
        return { error: "exists" };
      }
      if (isQuitting()) {
        await putBack();
        return { error: "busy" };
      }
      await native.createChainInNewFolder(folder);
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
      const lost = await folderLossAfter(native, folder, error, false);
      if (lost === "unavailable" || lost === "missing") await publishChainGone(lost, { native, doc, folder, consent, wasOffline: false, publish });
      else publish({ status: "stalled", error: message });
      return { error: "uploadFailed", message };
    }
    return { error: "failed", message };
  }
}
