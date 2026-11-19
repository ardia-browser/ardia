import { useBrowser, type BrowserState } from "../browser/store";
import { pinKeyOf } from "../browser/model";
import { fromSync } from "../pins/pinOrderChoices";
import { sessionSaved } from "../session/persist";
import { saveBeforeQuit } from "../app/quit";
import { guardGroupClose, keepGroupsOpen } from "../groups/closeGuard";
import { confirmRemovingShared, sharedFolderOfGroup } from "./removal";
import { isRegularWindow } from "../windows/small";
import { cancelSharedFolderWrite, onSharedFolderChange, readSharedFolder, sharedFoldersAvailable, watchSharedFolders, writeSharedFolder } from "../../platform/sharedFolders";
import { APPLIED_FIELDS, withFolder } from "./applyFolder";
import { knownNames, localFolder, signatureOf } from "./local";
import { mergeFolder } from "./merge";
import { planFiles } from "./plan";
import { remoteLevel } from "./remote";
import { boundFolders, folderRef, saveFoldersNow, setFolderBase, setFolderSync, sharedFolderOf, unbindFolder, useSharedFolders } from "./store";

type Place = { kind: "shown"; groupId: string } | { kind: "hidden" } | { kind: "gone" };

const LOCAL_SETTLE_MS = 300;
const REMOTE_SETTLE_MS = 150;
const POLL_MS = 60_000;
const CONFLICT_RETRY_MS = 3000;
const CANCEL_CHECK_MS = 50;
export const STOP_WAIT_MS = 10_000;

const store = () => useBrowser.getState();
const always = () => true;

export function folderPlace(s: BrowserState, profileId: string, key: string): Place {
  if (!s.profiles[profileId]) return { kind: "gone" };
  const order = [...s.ui.focusOrder, ...s.windowOrder];
  const rank = (windowId: string) => {
    const i = order.indexOf(windowId);
    return i < 0 ? order.length : i;
  };
  const copies = Object.values(s.groups)
    .filter((g) => g.pinned && !g.parentId && g.profileId === profileId && pinKeyOf(g) === key && isRegularWindow(s.windows[g.windowId]))
    .sort((a, z) => rank(a.windowId) - rank(z.windowId));
  if (copies[0]) return { kind: "shown", groupId: copies[0].id };
  if (s.parkedPins[profileId]?.groups.some((g) => g.id === key)) return { kind: "hidden" };
  const shows = Object.values(s.windows).some((w) => isRegularWindow(w) && w.tabIds.some((id) => s.tabs[id]?.profileId === profileId));
  return shows ? { kind: "gone" } : { kind: "hidden" };
}

type Guard = () => boolean;

const signatures = new Map<string, string>();
const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; allowed: Guard }>();
const running = new Map<string, Promise<void>>();
const queued = new Map<string, Guard>();
const producedBy = new Map<string, { signature: string; allowed: Guard }>();
const writes = new Map<string, string>();
let nextToken = 0;
export const RECONNECT = "Ardia can’t confirm which folder this is any more. Pick it again with Reconnect Folder to keep syncing it.";

const either = (a: Guard | undefined, b: Guard): Guard => (!a || a === b ? b : a === always || b === always ? always : () => a() || b());

function schedule(profileId: string, key: string, delay: number, allowed: Guard = always) {
  const ref = folderRef(profileId, key);
  const was = timers.get(ref);
  clearTimeout(was?.timer);
  const guard = either(was?.allowed, allowed);
  const fire = () => {
    timers.delete(ref);
    void syncFolderNow(profileId, key, guard);
  };
  timers.set(ref, { timer: setTimeout(fire, delay), allowed: guard });
}

const queue = (ref: string, allowed: Guard) => void queued.set(ref, either(queued.get(ref), allowed));

export async function syncFolderAfterNow(profileId: string, key: string, allowed: Guard = always): Promise<void> {
  await running.get(folderRef(profileId, key));
  if (allowed()) await syncFolderNow(profileId, key, allowed);
}

