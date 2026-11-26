import { create } from "zustand";
import { startsEagerly, type PluginManifest } from "../../lib/pluginManifest";
import { pluginUsage, type PluginUsageRow } from "../../platform/plugins";
import { showToast } from "../app/toasts";
import { lastFocusedEligibleWindow } from "../automation/automationWindows";
import { useBrowser } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { activeManifest, currentPlugins, usePlugins } from "./store";

export const WATCHDOG = {
  sampleMs: 5000,
  cpuShare: 0.9,
  cpuSamples: 3,
  memoryShare: 0.95,
  ipcPerSecond: 400,
  ipcSeconds: 3,
  idleDefaultSec: 300,
  idleMaxSec: 1800,
  idleCheckMs: 30_000,
} as const;

export type PauseReason = "cpu" | "memory" | "ipc";
export type PluginHealth = { status: "running" | "sleeping" | "paused" | "starting" | "stopped" | "failed"; memoryBytes: number | null; contentTabs: number; channels: number; lastError: string | null; paused: PauseReason | null };

type Sample = { cpuMs: number; at: number; hot: number };
type Ipc = { second: number; count: number; hotSeconds: number };

const PAUSE_TITLES: Record<PauseReason, string> = { cpu: "Paused for high CPU", memory: "Paused for high memory use", ipc: "Paused for too many requests" };
const COUNTS = { cpu: "plugin_watchdog_cpu", memory: "plugin_watchdog_memory", ipc: "plugin_watchdog_ipc" } as const;

export const usePluginHealth = create<{ rows: Record<string, PluginHealth> }>()(() => ({ rows: {} }));

const samples = new Map<string, Sample>();
const ipc = new Map<string, Ipc>();
const lastActive = new Map<string, number>();
const pausedFor = new Map<string, PauseReason>();
const sleeping = new Set<string>();

type Hooks = {
  stop(name: string, consent: ConsentToken | null): void;
  sleep(name: string, consent: ConsentToken | null): void;
  busy(name: string): boolean;
  contentTabs(name: string): number;
  pauseScripts(name: string, pause: boolean): void;
  resume(consent: ConsentToken | null): void;
  sidecarRun(plugin: string): number | null;
};

const SIDECAR_SUFFIX = "/sidecar";
export const ownerOfRow = (row: Pick<PluginUsageRow, "name">) => (row.name.endsWith(SIDECAR_SUFFIX) ? { plugin: row.name.slice(0, -SIDECAR_SUFFIX.length), sidecar: true } : { plugin: row.name, sidecar: false });
let hooks: Hooks | null = null;

export const pausedReason = (name: string): PauseReason | null => pausedFor.get(name) ?? null;
export const isSleeping = (name: string) => sleeping.has(name);

export const markUsed = (name: string, now = Date.now()) => void lastActive.set(name, now);

export function noteActivity(name: string, consent: ConsentToken | null, now = Date.now()) {
  lastActive.set(name, now);
  if (sleeping.delete(name)) notePlugin("plugin_idle_wakes", consent);
}

export function noteRequest(name: string, consent: ConsentToken | null, now = Date.now()): boolean {
  noteActivity(name, consent, now);
  const second = Math.floor(now / 1000);
  const entry = ipc.get(name) ?? { second, count: 0, hotSeconds: 0 };
  if (entry.second !== second) {
    entry.hotSeconds = entry.count > WATCHDOG.ipcPerSecond && second - entry.second === 1 ? entry.hotSeconds + 1 : 0;
    entry.second = second;
    entry.count = 0;
  }
  entry.count++;
  ipc.set(name, entry);
  if (entry.count > WATCHDOG.ipcPerSecond && entry.hotSeconds + 1 >= WATCHDOG.ipcSeconds) {
    pausePlugin(name, "ipc", consent);
    return false;
  }
  return true;
}

export function pausePlugin(name: string, reason: PauseReason, consent: ConsentToken | null) {
  if (pausedFor.has(name)) return;
  pausedFor.set(name, reason);
  notePlugin(COUNTS[reason], consent);
  hooks?.pauseScripts(name, true);
  hooks?.stop(name, consent);
  const m = activeManifest(currentPlugins(), name);
  const windowId = lastFocusedEligibleWindow(useBrowser.getState());
  if (windowId) showToast(windowId, PAUSE_TITLES[reason], `${m?.title ?? name} is paused. Resume it in Settings › Plugins.`, { key: `plugin-paused-${name}` });
  refreshHealth();
}

export function resumePlugin(name: string, consent: ConsentToken | null = null) {
  if (!pausedFor.delete(name)) return;
  for (const key of [...samples.keys()]) if (key.startsWith(`${name}#`) || key.startsWith(`${name}${SIDECAR_SUFFIX}#`)) samples.delete(key);
  ipc.delete(name);
  hooks?.pauseScripts(name, false);
  hooks?.resume(consent);
  refreshHealth();
}

export const idleTimeoutOf = (m: PluginManifest) => {
  const given = typeof m.v3.idleTimeoutSec === "number" ? m.v3.idleTimeoutSec : WATCHDOG.idleDefaultSec;
  return Math.min(WATCHDOG.idleMaxSec, Math.max(30, given));
};

const sleepsWhenIdle = (m: PluginManifest) => m.main !== null && !startsEagerly(m.activationEvents) && m.hooks.length === 0 && m.permissions.state === false;

