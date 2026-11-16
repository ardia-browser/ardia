import { engineAvailable, hostCall } from "./host";

const OFF_THE_RECORD = "@";
const CLOSED_WINDOW_RELEASE_MS = 1000;

type Later = (run: () => void) => unknown;
type Hold = { name: string; released: boolean; made: Promise<boolean>; make(): Promise<boolean> };

const openWindows = new Map<string, number>();
const openPopups = new Map<string, number>();
const heldReleases = new Set<string>();
const releasedNames = new Set<string>();
const refusedHolds = new Set<Hold>();
let holds = 0;

export const isPrivateName = (name: string) => name.includes(OFF_THE_RECORD);

const parentOf = (name: string) => name.slice(name.indexOf(OFF_THE_RECORD) + 1);

const siblingsOpen = (name: string) =>
  [...openWindows.keys()].some((open) => open !== name && parentOf(open) === parentOf(name)) || [...openPopups.keys()].some((open) => parentOf(open) === parentOf(name));

const releaseInHost = (name: string) => hostCall("profile.release", { profile: name });

const afterClose: Later = (run) => setTimeout(run, CLOSED_WINDOW_RELEASE_MS);

const atOnce: Later = (run) => run();

function counted(holders: Map<string, number>, name: string, onLast: () => void): () => void {
  holders.set(name, (holders.get(name) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (holders.get(name) ?? 0) - 1;
    if (left > 0) return void holders.set(name, left);
    holders.delete(name);
    onLast();
  };
}

export function privateWindowShown(name: string, later: Later = afterClose): () => void {
  if (!isPrivateName(name)) return () => {};
  return counted(openWindows, name, () =>
    later(() => {
      if (!openWindows.has(name)) void releaseProfile(name, releaseInHost).catch(() => {});
    }),
  );
}

export function privatePopupShown(name: string, later: Later = atOnce): () => void {
  if (!isPrivateName(name)) return () => {};
  return counted(openPopups, name, () =>
    later(() => {
      if (!siblingsOpen(name) && !openWindows.has(name)) void sendHeldReleases(name, releaseInHost).catch(() => {});
    }),
  );
}

async function sendHeldReleases(name: string, send: (name: string) => Promise<unknown>) {
  const parent = parentOf(name);
  const due = [...heldReleases].filter((held) => parentOf(held) === parent);
  for (const held of due) heldReleases.delete(held);
  for (const released of due) await send(released);
}

export async function releaseProfile(name: string, send: (name: string) => Promise<unknown>): Promise<void> {
  if (!isPrivateName(name)) {
    await send(name);
    return;
  }
  if (releasedNames.has(name)) return;
  releasedNames.add(name);
  openWindows.delete(name);
  heldReleases.add(name);
  if (!siblingsOpen(name)) await sendHeldReleases(name, send);
}

export function holdPrivateSession(name: string, windowId: string): () => void {
  if (!isPrivateName(name) || !windowId || !engineAvailable()) return () => {};
  holds += 1;
  const key = `private-window:${windowId}:${holds}:${name}`;
  const hold: Hold = { name, released: false, made: Promise.resolve(false), make: () => Promise.resolve(false) };
  hold.make = () =>
    hostCall("tab.create", { key, url: "", profile: name }, windowId).then(
      () => {
        refusedHolds.delete(hold);
        privateSessionOpened(name);
        return true;
      },
      () => {
        if (!hold.released) refusedHolds.add(hold);
        return false;
      },
    );
  hold.made = hold.make();
  return () => {
    hold.released = true;
    refusedHolds.delete(hold);
    void hold.made.then((made) => (made ? hostCall("tab.close", { key }).catch(() => {}) : undefined));
  };
}

export function privateSessionOpened(name: string) {
  if (!isPrivateName(name)) return;
  const parent = parentOf(name);
  for (const hold of [...refusedHolds]) {
    if (parentOf(hold.name) !== parent) continue;
    refusedHolds.delete(hold);
    hold.made = hold.made.then((made) => (made || hold.released ? made : hold.make()));
  }
}
