import { callPlugin, sendToPlugin } from "../../platform/plugins";
import type { SurfaceMessage } from "../../lib/pluginProtocol";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { activeManifest, currentPlugins } from "./store";
import { ensurePluginActivated, pluginReadyRun } from "./activation";
import { eventProfileId, manifestInProfile, windowProfileId } from "./profileScope";
import { focusedWindowId } from "../browser/current";
import { useBrowser } from "../browser/store";

const MAX_CALLS_PER_PLUGIN = 16;
const MAX_TOOL_JSON = 1 << 20;

type ToolCaller = { kind: "command" } | { kind: "socket" } | { kind: "plugin"; plugin: string } | { kind: "host" };

const SOCKET_CALLER_ON_WIRE = "cli";

const wireCaller = (caller: ToolCaller) => (caller.kind === "socket" ? { kind: SOCKET_CALLER_ON_WIRE } : caller);
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; code: "refused" | "failed" | "bad_request"; message: string };
export type PluginCall =
  | { kind: "tool"; tool: string; input: unknown }
  | { kind: "command"; command: string; context: Record<string, unknown> }
  | { kind: "omnibox"; provider: string; query: string }
  | { kind: "decide"; event: string; data: Record<string, unknown> }
  | { kind: "service"; iface: string; method: string; input: unknown };

type Pending = { id: string; plugin: string; run: number; caller: string | null; isTool: boolean; consent: ConsentToken | null; settle: (outcome: ToolOutcome) => void; timer: ReturnType<typeof setTimeout>; detach: () => void };

type AwaitingReady = { caller: string; cancel: (outcome: ToolOutcome) => void };

const pending = new Map<string, Pending>();
const awaitingReady = new Set<AwaitingReady>();
let seq = 0;

const failed = (code: Extract<ToolOutcome, { ok: false }>["code"], message: string): ToolOutcome => ({ ok: false, code, message });
const CANCELLED = failed("failed", "The call was cancelled before the plugin answered.");

function runningRun(plugin: string): number | null {
  const p = currentPlugins().processes[plugin];
  return p?.state === "running" ? p.run : null;
}

function finish(id: string, outcome: ToolOutcome) {
  const call = pending.get(id);
  if (!call) return false;
  pending.delete(id);
  clearTimeout(call.timer);
  call.detach();
  if (!outcome.ok && call.isTool) notePlugin("plugin_tool_failures", call.consent);
  call.settle(outcome);
  return true;
}

export function callProfile(plugin: string, call: PluginCall): string | null {
  if (call.kind === "command") return typeof call.context.windowId === "string" ? windowProfileId(call.context.windowId) : null;
  if (call.kind === "decide") return eventProfileId(call.data);
  if (call.kind === "omnibox") return windowProfileId(focusedWindowId() ?? undefined);
  return null;
}

function lineOf(id: string, call: PluginCall, given: ToolCaller, deadline: number, profileId: string | null): string {
  const caller = wireCaller(given);
  const profile = profileId ? { profile: profileId } : {};
  if (call.kind === "tool") return JSON.stringify({ call: id, tool: call.tool, input: call.input === undefined ? {} : call.input, caller, deadline, ...profile });
  if (call.kind === "command") return JSON.stringify({ call: id, kind: call.kind, name: call.command, context: call.context, caller, deadline, ...profile });
  if (call.kind === "omnibox") return JSON.stringify({ call: id, kind: call.kind, name: call.provider, input: call.query, caller, deadline, ...profile });
  if (call.kind === "service") return JSON.stringify({ call: id, kind: call.kind, name: call.iface, method: call.method, input: call.input ?? null, caller, deadline, ...profile });
  return JSON.stringify({ call: id, kind: call.kind, name: call.event, input: call.data, caller, deadline, ...profile });
}

const labelOf = (call: PluginCall) =>
  call.kind === "tool" ? call.tool : call.kind === "command" ? call.command : call.kind === "omnibox" ? `omnibox ${call.provider}` : call.kind === "service" ? `${call.iface}.${call.method}` : call.event;

