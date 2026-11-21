import { startsEagerly, urlActivationHosts, type PluginManifest } from "../../lib/pluginManifest";
import { matchesAllowedHost } from "../../lib/pluginNetwork";
import { urlParts } from "../../lib/urlParts";
import { useBrowser } from "../browser/store";
import { isEligibleTab } from "../automation/automationWindows";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { activeManifest, currentPlugins, usePlugins, type PluginsStore } from "./store";
import { onProcessStopped, restartProcess, superviseProcess } from "./process";

export const ACTIVATION_TIMEOUT_MS = 10_000;

export class PluginActivationError extends Error {
  readonly plugin: string;
  constructor(plugin: string, message: string) {
    super(message);
    this.plugin = plugin;
    this.name = "PluginActivationError";
  }
}

type Waiter = { hash: string; trigger: string; consent: ConsentToken | null; resolve: (run: number) => void; reject: (error: PluginActivationError) => void; timer: ReturnType<typeof setTimeout> };

const activated = new Map<string, string>();
const readyRuns = new Map<string, number>();
const waiters = new Map<string, Set<Waiter>>();
const readyListeners = new Set<(name: string, run: number) => void>();

export const needsHost = (m: PluginManifest) => m.main !== null || m.sidecar !== null;
export const runsEagerly = (m: PluginManifest) => needsHost(m) && (m.main === null || startsEagerly(m.activationEvents));
export const shouldRun = (name: string, hash: string, m: PluginManifest) => runsEagerly(m) || activated.get(name) === hash;
export const isActivated = (name: string) => activated.has(name);

export function onPluginReady(listener: (name: string, run: number) => void): () => void {
  readyListeners.add(listener);
  return () => void readyListeners.delete(listener);
}

function readyRun(name: string, m: PluginManifest): number | null {
  const state = currentPlugins().processes[name];
  if (state?.state !== "running") return null;
  if (m.main === null) return state.run;
  return readyRuns.get(name) === state.run ? state.run : null;
}

export const pluginReadyRun = (name: string): number | null => {
  const m = activeManifest(currentPlugins(), name);
  return m ? readyRun(name, m) : null;
};

function settle(name: string, outcome: { run: number } | { reason: string }) {
  const pending = waiters.get(name);
  if (!pending) return;
  waiters.delete(name);
  for (const w of pending) {
    clearTimeout(w.timer);
    if ("run" in outcome) w.resolve(outcome.run);
    else w.reject(new PluginActivationError(name, outcome.reason));
  }
  if (!("run" in outcome)) notePlugin("plugin_activation_failures", pending.values().next().value?.consent ?? null);
}

export function markPluginReady(name: string, run: number): boolean {
  const state = currentPlugins().processes[name];
  if (state?.state !== "running" || state.run !== run) return false;
  readyRuns.set(name, run);
  settle(name, { run });
  for (const listener of [...readyListeners]) listener(name, run);
  return true;
}

function check(name: string) {
  const s = currentPlugins();
  const m = activeManifest(s, name);
  const hash = s.listings[name]?.hash ?? null;
  if (activated.has(name) && (!m || activated.get(name) !== hash)) activated.delete(name);
  const pending = waiters.get(name);
  if (!pending?.size) return;
  if (!m || !hash) return settle(name, { reason: `${name} was turned off.` });
  if ([...pending].some((w) => w.hash !== hash)) return settle(name, { reason: `${name} changed while it was starting.` });
  const state = s.processes[name];
  if (state?.state === "crashed" || state?.state === "failed") return settle(name, { reason: `${name} couldn't start: ${state.reason}.` });
  if (state?.state === "exited") return settle(name, { reason: `${name} exited before it was ready.` });
  const run = readyRun(name, m);
  if (run !== null) settle(name, { run });
}

export function checkActivations() {
  for (const name of new Set([...waiters.keys(), ...activated.keys()])) check(name);
}

