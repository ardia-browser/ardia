import type { Program } from "./programs";

export type VaultTask = {
  id: string;
  connection: number;
  serving: () => boolean;
  profileId: string;
  engineProfile: string;
  origins: ReadonlySet<string>;
  program: Program;
  why: string;
  startedAt: number;
  expiresAt: number;
  tabs: Set<string>;
  logins: Map<string, string[]>;
  loginsLoading: Promise<void> | null;
  auto: Map<string, AutoFill>;
  busyTabs: Set<string>;
  sites: Map<string, SiteMemory>;
  siteKeys: Map<string, string>;
};

export type SiteMemory = { account: string | null; manualPending: number; manualEndedAt: number };

export type SignInAnswer = Record<string, unknown> & { status: string };

export type AutoFill = { documents: Set<string>; skipped: Set<string>; lastSuccess: number; failures: number; stopped: boolean };

export type GoneReason = "ended" | "expired" | "closed" | "locked";

export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 2 * 60 * 60;
export const MAX_SITES = 20;

const tasks = new Map<string, VaultTask>();
const byConnection = new Map<number, Set<string>>();
const byTab = new Map<string, Set<string>>();
const expiry = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(task: VaultTask, why: GoneReason) => void>();

export const onTaskGone = (listener: (task: VaultTask, why: GoneReason) => void) => (listeners.add(listener), () => void listeners.delete(listener));

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export function siteOrigin(site: string, allowLocalHttp: boolean): string | null {
  const trimmed = site.trim();
  if (!trimmed || trimmed.length > 512) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@\s]+)(?:[/?#]|$)/i.exec(absolute);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase().replace(/:443$/, scheme === "https" ? "" : ":443");
  const bare = host.replace(/:\d+$/, "");
  if (!/^[a-z0-9.\-[\]:]+$/.test(host) || bare.startsWith(".") || bare.endsWith(".") || !bare) return null;
  if (scheme === "https") return canonicalOrigin(`https://${host}`);
  if (scheme === "http" && allowLocalHttp && LOCAL_HOST.test(bare)) return canonicalOrigin(`http://${host}`);
  return null;
}

function canonicalOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    return parsed.hostname && parsed.origin !== "null" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function addTask(task: VaultTask) {
  tasks.set(task.id, task);
  if (!byConnection.has(task.connection)) byConnection.set(task.connection, new Set());
  byConnection.get(task.connection)!.add(task.id);
  for (const tab of task.tabs) driveTab(task, tab);
  expiry.set(task.id, setTimeout(() => dropTask(task.id, "expired"), Math.max(0, task.expiresAt - Date.now())));
}

export function driveTab(task: VaultTask, tab: string) {
  task.tabs.add(tab);
  if (!byTab.has(tab)) byTab.set(tab, new Set());
  byTab.get(tab)!.add(task.id);
}

export function dropTask(id: string, why: GoneReason): VaultTask | null {
  const task = tasks.get(id);
  if (!task) return null;
  tasks.delete(id);
  clearTimeout(expiry.get(id));
  expiry.delete(id);
  byConnection.get(task.connection)?.delete(id);
  if (!byConnection.get(task.connection)?.size) byConnection.delete(task.connection);
  for (const tab of task.tabs) {
    byTab.get(tab)?.delete(id);
    if (!byTab.get(tab)?.size) byTab.delete(tab);
  }
  for (const listener of listeners) listener(task, why);
  return task;
}

export function dropConnectionTasks(connection: number) {
  for (const id of [...(byConnection.get(connection) ?? [])]) dropTask(id, "closed");
}

export function dropAllTasks(why: GoneReason = "closed") {
  for (const id of [...tasks.keys()]) dropTask(id, why);
}

export const taskIsLive = (task: VaultTask, at = Date.now()) => tasks.get(task.id) === task && task.expiresAt > at && task.serving();

export function undriveTab(task: VaultTask, tab: string) {
  task.tabs.delete(tab);
  for (const key of [...task.auto.keys()]) if (key.startsWith(`${tab}\n`)) task.auto.delete(key);
  byTab.get(tab)?.delete(task.id);
  if (!byTab.get(tab)?.size) byTab.delete(tab);
}

export const drivenTabs = (): [VaultTask, string][] => [...tasks.values()].flatMap((task) => [...task.tabs].map((tab): [VaultTask, string] => [task, tab]));

export type TaskLookup = { task: VaultTask } | { problem: "task_expired" | "denied" };

export function taskFor(id: string, connection: number, at = Date.now()): TaskLookup {
  const task = tasks.get(id);
  if (!task) return { problem: "task_expired" };
  if (task.connection !== connection) return { problem: "denied" };
  if (task.expiresAt <= at || !task.serving()) {
    dropTask(id, task.expiresAt <= at ? "expired" : "closed");
    return { problem: "task_expired" };
  }
  return { task };
}

export function taskDrivingTab(tab: string, origin: string, at = Date.now()): VaultTask | null {
  const ids = byTab.get(tab);
  if (!ids) return null;
  for (const id of ids) {
    const task = tasks.get(id);
    if (task && task.expiresAt > at && task.serving() && task.origins.has(origin)) return task;
  }
  return null;
}

export const tasksOf = (connection: number) => [...(byConnection.get(connection) ?? [])].map((id) => tasks.get(id)!).filter(Boolean);
export const liveTaskCount = () => tasks.size;