function send(plugin: string, run: number, call: PluginCall, caller: ToolCaller, timeoutMs: number, consent: ConsentToken | null, signal: AbortSignal | undefined, profileId: string | null): Promise<ToolOutcome> {
  if (signal?.aborted) return Promise.resolve(CANCELLED);
  const id = `c${++seq}`;
  let line: string;
  try {
    line = lineOf(id, call, caller, timeoutMs, profileId);
  } catch {
    return Promise.resolve(failed("bad_request", "The call's input isn't JSON."));
  }
  if (line.length > MAX_TOOL_JSON) return Promise.resolve(failed("bad_request", "The call's input is over 1 MB."));
  if ([...pending.values()].filter((p) => p.plugin === plugin).length >= MAX_CALLS_PER_PLUGIN) return Promise.resolve(failed("failed", `${plugin} has too many calls waiting.`));
  if (call.kind === "tool") notePlugin("plugin_tool_calls", consent);
  return new Promise<ToolOutcome>((settle) => {
    const timer = setTimeout(() => {
      if (finish(id, failed("failed", `${plugin} didn't answer ${labelOf(call)} in ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`))) callPlugin(plugin, run, JSON.stringify({ call: id, cancel: true }));
    }, timeoutMs);
    const abandon = () => {
      if (finish(id, CANCELLED)) callPlugin(plugin, run, JSON.stringify({ call: id, cancel: true }));
    };
    signal?.addEventListener("abort", abandon, { once: true });
    const detach = () => signal?.removeEventListener("abort", abandon);
    pending.set(id, { id, plugin, run, caller: caller.kind === "plugin" ? caller.plugin : null, isTool: call.kind === "tool", consent, settle, timer, detach });
    try {
      callPlugin(plugin, run, line);
    } catch (error) {
      finish(id, failed("failed", `Couldn't reach ${plugin}: ${String(error)}`));
    }
  });
}

async function readyRunFor(plugin: string, trigger: string, activate: boolean): Promise<number | ToolOutcome> {
  const m = activeManifest(currentPlugins(), plugin);
  if (!m) return failed("refused", `There's no plugin ${plugin} that is on.`);
  const run = m.main ? pluginReadyRun(plugin) : runningRun(plugin);
  if (run !== null) return run;
  if (!m.main || !activate) return failed("failed", `${plugin}'s helper isn't running.`);
  try {
    return await ensurePluginActivated(plugin, trigger);
  } catch (error) {
    return failed("failed", (error as Error).message);
  }
}

function callerStillRuns(caller: string, runAtStart: number | null): boolean {
  const p = currentPlugins().processes[caller];
  if (p?.state === "running") return runAtStart === null || p.run === runAtStart;
  return p?.state === "starting" && runAtStart === null;
}

const callerStopped = (caller: string) => failed("failed", `${caller}, which asked, stopped.`);

function whileCallerRuns(caller: string | null, ready: Promise<number | ToolOutcome>): Promise<number | ToolOutcome> {
  if (caller === null) return ready;
  return new Promise((resolve) => {
    const waiting: AwaitingReady = { caller, cancel: resolve };
    awaitingReady.add(waiting);
    void ready.then((run) => {
      if (awaitingReady.delete(waiting)) resolve(run);
    });
  });
}

export type CallOptions = { activate?: boolean; consent?: ConsentToken | null; signal?: AbortSignal; profile?: string | null; allowed?: () => string | null };

export const callReaches = (plugin: string, call: PluginCall, profileId: string | null, strict = false) => {
  if ((call.kind === "tool" || call.kind === "service") && profileId === null) return !strict || activeManifest(currentPlugins(), plugin)?.scope !== "profile";
  return !!manifestInProfile(currentPlugins(), plugin, profileId);
};