export function ensurePluginActivated(name: string, trigger: string, timeoutMs = ACTIVATION_TIMEOUT_MS): Promise<number> {
  const s = currentPlugins();
  const m = activeManifest(s, name);
  const listing = s.listings[name];
  if (!m || !listing?.hash) return Promise.reject(new PluginActivationError(name, `There's no plugin ${name} that is on.`));
  if (!needsHost(m)) return Promise.reject(new PluginActivationError(name, `${name} has no main or sidecar to run.`));
  const run = readyRun(name, m);
  if (run !== null) return Promise.resolve(run);
  const state = s.processes[name];
  if (state?.state === "crashed" || state?.state === "failed") return Promise.reject(new PluginActivationError(name, `${name} stopped: ${state.reason}. Restart it in Settings › Plugins.`));
  const hash = listing.hash;
  const consent = consentToken();
  if (activated.get(name) !== hash) {
    activated.set(name, hash);
    notePlugin("plugin_activations", consent);
  }
  const promise = new Promise<number>((resolve, reject) => {
    const set = waiters.get(name) ?? new Set<Waiter>();
    waiters.set(name, set);
    const waiter: Waiter = {
      hash,
      trigger,
      consent,
      resolve,
      reject,
      timer: setTimeout(() => {
        set.delete(waiter);
        if (!set.size) waiters.delete(name);
        notePlugin("plugin_activation_failures", consent);
        reject(new PluginActivationError(name, `${name} didn't get ready in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs),
    };
    set.add(waiter);
  });
  if (state?.state === "exited") restartProcess(name);
  else superviseProcess(name, hash, m, listing.folderId, consent);
  return promise;
}

export function deactivatePlugin(name: string) {
  activated.delete(name);
  readyRuns.delete(name);
  settle(name, { reason: `${name} was turned off.` });
}

let watching = false;

function urlTriggers(tabs: ReturnType<typeof useBrowser.getState>["tabs"], before: ReturnType<typeof useBrowser.getState>["tabs"]) {
  const s = currentPlugins();
  const wanted = s.order.flatMap((name) => {
    const m = activeManifest(s, name);
    const hosts = m?.main ? urlActivationHosts(m.activationEvents) : [];
    return hosts.length && pluginReadyRun(name) === null ? [{ name, hosts }] : [];
  });
  if (!wanted.length) return;
  const browser = useBrowser.getState();
  for (const [id, tab] of Object.entries(tabs)) {
    if (before[id]?.url === tab.url || !isEligibleTab(browser, id)) continue;
    const host = urlParts(tab.url)?.host;
    if (!host) continue;
    for (const w of wanted) if (matchesAllowedHost(host, w.hosts)) void ensurePluginActivated(w.name, `onUrl:${host}`).catch(() => {});
  }
}

const hasUrlActivation = (s: Pick<PluginsStore, "listings" | "records" | "order">) =>
  s.order.some((name) => {
    const m = activeManifest(s, name);
    return !!m?.main && urlActivationHosts(m.activationEvents).length > 0;
  });

let stopUrlWatch: (() => void) | null = null;

function syncUrlWatch(s: Pick<PluginsStore, "listings" | "records" | "order">) {
  const wanted = hasUrlActivation(s);
  if (wanted && !stopUrlWatch) stopUrlWatch = useBrowser.subscribeTo(["tabs"], (now, prev) => urlTriggers(now.tabs, prev.tabs));
  else if (!wanted && stopUrlWatch) {
    stopUrlWatch();
    stopUrlWatch = null;
  }
}

export const watchingUrlActivation = () => stopUrlWatch !== null;

export function watchActivation() {
  if (watching) return;
  watching = true;
  usePlugins.subscribe((s, prev) => {
    if (s.processes !== prev.processes || s.listings !== prev.listings || s.records !== prev.records) checkActivations();
    if (s.listings !== prev.listings || s.records !== prev.records || s.order !== prev.order) syncUrlWatch(s);
  });
  onProcessStopped((name) => void readyRuns.delete(name));
  syncUrlWatch(currentPlugins());
}
