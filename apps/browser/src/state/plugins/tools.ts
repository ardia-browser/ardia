import { callPlugin } from "../../platform/plugins";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { activeManifest, currentPlugins } from "./store";

export const MAX_CALLS_PER_PLUGIN = 16;
export const MAX_TOOL_JSON = 1 << 20;

export type ToolCaller = { kind: "command" } | { kind: "cli" } | { kind: "plugin"; plugin: string };
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; code: "refused" | "failed" | "bad_request"; message: string };

type Pending = { id: string; plugin: string; run: number; caller: string | null; consent: ConsentToken | null; settle: (outcome: ToolOutcome) => void; timer: ReturnType<typeof setTimeout> };

const pending = new Map<string, Pending>();
let seq = 0;

const failed = (code: Extract<ToolOutcome, { ok: false }>["code"], message: string): ToolOutcome => ({ ok: false, code, message });

export function runningRun(plugin: string): number | null {
  const p = currentPlugins().processes[plugin];
  return p?.state === "running" ? p.run : null;
}

function finish(id: string, outcome: ToolOutcome) {
  const call = pending.get(id);
  if (!call) return false;
  pending.delete(id);
  clearTimeout(call.timer);
  if (!outcome.ok) notePlugin("plugin_tool_failures", call.consent);
  call.settle(outcome);
  return true;
}

export function callTool(plugin: string, tool: string, input: unknown, caller: ToolCaller): Promise<ToolOutcome> {
  const manifest = activeManifest(currentPlugins(), plugin);
  if (!manifest) return Promise.resolve(failed("refused", `There's no plugin ${plugin} that is on.`));
  const spec = manifest.tools.find((t) => t.name === tool);
  if (!spec) return Promise.resolve(failed("bad_request", `${plugin} has no tool ${tool}.`));
  const run = runningRun(plugin);
  if (run === null) return Promise.resolve(failed("failed", `${plugin}'s helper isn't running.`));
  const given = input === undefined ? {} : input;
  let line: string;
  const id = `c${++seq}`;
  try {
    line = JSON.stringify({ call: id, tool, input: given, caller, deadline: spec.timeout * 1000 });
  } catch {
    return Promise.resolve(failed("bad_request", "The tool's input isn't JSON."));
  }
  if (line.length > MAX_TOOL_JSON) return Promise.resolve(failed("bad_request", "The tool's input is over 1 MB."));
  if ([...pending.values()].filter((p) => p.plugin === plugin).length >= MAX_CALLS_PER_PLUGIN) return Promise.resolve(failed("failed", `${plugin} has too many calls waiting.`));
  const consent = consentToken();
  notePlugin("plugin_tool_calls", consent);
  return new Promise<ToolOutcome>((settle) => {
    const timer = setTimeout(() => {
      if (finish(id, failed("failed", `${plugin} didn't answer ${tool} in ${spec.timeout} s.`))) callPlugin(plugin, run, JSON.stringify({ call: id, cancel: true }));
    }, spec.timeout * 1000);
    pending.set(id, { id, plugin, run, caller: caller.kind === "plugin" ? caller.plugin : null, consent, settle, timer });
    try {
      callPlugin(plugin, run, line);
    } catch (error) {
      finish(id, failed("failed", `Couldn't reach ${plugin}: ${String(error)}`));
    }
  });
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
  for (const call of [...pending.values()]) {
    if (call.plugin === plugin) finish(call.id, failed("failed", `${plugin} stopped.`));
    else if (call.caller === plugin && finish(call.id, failed("failed", `${plugin}, which asked, stopped.`))) callPlugin(call.plugin, call.run, JSON.stringify({ call: call.id, cancel: true }));
  }
}

export const waitingCalls = () => pending.size;
