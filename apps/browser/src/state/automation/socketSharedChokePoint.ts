import { useBrowser, type BrowserState } from "../browser/store";
import { folderPlace } from "../sharedFolders/engine";
import { knownNames, localFolder, signatureOf } from "../sharedFolders/local";
import { boundFolders, folderRef } from "../sharedFolders/store";
import { syncWriteHooks } from "../sharedFolders/syncWriteHooks";
import { foreignWriteHooks } from "../browser/foreignWriteHooks";
import { withTreesFrom } from "./sharedTrees";
import { SHARED_GROUPS_SIDEBAR_ONLY } from "./workspaceSharedGuard";

export const SHARED_GROUP_CHANGE_REFUSED = `That would change a group synced to a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}. The change that reached it was undone.`;

function syncedProjection(s: BrowserState): Map<string, string> {
  const out = new Map<string, string>();
  for (const { profileId, key, folder } of boundFolders()) {
    const place = folderPlace(s, profileId, key);
    out.set(folderRef(profileId, key), place.kind === "shown" ? `shown:${signatureOf(localFolder(s, place.groupId, knownNames(folder.base)))}` : place.kind);
  }
  return out;
}

export function changesSharedFolders(before: BrowserState, after: BrowserState): boolean {
  if (before === after) return false;
  const was = syncedProjection(before);
  const now = syncedProjection(after);
  for (const [ref, then] of was) {
    const current = now.get(ref) ?? "gone";
    if (then === current || then === "gone") continue;
    if (current === "gone") return true;
    if (then.startsWith("shown:") && current.startsWith("shown:")) return true;
  }
  return false;
}

type Check = { owner: SocketOrigin; before: BrowserState };

let open: Check | null = null;

function endCheck(owner?: SocketOrigin) {
  const check = open;
  if (!check || (owner && check.owner !== owner)) return;
  open = null;
  const now = useBrowser.getState();
  if (!changesSharedFolders(check.before, now)) return;
  useBrowser.setState(withTreesFrom(now, check.before), true);
  check.owner.vetoed = true;
}

function openCheck(owner: SocketOrigin) {
  open = { owner, before: useBrowser.getState() };
  queueMicrotask(() => endCheck(owner));
}

function aroundForeignWrite(write: () => void) {
  const check = open;
  if (!check) return write();
  endCheck(check.owner);
  try {
    write();
  } finally {
    if (!check.owner.answered && !open) openCheck(check.owner);
  }
}

syncWriteHooks.around = aroundForeignWrite;
foreignWriteHooks.around = aroundForeignWrite;

export class SocketOrigin {
  vetoed = false;
  answered = false;

  segment() {
    if (this.answered || open?.owner === this) return;
    if (open) endCheck(open.owner);
    openCheck(this);
  }

  settle<B>(body: B, refused: (message: string) => B): B {
    endCheck(this);
    this.answered = true;
    return this.vetoed ? refused(SHARED_GROUP_CHANGE_REFUSED) : body;
  }
}

export const READ_ONLY_ORIGIN: Pick<SocketOrigin, "segment"> = { segment() {} };

export function guardedBySocketOrigin<B>(mutates: boolean, run: (origin: Pick<SocketOrigin, "segment">) => B | Promise<B>, refused: (message: string) => B): B | Promise<B> {
  if (!mutates) return run(READ_ONLY_ORIGIN);
  const origin = new SocketOrigin();
  origin.segment();
  let body: B | Promise<B>;
  try {
    body = run(origin);
  } catch (error) {
    endCheck(origin);
    origin.answered = true;
    throw error;
  }
  if (body instanceof Promise) {
    return body.then(
      (settled) => origin.settle(settled, refused),
      (error) => {
        endCheck(origin);
        origin.answered = true;
        return Promise.reject(error);
      },
    );
  }
  return origin.settle(body, refused);
}
