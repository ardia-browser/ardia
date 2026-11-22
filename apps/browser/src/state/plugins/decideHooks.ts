import { DECIDE_DEADLINE_MS, isDecideEvent, type DecideEvent } from "../automation/eventNames";
import { redactedEventData } from "../automation/eventRedaction";
import type { ConsentToken } from "../telemetry/choice";
import { notePlugin } from "../telemetry/pluginCounts";
import { onPluginReady, pluginReadyRun } from "./activation";
import { onProcessStopped } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { invokePluginCall } from "./tools";
import { t } from "../../lib/uiLanguage";


export const PLUGIN_DECIDE_TIMEOUT_MS = 250;

export type PluginVerdict = { plugin: string; verdict: unknown };

export const decideTimeoutFor = (event: DecideEvent) => Math.min(PLUGIN_DECIDE_TIMEOUT_MS, DECIDE_DEADLINE_MS[event]);

export function pluginsDeciding(event: string): string[] {
  const s = currentPlugins();
  return s.order.filter((name) => {
    const m = activeManifest(s, name);
    return !!m && m.hooks.includes(event) && !!m.permissions.tabs && pluginReadyRun(name) !== null;
  });
}

export function onPluginDecidersChanged(listener: () => void): () => void {
  const later = () => queueMicrotask(listener);
  const offReady = onPluginReady(later);
  const offStopped = onProcessStopped(later);
  return () => {
    offReady();
    offStopped();
  };
}

export async function runPluginDecideHook(event: string, data: Record<string, unknown>, consent: ConsentToken | null, signal?: AbortSignal): Promise<PluginVerdict | null> {
  if (!isDecideEvent(event)) return null;
  const deciders = pluginsDeciding(event);
  if (!deciders.length) return null;
  const timeout = decideTimeoutFor(event);
  const asked = deciders.map(async (plugin) => {
    const m = activeManifest(currentPlugins(), plugin);
    if (!m) return null;
    notePlugin("plugin_decide_calls", consent);
    const shown = m.permissions.fullUrls ? data : redactedEventData(data);
    const outcome = await invokePluginCall(plugin, { kind: "decide", event, data: shown }, { kind: "host" }, timeout, { activate: false, consent });
    if (!outcome.ok) {
      if (outcome.message.includes(t(`didn't answer`))) notePlugin("plugin_decide_timeouts", consent);
      return null;
    }
    return outcome.result === null || outcome.result === undefined ? null : ({ plugin, verdict: outcome.result } as PluginVerdict);
  });
  const verdicts = await Promise.all(asked);
  if (signal?.aborted) return null;
  return verdicts.find((v) => v !== null) ?? null;
}
