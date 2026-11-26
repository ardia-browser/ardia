import type { PluginManifest } from "../../lib/pluginManifest";
import { callPlugin, sendToPlugin, startPluginProcess, stopPluginProcess, type PluginExit } from "../../platform/plugins";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { pluginReadyRun } from "./activation";
import { activeManifest, currentPlugins } from "./store";

export const SIDECAR_SUFFIX = "/sidecar";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING = 32;
const MAX_LINE = 1 << 20;
const RESTART_DELAYS_MS = [1000, 4000, 16000];
const CRASH_LIMIT = 3;
const STOP_GRACE_MS = 2000;

type Pending = { resolve: (body: Body) => void; timer: ReturnType<typeof setTimeout> };
type Sidecar = { name: string; hash: string; run: number | null; token: number; failures: number; timer: ReturnType<typeof setTimeout> | null; pending: Map<string, Pending>; next: number };

const sidecars = new Map<string, Sidecar>();
let tokens = 0;

export const isSidecarKey = (name: string) => name.endsWith(SIDECAR_SUFFIX);
const pluginOfKey = (key: string) => key.slice(0, -SIDECAR_SUFFIX.length);
export const isHybrid = (m: PluginManifest) => m.main !== null && m.sidecar !== null;

async function launch(entry: Sidecar, consent: ConsentToken | null) {
  const s = currentPlugins();
  const m = activeManifest(s, entry.name);
  const listing = s.listings[entry.name];
  if (!m?.sidecar || !listing?.hash || listing.hash !== entry.hash) return;
  const token = (entry.token = ++tokens);
  const started = await startPluginProcess({
    name: entry.name,
    run: m.sidecar.run,
    memoryMB: m.sidecar.memoryMB,
    network: m.permissions.network !== false,
    folderId: listing.folderId,
    approved: listing.hash,
    page: false,
    launch: token,
    runtime: "process",
    sidecar: true,
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (sidecars.get(entry.name) !== entry || entry.token !== token) {
    if (started.ok) void stopPluginProcess(entry.name + SIDECAR_SUFFIX, started.run, 0);
    return;
  }
  if (!started.ok) return void (entry.run = null);
  entry.run = started.run;
  notePlugin("plugin_sidecar_starts", consent);
}

export function syncSidecar(name: string) {
  const s = currentPlugins();
  const m = activeManifest(s, name);
  const hash = s.listings[name]?.hash ?? null;
  const wanted = !!m && isHybrid(m) && hash !== null && pluginReadyRun(name) !== null;
  const current = sidecars.get(name);
  if (current && (!wanted || current.hash !== hash)) stopSidecar(name);
  if (!wanted || sidecars.has(name)) return;
  const entry: Sidecar = { name, hash: hash!, run: null, token: 0, failures: 0, timer: null, pending: new Map(), next: 0 };
  sidecars.set(name, entry);
  void launch(entry, consentToken());
}

export function stopSidecar(name: string) {
  const entry = sidecars.get(name);
  if (!entry) return;
  sidecars.delete(name);
  if (entry.timer) clearTimeout(entry.timer);
  for (const [, p] of entry.pending) {
    clearTimeout(p.timer);
    p.resolve(failure("failed", "The plugin's sidecar stopped."));
  }
  if (entry.run !== null) void stopPluginProcess(name + SIDECAR_SUFFIX, entry.run, STOP_GRACE_MS).catch(() => undefined);
}

export function sidecarExited(exit: PluginExit, consent: ConsentToken | null) {
  const entry = sidecars.get(pluginOfKey(exit.name));
  if (!entry || entry.run !== exit.run) return;
  entry.run = null;
  for (const [, p] of entry.pending) {
    clearTimeout(p.timer);
    p.resolve(failure("failed", "The plugin's sidecar exited."));
  }
  entry.pending.clear();
  entry.failures++;
  if (entry.failures > CRASH_LIMIT) return notePlugin("plugin_sidecar_failures", consent);
  const delay = RESTART_DELAYS_MS[Math.min(entry.failures - 1, RESTART_DELAYS_MS.length - 1)]!;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (sidecars.get(entry.name) === entry) void launch(entry, consent);
  }, delay);
}

export function sidecarLine(key: string, run: number, line: string, consent: ConsentToken | null) {
  const entry = sidecars.get(pluginOfKey(key));
  if (!entry || entry.run !== run || line.length > MAX_LINE) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  if (typeof record.id === "string" && ("result" in record || "error" in record)) {
    const pending = entry.pending.get(record.id);
    if (!pending) return;
    entry.pending.delete(record.id);
    clearTimeout(pending.timer);
    const error = record.error;
    if (error !== undefined && error !== null) {
      notePlugin("plugin_sidecar_failures", consent);
      return pending.resolve(failure("failed", typeof error === "string" ? error.slice(0, 500) : typeof (error as { message?: unknown }).message === "string" ? String((error as { message: string }).message).slice(0, 500) : "The sidecar failed."));
    }
    return pending.resolve({ result: record.result ?? null });
  }
  if (record.event === "message") {
    const mainRun = pluginReadyRun(entry.name);
    if (mainRun !== null) sendToPlugin(entry.name, mainRun, JSON.stringify({ event: "sidecar.message", time: Date.now(), data: { message: record.data ?? null } }));
  }
}

function ready(name: string, m: PluginManifest): Sidecar | Body {
  if (!isHybrid(m)) return failure("refused", "This plugin has no sidecar beside its main.");
  const entry = sidecars.get(name);
  if (!entry || entry.run === null) return failure("failed", "The plugin's sidecar isn't running yet.");
  return entry;
}

export function sidecarMethod(c: { name: string; run: number }, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  const consent = consentToken();
  const entry = ready(c.name, m);
  if (!("pending" in entry)) return entry;
  let line: string;
  if (method === "sidecar.send") {
    try {
      line = JSON.stringify({ event: "message", data: params.message ?? null });
    } catch {
      return failure("bad_request", "message isn't JSON.");
    }
    if (line.length > MAX_LINE) return failure("bad_request", "message is over 1 MB.");
    callPlugin(c.name + SIDECAR_SUFFIX, entry.run!, line);
    return { result: { ok: true } };
  }
  if (typeof params.method !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(params.method)) return failure("bad_request", "sidecar.request needs a method name.");
  if (entry.pending.size >= MAX_PENDING) return failure("failed", "The sidecar has too many requests waiting.");
  const id = `s${++entry.next}`;
  try {
    line = JSON.stringify({ id, method: params.method, params: params.params ?? null });
  } catch {
    return failure("bad_request", "params aren't JSON.");
  }
  if (line.length > MAX_LINE) return failure("bad_request", "params are over 1 MB.");
  notePlugin("plugin_sidecar_requests", consent);
  return new Promise<Body>((resolve) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      notePlugin("plugin_sidecar_failures", consent);
      resolve(failure("failed", `The sidecar didn't answer ${String(params.method)} in ${REQUEST_TIMEOUT_MS / 1000} s.`));
    }, REQUEST_TIMEOUT_MS);
    entry.pending.set(id, { resolve, timer });
    callPlugin(c.name + SIDECAR_SUFFIX, entry.run!, line);
  });
}

export const sidecarRunning = (name: string) => sidecars.get(name)?.run != null;

export const sidecarRunOf = (name: string): number | null => sidecars.get(name)?.run ?? null;
