export const CLI_HOLD_DEFAULT_S = 120;
export const CLI_HOLD_MAX_S = 300;
export const CLI_HOLD_MAX_TABS = 32;
const CLI_HOLD_MAX_SESSIONS = 4;

type Lease = { tabs: ReadonlySet<string>; until: number; ends: ReturnType<typeof setTimeout> };

const leases = new Map<string, Lease>();
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
  clearTimeout(lease.ends);
  leases.delete(session);
  return true;
}

function endWhenDue(session: string) {
  const lease = leases.get(session);
  if (!lease) return;
  if (lease.until > clock()) lease.ends = setTimeout(() => endWhenDue(session), lease.until - clock());
  else if (drop(session)) changed();
}

type HoldOutcome = { started: string[] } | { refused: string };

export function holdForCli(session: string, tabIds: readonly string[], seconds = CLI_HOLD_DEFAULT_S): HoldOutcome {
  const now = clock();
  prune(now);
  if (!leases.has(session) && leases.size >= CLI_HOLD_MAX_SESSIONS) return { refused: `At most ${CLI_HOLD_MAX_SESSIONS} sessions can hold tabs at once.` };
  const before = leases.get(session)?.tabs ?? new Set<string>();
  const tabs = new Set(tabIds.slice(0, CLI_HOLD_MAX_TABS));
  drop(session);
  if (tabs.size > 0) {
    const ms = Math.min(Math.max(seconds, 1), CLI_HOLD_MAX_S) * 1000;
    leases.set(session, { tabs, until: now + ms, ends: setTimeout(() => endWhenDue(session), ms) });
  }
  changed();
  return { started: [...tabs].filter((id) => !before.has(id)) };
}

export function releaseFromCli(session: string): string[] {
  const tabs = [...(leases.get(session)?.tabs ?? [])];
  if (drop(session)) changed();
  return tabs;
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

export function releaseAllCliHolds(): void {
  if (leases.size === 0) return;
  for (const session of [...leases.keys()]) drop(session);
  changed();
}
