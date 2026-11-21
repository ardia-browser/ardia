import type { PluginManifest } from "../../lib/pluginManifest";
import { startPluginProcess, stopPluginProcess, type PluginExit } from "../../platform/plugins";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentNow, consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { isQuitting } from "../app/quit";
import { usePlugins, type ProcessState } from "./store";

export const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASH_LIMIT = 5;
export const STOP_GRACE_MS = 3000;

type Supervised = { hash: string; folderId: string; manifest: PluginManifest; failures: number[]; timer: ReturnType<typeof setTimeout> | null; token: number; startingRun: number | null };

const supervised = new Map<string, Supervised>();
const stopListeners = new Set<(name: string) => void>();
let tokens = 0;

export function acceptsRun(name: string, run: number): boolean {
  const entry = supervised.get(name);
  if (isQuitting() || !entry) return false;
  const state = usePlugins.getState().processes[name];
  if (state?.state === "running") return run === state.run;
  return state?.state === "starting" && entry.startingRun === run;
}

export function acceptsLine(name: string, run: number, launch: number): boolean {
  const entry = supervised.get(name);
  if (isQuitting() || !entry) return false;
  const state = usePlugins.getState().processes[name];
  if (state?.state === "running") return run === state.run;
  if (state?.state !== "starting" || launch !== entry.token) return false;
  entry.startingRun ??= run;
  return entry.startingRun === run;
}

export const onProcessStopped = (listener: (name: string) => void) => {
  stopListeners.add(listener);
  return () => void stopListeners.delete(listener);
};

function setProcess(name: string, state: ProcessState | null) {
  usePlugins.setState((s) => {
    const processes = { ...s.processes };
    if (state) processes[name] = state;
    else delete processes[name];
    return { processes };
  });
}

const stopped = (name: string) => {
  for (const listener of stopListeners) listener(name);
};

async function launch(name: string, entry: Supervised, consent: ConsentToken | null) {
  const token = entry.token;
  entry.startingRun = null;
  setProcess(name, { state: "starting", run: 0, since: Date.now() });
  const m = entry.manifest;
  let started: Awaited<ReturnType<typeof startPluginProcess>>;
  try {
    started = await startPluginProcess({ name, run: m.process!.run, memoryMB: m.process!.memoryMB, network: m.permissions.includes("network"), folderId: entry.folderId, approved: entry.hash, page: !!m.page, launch: token });
  } catch (error) {
    started = { ok: false, reason: String(error) };
  }
  if (supervised.get(name)?.token !== token) {
    if (started.ok) void stopPluginProcess(name, started.run, 0);
    return;
  }
  if (!started.ok) return setProcess(name, { state: "failed", reason: started.reason });
  notePlugin("plugin_process_starts", consent);
  setProcess(name, { state: "running", run: started.run, since: Date.now() });
}

export function superviseProcess(name: string, hash: string, manifest: PluginManifest, folderId: string, consent: ConsentToken | null) {
  const current = supervised.get(name);
  if (current && current.hash === hash) return;
  if (current) stopProcess(name, consent);
  const entry: Supervised = { hash, folderId, manifest, failures: [], timer: null, token: ++tokens, startingRun: null };
  supervised.set(name, entry);
  void launch(name, entry, consent);
}

export function stopProcess(name: string, consent: ConsentToken | null, graceMs = STOP_GRACE_MS) {
  const entry = supervised.get(name);
  if (!entry) return;
  supervised.delete(name);
  if (entry.timer) clearTimeout(entry.timer);
  setProcess(name, null);
  stopped(name);
  void stopPluginProcess(name, 0, graceMs).catch((error: unknown) => warnFor(consent, `[plugins] couldn't stop ${name}`, error));
}

export function restartProcess(name: string) {
  const consent = consentNow();
  const entry = supervised.get(name);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.failures = [];
  const token = (entry.token = ++tokens);
  entry.startingRun = null;
  setProcess(name, { state: "starting", run: 0, since: Date.now() });
  stopped(name);
  void stopPluginProcess(name, 0, STOP_GRACE_MS).then(() => {
    if (supervised.get(name) === entry && entry.token === token) void launch(name, entry, consent);
  });
}

export function processExited(exit: PluginExit, now = Date.now()) {
  const consent = consentToken();
  const entry = supervised.get(exit.name);
  const state = usePlugins.getState().processes[exit.name];
  if (!entry || state?.state !== "running" || state.run !== exit.run) return;
  stopped(exit.name);
  const clean = exit.status === 0 && exit.signal === null && !exit.overMemory;
  if (clean) return setProcess(exit.name, { state: "exited" });
  notePlugin("plugin_process_crashes", consent);
  entry.failures = [...entry.failures.filter((t) => now - t < CRASH_WINDOW_MS), now];
  const reason = exit.overMemory ? "went over its memory limit" : exit.signal !== null ? `stopped by signal ${exit.signal}` : `exited with status ${exit.status}`;
  if (entry.failures.length >= CRASH_LIMIT) return setProcess(exit.name, { state: "crashed", reason });
  const delay = RESTART_DELAYS_MS[Math.min(entry.failures.length - 1, RESTART_DELAYS_MS.length - 1)]!;
  setProcess(exit.name, { state: "waiting", until: now + delay, failures: entry.failures.length });
  const token = entry.token;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (supervised.get(exit.name) === entry && entry.token === token) void launch(exit.name, entry, consent);
  }, delay);
}

export const supervisedNames = () => [...supervised.keys()];
