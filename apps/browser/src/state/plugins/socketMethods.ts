import { consentNow } from "../telemetry/choice";
import { contributionsOf } from "../../lib/pluginManifest";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { openSettings } from "../settings/settingsWindows";
import { releaseOrphanedConsent } from "./consentSurface";
import { ALREADY_ASKING, removePlugin, requestPluginConsent, turnOffPlugin } from "./lifecycle";
import { activeManifest, currentPlugins, needsReview, recordOf } from "./store";
import { installOfficialPlugin, isOfficialName, officialPlugins } from "./official";
import { pluginRecordsSaved } from "./savedState";
import { callTool } from "./tools";
import { t } from "../../lib/uiLanguage";


const nameOf = (params: Record<string, unknown>) => (typeof params.name === "string" ? params.name : null);

export function pluginList() {
  const s = currentPlugins();
  return s.order.map((name) => {
    const listing = s.listings[name]!;
    const m = listing.manifest;
    return {
      name,
      title: m?.title ?? name,
      version: m?.version ?? null,
      enabled: recordOf(s, name).enabled,
      active: !!activeManifest(s, name),
      needsReview: needsReview(s, name),
      process: s.processes[name]?.state ?? null,
      contributes: m ? contributionsOf(m) : [],
      tools: m?.tools.map((t) => ({ name: t.name, title: t.title, description: t.description })) ?? [],
      problems: listing.problems,
    };
  });
}

function callPluginTool(params: Record<string, unknown>): Body | Promise<Body> {
  const { plugin, tool, input } = params;
  if (typeof plugin !== "string" || typeof tool !== "string") return failure("bad_request", t(`plugins.call needs a plugin and a tool.`));
  return callTool(plugin, tool, input, { kind: "socket" }).then((o) => (o.ok ? { result: o.result } : failure(o.code, o.message)));
}

export function pluginSocketMethod(method: string, params: Record<string, unknown>, serving: () => boolean = () => true): Body | Promise<Body> | null {
  if (method === "plugins") return { result: pluginList() };
  if (method === "plugins.official") return { result: officialPlugins(currentPlugins()) };
  if (!method.startsWith("plugins.")) return null;
  if (method === "plugins.call") return callPluginTool(params);
  const name = nameOf(params);
  const plugins = currentPlugins();
  const official = name !== null && isOfficialName(plugins, name);
  const known = name !== null && (Object.hasOwn(plugins.listings, name) || official);
  const recorded = name !== null && Object.hasOwn(plugins.records, name);
  const leftOn = recorded && plugins.records[name!]!.enabled;
  switch (method) {
    case "plugins.enable":
      if (!known) return failure("bad_request", `There's no plugin ${String(name)}.`);
      if (activeManifest(currentPlugins(), name)) return { result: { ok: true } };
      releaseOrphanedConsent();
      if (currentPlugins().consent) return failure("refused", ALREADY_ASKING);
      if (official) {
        void installOfficialPlugin(name!);
        return { result: { waiting: true } };
      }
      if (!requestPluginConsent(name)) return failure("refused", `${name} has problems, so it can't be turned on.`);
      openSettings("plugins", null, name);
      return { result: { waiting: true } };
    case "plugins.disable": {
      if (!known && !leftOn) return failure("bad_request", `There's no plugin ${String(name)}.`);
      const consent = consentNow();
      return turnOffPlugin(name!, consent).then((off) =>
        !off ? failure("failed", t(`Couldn't save plugins.json.`)) : pluginRecordsSaved(consent).then((saved) => (saved ? { result: { ok: true } } : failure("failed", t(`It's off for now, but plugins.json couldn't be saved, so it may be on again after Ardia restarts.`)))),
      );
    }
    case "plugins.remove":
      if (!known && !recorded) return failure("bad_request", `There's no plugin ${String(name)}.`);
      return removePlugin(name, serving).then((r) => (r.ok ? { result: { ok: true } } : failure("failed", r.reason ?? t(`Couldn't remove it.`))));
  }
  return failure("unknown_method", `There's no method ${method}.`);
}