export async function invokePluginCall(plugin: string, call: PluginCall, caller: ToolCaller, timeoutMs: number, options: CallOptions = {}): Promise<ToolOutcome> {
  const strict = caller.kind === "plugin";
  const asked = options.profile !== undefined ? options.profile : callProfile(plugin, call);
  const profileId = asked === null && strict && options.profile === undefined ? (windowProfileId(focusedWindowId() ?? undefined) ?? useBrowser.getState().settings.defaultProfileId ?? null) : asked;
  if (!callReaches(plugin, call, profileId, strict)) return failed("refused", `${plugin} isn't on in that profile.`);
  const refusedBefore = options.allowed?.();
  if (refusedBefore) return failed("refused", refusedBefore);
  const consent = options.consent !== undefined ? options.consent : consentToken();
  const trigger =
    call.kind === "tool" ? `onTool:${call.tool}` : call.kind === "command" ? `onCommand:${call.command}` : call.kind === "omnibox" ? `onOmnibox:${call.provider}` : call.kind === "service" ? `onService:${call.iface}` : `onEvent:${call.event}`;
  const callerName = caller.kind === "plugin" ? caller.plugin : null;
  const callerRun = callerName === null ? null : runningRun(callerName);
  const run = await whileCallerRuns(callerName, readyRunFor(plugin, trigger, options.activate !== false));
  if (typeof run !== "number") return run;
  if (callerName !== null && !callerStillRuns(callerName, callerRun)) return callerStopped(callerName);
  if (pluginReadyRun(plugin) !== run) return failed("failed", `${plugin} stopped before the call went out.`);
  const refusedAfter = options.allowed?.();
  if (refusedAfter) return failed("refused", refusedAfter);
  if (!callReaches(plugin, call, profileId, strict)) return failed("refused", `${plugin} isn't on in that profile.`);
  return send(plugin, run, call, caller, timeoutMs, consent, options.signal, activeManifest(currentPlugins(), plugin)?.scope === "profile" ? profileId : null);
}

export function callTool(plugin: string, tool: string, input: unknown, caller: ToolCaller, consentTaken?: ConsentToken | null, profile?: string | null, allowed?: () => string | null): Promise<ToolOutcome> {
  const consent = consentTaken !== undefined ? consentTaken : consentToken();
  const manifest = activeManifest(currentPlugins(), plugin);
  if (!manifest) return Promise.resolve(failed("refused", `There's no plugin ${plugin} that is on.`));
  const spec = manifest.tools.find((t) => t.name === tool);
  if (!spec) return Promise.resolve(failed("bad_request", `${plugin} has no tool ${tool}.`));
  if (!manifest.main && runningRun(plugin) === null) return Promise.resolve(failed("failed", `${plugin}'s helper isn't running.`));
  return invokePluginCall(plugin, { kind: "tool", tool, input }, caller, spec.timeout * 1000, { consent, ...(profile !== undefined ? { profile } : {}), ...(allowed ? { allowed } : {}) });
}

export function answerCall(plugin: string, run: number, params: Record<string, unknown>): string | null {
  const id = params.call;
  if (typeof id !== "string") return "result needs the call's id.";
  const call = pending.get(id);
  if (!call || call.plugin !== plugin || call.run !== run) return `There's no call ${id} waiting for this plugin.`;
  if (params.error !== undefined) {
    finish(id, failed("failed", typeof params.error === "string" ? params.error.slice(0, 500) : "The tool failed."));
    return null;
  }
  if (!Object.hasOwn(params, "result")) return "result needs a result or an error.";
  if (JSON.stringify(params.result ?? null).length > MAX_TOOL_JSON) {
    finish(id, failed("failed", "The tool's result is over 1 MB."));
    return null;
  }
  finish(id, { ok: true, result: params.result ?? null });
  return null;
}

export function dropCalls(plugin: string) {
  for (const waiting of [...awaitingReady]) {
    if (waiting.caller !== plugin) continue;
    awaitingReady.delete(waiting);
    waiting.cancel(callerStopped(plugin));
  }
  for (const call of [...pending.values()]) {
    if (call.plugin === plugin) finish(call.id, failed("failed", `${plugin} stopped.`));
    else if (call.caller === plugin && finish(call.id, callerStopped(plugin))) callPlugin(call.plugin, call.run, JSON.stringify({ call: call.id, cancel: true }));
  }
}

export function sendSurfaceMessage(plugin: string, message: SurfaceMessage): boolean {
  const run = pluginReadyRun(plugin);
  if (run === null) return false;
  try {
    sendToPlugin(plugin, run, JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export const waitingCalls = () => pending.size;

export const waitingCallsOf = (plugin: string) => [...pending.values()].filter((p) => p.plugin === plugin).length;