export function syncFolderNow(profileId: string, key: string, allowed: Guard = always): Promise<void> {
  const ref = folderRef(profileId, key);
  const busy = running.get(ref);
  if (busy && allowed !== always) return busy.then(() => (allowed() ? syncFolderNow(profileId, key, allowed) : undefined));
  if (busy) {
    queue(ref, always);
    return busy;
  }
  const bound = sharedFolderOf(profileId, key);
  const run = round(profileId, key, allowed)
    .catch((error: unknown) => {
      if (sharedFolderOf(profileId, key) !== bound) return queue(ref, allowed);
      if (allowed()) setFolderSync(profileId, key, { state: "error", error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      running.delete(ref);
      const next = queued.get(ref);
      if (!next) return;
      queued.delete(ref);
      schedule(profileId, key, REMOTE_SETTLE_MS, next);
    });
  running.set(ref, run);
  return run;
}

async function round(profileId: string, key: string, allowed: Guard) {
  const ref = folderRef(profileId, key);
  const folder = sharedFolderOf(profileId, key);
  if (!folder) return;
  const place = folderPlace(store(), profileId, key);
  if (place.kind !== "shown") {
    signatures.set(ref, place.kind);
    if (place.kind === "gone") unbindFolder(profileId, key);
    else setFolderSync(profileId, key, { state: "paused" });
    return;
  }
  if (!folder.identity) return setFolderSync(profileId, key, { state: "reconnect", error: RECONNECT });
  const identity = folder.identity;
  const listing = await readSharedFolder(folder.path, identity);
  const stale = () => sharedFolderOf(profileId, key) !== folder;
  if (!allowed()) return;
  if (stale()) return queue(ref, allowed);
  if (!listing.exists) {
    if (listing.error) return setFolderSync(profileId, key, { state: "error", error: listing.error });
    signatures.set(ref, signatureOf(localFolder(store(), place.groupId, knownNames(folder.base))));
    return setFolderSync(profileId, key, { state: "missing", error: null });
  }
  const remote = remoteLevel(listing.root);
  const s = store();
  const here = folderPlace(s, profileId, key);
  if (here.kind !== "shown") return queue(ref, allowed);
  if (!allowed()) return;
  const local = localFolder(s, here.groupId, knownNames(folder.base));
  if (!local) return;
  const tag = producedBy.get(ref);
  const diskWins = !!tag && !tag.allowed() && signatureOf(local) === tag.signature;
  const { level, waiting } = mergeFolder(folder.base, local.entries, remote);
  const next = withFolder(s, here.groupId, level, local);
  if (next !== s) {
    fromSync(() => useBrowser.setState(Object.fromEntries(APPLIED_FIELDS.map((f) => [f, next[f]]))));
    producedBy.set(ref, { signature: signatureOf(localFolder(store(), here.groupId, knownNames(folder.base))), allowed });
  }
  const planned = planFiles(level, folder.base);
  const { base } = planned;
  const ops = diskWins ? [] : planned.ops;
  const settled = signatureOf(localFolder(store(), here.groupId, knownNames(base)));
  const saved = await sessionSaved();
  if (!allowed()) return;
  if (!saved) {
    schedule(profileId, key, CONFLICT_RETRY_MS, allowed);
    return setFolderSync(profileId, key, { state: "syncing", error: null });
  }
  if (stale()) return queue(ref, allowed);
  const { conflicts, cancelled } = ops.length ? await guardedWrite(ref, folder.path, ops, identity, () => allowed() && !stale()) : { conflicts: [], cancelled: false };
  if (stale()) return queue(ref, allowed);
  if (!allowed() || cancelled) return;
  if (conflicts.length) {
    schedule(profileId, key, CONFLICT_RETRY_MS, allowed);
    return setFolderSync(profileId, key, { state: "syncing", error: null });
  }
  setFolderBase(profileId, key, base);
  signatures.set(ref, settled);
  producedBy.delete(ref);
  checkLocal();
  setFolderSync(profileId, key, { state: waiting ? "waiting" : "synced", waiting, error: null });
}

async function guardedWrite(ref: string, path: string, ops: Parameters<typeof writeSharedFolder>[1], identity: Parameters<typeof writeSharedFolder>[2], still: Guard) {
  const token = `w${++nextToken}`;
  writes.set(ref, token);
  const watch = setInterval(() => {
    if (!still()) cancelSharedFolderWrite(token);
  }, CANCEL_CHECK_MS);
  try {
    const result = await writeSharedFolder(path, ops, identity, token);
    return { conflicts: result.conflicts, cancelled: !!result.cancelled };
  } finally {
    clearInterval(watch);
    if (writes.get(ref) === token) writes.delete(ref);
  }
}

export async function stopSyncing(profileId: string, key: string): Promise<boolean> {
  const ref = folderRef(profileId, key);
  clearTimeout(timers.get(ref)?.timer);
  timers.delete(ref);
  queued.delete(ref);
  producedBy.delete(ref);
  unbindFolder(profileId, key);
  const token = writes.get(ref);
  if (token) cancelSharedFolderWrite(token);
  const busy = running.get(ref);
  if (!busy) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), STOP_WAIT_MS)));
  const finished = await Promise.race([busy.then(() => true, () => true), timedOut]);
  clearTimeout(timer);
  return finished;
}

function checkLocal() {
  const s = store();
  for (const { profileId, key, folder } of boundFolders()) {
    const place = folderPlace(s, profileId, key);
    const signature = place.kind === "shown" ? signatureOf(localFolder(s, place.groupId, knownNames(folder.base))) : place.kind;
    const ref = folderRef(profileId, key);
    if (signature === signatures.get(ref)) continue;
    const produced = producedBy.get(ref);
    schedule(profileId, key, LOCAL_SETTLE_MS, produced?.signature === signature ? produced.allowed : always);
  }
}

const boundPaths = () => [...new Set(boundFolders().map((b) => b.folder.path))].sort();

let watched = "";
function watchBound() {
  const paths = boundPaths();
  if (paths.join("\n") === watched) return;
  watched = paths.join("\n");
  watchSharedFolders(paths);
}

export const syncAllFolders = () => boundFolders().forEach(({ profileId, key }) => schedule(profileId, key, 0));

let checkTimer: ReturnType<typeof setTimeout> | undefined;

export function startSharedFolders() {
  if (!sharedFoldersAvailable()) return;
  guardGroupClose(confirmRemovingShared);
  keepGroupsOpen((groupId) => !!sharedFolderOfGroup(store(), groupId));
  saveBeforeQuit(saveFoldersNow);
  watchBound();
  useSharedFolders.subscribe((s, prev) => {
    if (s.folders !== prev.folders) watchBound();
  });
  onSharedFolderChange((paths) => {
    for (const { profileId, key, folder } of boundFolders()) if (paths.includes(folder.path)) schedule(profileId, key, REMOTE_SETTLE_MS);
  });
  useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.groups === prev.groups && s.windows === prev.windows && s.ui.focusOrder === prev.ui.focusOrder) return;
    if (!boundFolders().length) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkLocal, LOCAL_SETTLE_MS);
  });
  setInterval(syncAllFolders, POLL_MS);
  syncAllFolders();
}
