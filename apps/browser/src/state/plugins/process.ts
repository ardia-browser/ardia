import type { PluginManifest } from "../../lib/pluginManifest";
import { sendToPlugin, startPluginProcess, stopPluginProcess, type PluginExit, type PluginStartSpec } from "../../platform/plugins";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentNow, consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { isQuitting } from "../app/quit";
import { usePlugins, type ProcessState } from "./store";

export const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASH_LIMIT = 5;
export const STOP_GRACE_MS = 3000;
export const STOPPING_NOTICE_MS = 120;

type Supervised = { hash: string; folderId: string; manifest: PluginManifest; failures: number[]; timer: ReturnType<typeof setTimeout> | null; token: number; startingRun: number | null; liveRun: number | null };

const supervised = new Map<string, Supervised>();
const stopListeners = new Set<(name: string) => void>();
const stopping = new Map<string, Promise<void>>();
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

function targetRunOf(name: string, entry: Supervised): number | null {
  const state = usePlugins.getState().processes[name];
  if (state?.state === "running") return state.run;
  return entry.liveRun ?? entry.startingRun;
}

function noticeStopping(name: string, entry: Supervised): boolean {
  const state = usePlugins.getState().processes[name];
  if (isQuitting() || !entry.manifest.main || state?.state !== "running") return false;
  try {
    sendToPlugin(name, state.run, JSON.stringify({ event: "plugin.stopping", time: Date.now(), data: {} }));
    return true;
  } catch {
    return false;
  }
}

function stopNative(name: string, entry: Supervised, graceMs: number, consent: ConsentToken | null): Promise<void> {
  const targetRun = targetRunOf(name, entry);
  const noticed = targetRun !== null && noticeStopping(name, entry);
  const stop = () => (targetRun === null ? Promise.resolve() : stopPluginProcess(name, targetRun, graceMs));
  const begin = () => (noticed ? new Promise<void>((resolve) => setTimeout(resolve, STOPPING_NOTICE_MS)).then(stop) : stop());
  const prior = stopping.get(name);
  const waited = prior ? prior.then(begin) : begin();
  const done = waited.then(
    () => {},
    (error: unknown) => warnFor(consent, `[plugins] couldn't stop ${name}`, error),
  );
  stopping.set(name, done);
  void done.then(() => {
    if (stopping.get(name) === done) stopping.delete(name);
  });
  return done;
}

export function startSpec(name: string, entry: Pick<Supervised, "manifest" | "folderId" | "hash">, launchToken: number): PluginStartSpec {
  const m = entry.manifest;
  const base = { name, network: m.sidecar !== null && m.permissions.network !== false, folderId: entry.folderId, approved: entry.hash, page: m.contributes.panels.some((p) => !!p.file), launch: launchToken };
  if (m.main) return { ...base, runtime: "js", entry: m.main.entry, run: [], memoryMB: m.main.memoryMB };
  return { ...base, run: m.sidecar?.run ?? [], memoryMB: m.sidecar?.memoryMB ?? 0 };
}

async function launch(name: string, entry: Supervised, consent: ConsentToken | null) {
  const token = entry.token;
  entry.startingRun = null;
  setProcess(name, { state: "starting", run: 0, since: Date.now() });
  const pending = stopping.get(name);
  if (pending) await pending;
  if (supervised.get(name)?.token !== token) return;
  let started: Awaited<ReturnType<typeof startPluginProcess>>;
  try {
    started = await startPluginProcess(startSpec(name, entry, token));
  } catch (error) {
    started = { ok: false, reason: String(error) };
  }
  if (supervised.get(name)?.token !== token) {
    if (started.ok) void stopPluginProcess(name, started.run, 0);
    return;
  }
  if (!started.ok) return setProcess(name, { state: "failed", reason: started.reason });
  notePlugin("plugin_process_starts", consent);
  entry.liveRun = started.run;
  setProcess(name, { state: "running", run: started.run, since: Date.now() });
}

export function superviseProcess(name: string, hash: string, manifest: PluginManifest, folderId: string, consent: ConsentToken | null) {
  const current = supervised.get(name);
  if (current && current.hash === hash) return;
  if (current) stopProcess(name, consent);
  const entry: Supervised = { hash, folderId, manifest, failures: [], timer: null, token: ++tokens, startingRun: null, liveRun: null };
  supervised.set(name, entry);
  void launch(name, entry, consent);
}

export function stopProcess(name: string, consent: ConsentToken | null, graceMs = STOP_GRACE_MS) {
  const entry = supervised.get(name);
  if (!entry) return;
  supervised.delete(name);
  if (entry.timer) clearTimeout(entry.timer);
  void stopNative(name, entry, graceMs, consent);
  setProcess(name, null);
  stopped(name);
}

export function restartProcess(name: string) {
  const consent = consentNow();
  const entry = supervised.get(name);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.failures = [];
  const token = (entry.token = ++tokens);
  const stoppedNative = stopNative(name, entry, STOP_GRACE_MS, consent);
  entry.startingRun = null;
  entry.liveRun = null;
  setProcess(name, { state: "starting", run: 0, since: Date.now() });
  stopped(name);
  void stoppedNative.then(() => {
    if (supervised.get(name) === entry && entry.token === token) void launch(name, entry, consent);
  });
}

export function processExited(exit: PluginExit, now = Date.now()) {
  const consent = consentToken();
  const entry = supervised.get(exit.name);
  const state = usePlugins.getState().processes[exit.name];
  if (!entry || state?.state !== "running" || state.run !== exit.run) return;
  stopped(exit.name);
  const clean = !exit.overMemory && (exit.intended === true || (exit.status === 0 && exit.signal === null));
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

export const settledStops = (): Promise<void> => Promise.all([...stopping.values()]).then(() => {});