export function checkIdle(consent: ConsentToken | null, now = Date.now(), usage: PluginUsageRow[] = []) {
  const s = currentPlugins();
  for (const name of s.order) {
    const m = activeManifest(s, name);
    const state = s.processes[name];
    if (!m || state?.state !== "running" || !sleepsWhenIdle(m)) continue;
    const since = lastActive.get(name) ?? state.since;
    if (now - since < idleTimeoutOf(m) * 1000) continue;
    const row = usage.find((u) => u.name === name);
    if ((row && row.streams + row.sockets > 0) || hooks?.busy(name) || (hooks?.contentTabs(name) ?? 0) > 0) continue;
    sleeping.add(name);
    notePlugin("plugin_idle_sleeps", consent);
    hooks?.sleep(name, consent);
  }
}

export function checkUsage(rows: PluginUsageRow[], consent: ConsentToken | null, now = Date.now(), sidecarRun: (plugin: string) => number | null = () => null) {
  const s = currentPlugins();
  for (const row of rows) {
    const { plugin, sidecar } = ownerOfRow(row);
    const m = activeManifest(s, plugin);
    if (!m || pausedFor.has(plugin)) continue;
    const state = s.processes[plugin];
    const current = sidecar ? sidecarRun(plugin) : state?.state === "running" ? state.run : null;
    if (current !== row.run) continue;
    const limitMB = sidecar ? (m.sidecar?.memoryMB ?? 0) : (m.main?.memoryMB ?? m.sidecar?.memoryMB ?? 0);
    if (limitMB > 0 && row.memoryBytes > limitMB * 1024 * 1024 * WATCHDOG.memoryShare) {
      pausePlugin(plugin, "memory", consent);
      continue;
    }
    const before = samples.get(`${row.name}#${row.run}`);
    const share = before ? (row.cpuMs - before.cpuMs) / Math.max(1, now - before.at) : 0;
    const hot = share >= WATCHDOG.cpuShare ? (before?.hot ?? 0) + 1 : 0;
    samples.set(`${row.name}#${row.run}`, { cpuMs: row.cpuMs, at: now, hot });
    if (hot >= WATCHDOG.cpuSamples) pausePlugin(plugin, "cpu", consent);
  }
  refreshHealth(rows);
}

let lastRows: PluginUsageRow[] = [];

export function refreshHealth(rows: PluginUsageRow[] = lastRows) {
  lastRows = rows;
  const s = currentPlugins();
  const out: Record<string, PluginHealth> = {};
  for (const name of s.order) {
    const m = activeManifest(s, name);
    if (!m || (!m.main && !m.sidecar)) continue;
    const state = s.processes[name];
    const row = rows.find((r) => r.name === name && state?.state === "running" && r.run === state.run);
    const sidecarRun = hooks?.sidecarRun(name) ?? null;
    const sidecarRow = sidecarRun === null ? undefined : rows.find((r) => r.name === `${name}${SIDECAR_SUFFIX}` && r.run === sidecarRun);
    const paused = pausedFor.get(name) ?? null;
    const status: PluginHealth["status"] = paused ? "paused" : sleeping.has(name) ? "sleeping" : state?.state === "running" ? "running" : state?.state === "starting" || state?.state === "waiting" ? "starting" : state?.state === "crashed" || state?.state === "failed" ? "failed" : "stopped";
    const lastError = paused ? PAUSE_TITLES[paused] : state?.state === "crashed" || state?.state === "failed" ? state.reason : null;
    const memory = row && status === "running" ? row.memoryBytes + (sidecarRow?.memoryBytes ?? 0) : null;
    out[name] = { status, memoryBytes: memory, contentTabs: hooks?.contentTabs(name) ?? 0, channels: row ? row.streams + row.sockets : 0, lastError, paused };
  }
  usePluginHealth.setState({ rows: out });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let idleAt = 0;
let sampling = false;

async function sample(consent: ConsentToken | null) {
  if (sampling) return;
  sampling = true;
  try {
    const rows = await pluginUsage().catch(() => [] as PluginUsageRow[]);
    checkUsage(rows, consent, Date.now(), hooks?.sidecarRun ?? (() => null));
  } finally {
    sampling = false;
  }
}

const anyRunning = () => Object.values(currentPlugins().processes).some((p) => p.state === "running");

const unref = (handle: ReturnType<typeof setTimeout>) => (handle as { unref?: () => void }).unref?.();

function tick() {
  timer = null;
  if (!anyRunning()) return;
  const consent = consentToken();
  void sample(consent).then(() => {
    const now = Date.now();
    if (now - idleAt >= WATCHDOG.idleCheckMs) {
      idleAt = now;
      checkIdle(consent, now, lastRows);
    }
    syncTimers();
  });
}

function syncTimers() {
  if (timer || !anyRunning()) return;
  timer = setTimeout(tick, WATCHDOG.sampleMs);
  unref(timer);
}

export function startWatchdog(given: Hooks) {
  if (hooks) return;
  hooks = given;
  usePlugins.subscribe((s, prev) => {
    if (s.processes !== prev.processes || s.order !== prev.order) {
      syncTimers();
      refreshHealth();
    }
  });
  syncTimers();
}

export function forgetWatchdog(name: string) {
  lastActive.delete(name);
  ipc.delete(name);
  for (const key of [...samples.keys()]) if (key.startsWith(`${name}#`)) samples.delete(key);
}
