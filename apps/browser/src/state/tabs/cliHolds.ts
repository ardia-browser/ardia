export const CLI_HOLD_DEFAULT_S = 120;
export const CLI_HOLD_MAX_S = 300;
export const CLI_HOLD_MAX_TABS = 32;
const CLI_HOLD_MAX_SESSIONS = 4;

type Lease = { tabs: ReadonlySet<string>; until: number; ends: ReturnType<typeof setTimeout> | null; connection: number | null; live: boolean };

export type CliHoldOptions = { connection?: number; live?: boolean };

const tetheredKey = (connection: number, session: string) => `${connection}\u0000${session}`;

const leases = new Map<string, Lease>();
let releasedOnDisconnect = 0;

export const drainDisconnectReleases = (): number => {
  const released = releasedOnDisconnect;
  releasedOnDisconnect = 0;
  return released;
};
const listeners = new Set<() => void>();
let clock = () => performance.now();

export const cliHoldsClockForTests = (now: () => number) => void (clock = now);

const changed = () => {
  for (const listener of listeners) listener();
};

export function onCliHoldsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function prune(now: number): boolean {
  let dropped = false;
  for (const [session, lease] of leases) if (lease.until <= now) dropped = drop(session) || dropped;
  return dropped;
}

function drop(session: string): boolean {
  const lease = leases.get(session);
  if (!lease) return false;
  if (lease.ends !== null) clearTimeout(lease.ends);
  leases.delete(session);
  return true;
}

function endWhenDue(session: string) {
  const lease = leases.get(session);
  if (!lease) return;
  if (lease.until > clock()) lease.ends = setTimeout(() => endWhenDue(session), lease.until - clock());
  else if (drop(session)) changed();
}

type HoldOutcome = { started: string[]; liveStarted: string[] } | { refused: string };

export function holdForCli(session: string, tabIds: readonly string[], seconds = CLI_HOLD_DEFAULT_S, options: CliHoldOptions = {}): HoldOutcome {
  const now = clock();
  prune(now);
  const connection = options.connection !== undefined && options.connection > 0 ? options.connection : null;
  const key = connection === null ? session : tetheredKey(connection, session);
  if (!leases.has(key) && leases.size >= CLI_HOLD_MAX_SESSIONS) return { refused: `At most ${CLI_HOLD_MAX_SESSIONS} sessions can hold tabs at once.` };
  const previous = leases.get(key);
  const before = previous?.tabs ?? new Set<string>();
  const wasLive = previous?.live ? before : new Set<string>();
  const tabs = new Set(tabIds.slice(0, CLI_HOLD_MAX_TABS));
  const live = options.live === true;
  drop(key);
  if (tabs.size > 0 && connection !== null) leases.set(key, { tabs, until: Infinity, ends: null, connection, live });
  else if (tabs.size > 0) {
    const ms = Math.min(Math.max(seconds, 1), CLI_HOLD_MAX_S) * 1000;
    leases.set(key, { tabs, until: now + ms, ends: setTimeout(() => endWhenDue(key), ms), connection: null, live });
  }
  changed();
  return { started: [...tabs].filter((id) => !before.has(id)), liveStarted: live ? [...tabs].filter((id) => !wasLive.has(id)) : [] };
}

export function releaseCliHoldsOf(connection: number): string[] {
  const released = new Set<string>();
  for (const [session, lease] of [...leases]) {
    if (lease.connection !== connection) continue;
    for (const tab of lease.tabs) released.add(tab);
    drop(session);
  }
  releasedOnDisconnect += released.size;
  if (released.size > 0) changed();
  return [...released];
}

export function releaseFromCli(session: string, connection?: number): string[] {
  const keys = connection !== undefined && connection > 0 ? [session, tetheredKey(connection, session)] : [session];
  const tabs = new Set(keys.flatMap((key) => [...(leases.get(key)?.tabs ?? [])]));
  let dropped = false;
  for (const key of keys) dropped = drop(key) || dropped;
  if (dropped) changed();
  return [...tabs];
}

export function heldByCli(tabId: string): boolean {
  const now = clock();
  for (const lease of leases.values()) if (lease.until > now && lease.tabs.has(tabId)) return true;
  return false;
}

export function tabsHeldByCli(): string[] {
  const now = clock();
  return [...new Set([...leases.values()].flatMap((lease) => (lease.until > now ? [...lease.tabs] : [])))];
}

export function cliHoldsLeft(wallNow = Date.now()): { tabId: string; until: number; live: boolean }[] {
  const now = clock();
  const left = new Map<string, { ms: number; live: boolean }>();
  for (const lease of leases.values()) {
    if (lease.until <= now) continue;
    const ms = Math.min(lease.until - now, CLI_HOLD_MAX_S * 1000);
    for (const tabId of lease.tabs) {
      const had = left.get(tabId);
      left.set(tabId, { ms: Math.max(had?.ms ?? 0, ms), live: (had?.live ?? false) || lease.live });
    }
  }
  return [...left].map(([tabId, { ms, live }]) => ({ tabId, until: wallNow + ms, live }));
}

export const cliHoldsTethered = (): boolean => [...leases.values()].some((lease) => lease.connection !== null);

export function releaseAllCliHolds(): void {
  if (leases.size === 0) return;
  for (const session of [...leases.keys()]) drop(session);
  changed();
}
