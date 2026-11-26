import { systemInfo } from "../../platform/app";
import { isFields } from "../../lib/decode";
import { minimizedUrl } from "../../lib/urlParts";
import { canOpenTabs, missingPermissions, SPLIT_SIDES, type PageSide, type PluginManifest } from "../../lib/pluginManifest";
import { pluginWebUrl } from "../../lib/pluginWebUrl";
import { useBrowser } from "../browser/store";
import { failure } from "../automation/automationMethods";
import { automationWindows, lastFocusedEligibleWindow } from "../automation/automationWindows";
import { runMethod, type Body } from "../automation/controlSocket";
import { applyMethod, workspaceMethod } from "../automation/workspaceMethods";
import type { UrlRule } from "../automation/workspaceOps";
import { notePlugin } from "../telemetry/pluginCounts";
import { activeManifest, currentPlugins } from "./store";
import { answerCall, callTool } from "./tools";
import { acceptsRun } from "./process";
import { markPluginReady } from "./activation";
import { isPagePath, openPluginPage } from "./pages";
import { valuesFor } from "./values";
import { netFetch, readActivePage, secretsMethod, storageMethod } from "./channelData";
import { UI_METHODS, uiMethod } from "./channelUi";
import { programsStatus, relinkOwnPrograms } from "./programs";
import { subscribeState } from "./stateEvents";
import { runIntent } from "./stateIntents";

const CHANNEL_PROTOCOL = 2;
const LEGACY_CHANNEL_PROTOCOL = 1;
const MAX_OPEN_URLS = 10;
const TAB_APPLY_OPS = ["open", "tab.close", "tab.activate"] as const;

type ChannelCaller = { name: string; run: number };

function minimizedWindows(full: boolean) {
  const windows = automationWindows(useBrowser.getState());
  return full ? windows : windows.map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t, url: minimizedUrl(t.url) })) }));
}

function openPage(name: string, m: PluginManifest, params: Record<string, unknown>): Body {
  if (!m.page) return failure("refused", "This plugin has no page.");
  const { path, split, side, context } = params;
  if (path !== undefined && (typeof path !== "string" || !isPagePath(path))) return failure("bad_request", "page.open's path is /like/this?q=1, at most 512 characters.");
  if (side !== undefined && !(SPLIT_SIDES as readonly unknown[]).includes(side)) return failure("bad_request", "side is left, right, top or bottom.");
  if (context === true && !m.permissions.tabs) return failure("refused", "Handing the page a tab needs the tabs permission.");
  const windowId = lastFocusedEligibleWindow(useBrowser.getState());
  if (!windowId) return failure("no_window", "No window to open the page in.");
  const tabId = openPluginPage(windowId, name, { path: (path as string | undefined) ?? "", split: split === true, side: side as PageSide | undefined, context: context === true });
  return tabId ? { result: { tabId, windowId } } : failure("failed", "The page couldn't open.");
}

async function toolsCall(name: string, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const { plugin, tool, input } = params;
  if (typeof plugin !== "string" || typeof tool !== "string") return failure("bad_request", "tools.call needs a plugin and a tool.");
  const callee = activeManifest(currentPlugins(), plugin);
  const missing = callee ? missingPermissions(m.permissions, callee.permissions) : [];
  if (missing.length) return failure("refused", `${plugin} has permissions this plugin doesn't (${missing.join(", ")}), so it can't call its tools.`);
  const outcome = await callTool(plugin, tool, input, { kind: "plugin", plugin: name });
  return outcome.ok ? { result: outcome.result } : failure(outcome.code, outcome.message);
}

const URL_REFUSALS = { open: "plugin_url_refusals_open", "group.create": "plugin_url_refusals_group_create" } as const;

export const pluginUrlRule: UrlRule = (value, op) => {
  const checked = pluginWebUrl(value);
  if ("url" in checked) return checked.url;
  if (op === "open" || op === "group.create") notePlugin(URL_REFUSALS[op]);
  return { error: `${JSON.stringify(value.slice(0, 200))} ${checked.problem}: a plugin opens only http and https addresses.` };
};

const stillAllowed = (c: ChannelCaller, allowed: (m: PluginManifest) => boolean) => () => {
  const m = activeManifest(currentPlugins(), c.name);
  return acceptsRun(c.name, c.run) && !!m && allowed(m);
};

async function openTabs(c: ChannelCaller, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  if (!canOpenTabs(m.permissions)) return failure("refused", "open needs the commands permission or tabs: write.");
  const { urls, activate } = params;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_OPEN_URLS) return failure("bad_request", `open takes urls: a list of 1 to ${MAX_OPEN_URLS} http or https addresses.`);
  const checked = urls.map(pluginWebUrl);
  const bad = checked.findIndex((u) => "problem" in u);
  if (bad >= 0) return failure("bad_request", `urls[${bad}] ${(checked[bad] as { problem: string }).problem}.`);
  const current = stillAllowed(c, (now) => canOpenTabs(now.permissions));
  const body = await applyMethod({ ops: [{ op: "open", urls, ...(activate === true ? { activate: true } : {}) }] }, current, 0, pluginUrlRule);
  const applied = "result" in body ? (body.result as { ok?: boolean; results?: { tabs?: string[] }[] }) : null;
  if (!applied?.ok) return failure(current() ? "failed" : "refused", current() ? "The tabs couldn't open." : "This run of the helper has ended or lost commands, so nothing opened.");
  return { result: { ok: true, tabs: applied.results?.[0]?.tabs ?? [] } };
}

const tabOnlyOps = (params: Record<string, unknown>) =>
  Array.isArray(params.ops) && params.ops.every((op) => isFields(op) && (TAB_APPLY_OPS as readonly unknown[]).includes(op.op) && op.group === undefined && op.profile === undefined);

const mayApply = (m: PluginManifest, tabOnly: boolean) => m.permissions.workspace || (tabOnly && m.permissions.tabs === "write");

function minimizedApply(body: Body, full: boolean): Body {
  if (full || !("result" in body) || !isFields(body.result) || !Array.isArray(body.result.tabs)) return body;
  return { result: { ...body.result, tabs: body.result.tabs.map((t: unknown) => (isFields(t) && typeof t.url === "string" ? { ...t, url: minimizedUrl(t.url) } : t)) } };
}

function workspace(c: ChannelCaller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  if (method === "workspace") return m.permissions.workspace ? workspaceMethod(params) : failure("refused", "workspace needs the workspace permission.");
  const tabOnly = tabOnlyOps(params);
  if (!mayApply(m, tabOnly)) return failure("refused", "apply needs the workspace permission, or tabs: write for open, tab.close and tab.activate.");
  const body = applyMethod(params, stillAllowed(c, (now) => mayApply(now, tabOnly)), 0, pluginUrlRule);
  const full = m.permissions.fullUrls;
  return body instanceof Promise ? body.then((b) => minimizedApply(b, full)) : minimizedApply(body, full);
}

export function answerMethod(c: ChannelCaller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> | null {
  switch (method) {
    case "hello":
      return { result: { app: "Ardia", version: systemInfo().appVersion, protocol: m.main ? CHANNEL_PROTOCOL : LEGACY_CHANNEL_PROTOCOL, plugin: c.name, values: valuesFor(c.name) } };
    case "values":
      return { result: valuesFor(c.name) };
    case "ready":
      return markPluginReady(c.name, c.run) ? { result: { ok: true } } : failure("refused", "This run of the plugin has ended.");
    case "windows":
      return m.permissions.tabs ? { result: minimizedWindows(m.permissions.fullUrls) } : failure("refused", "windows needs the tabs permission.");
    case "run":
      return m.permissions.commands ? runMethod(params) : failure("refused", "run needs the commands permission.");
    case "open":
      return openTabs(c, m, params);
    case "workspace":
    case "apply":
      return workspace(c, m, method, params);
    case "state.subscribe":
      return subscribeState(c, m, params);
    case "state.intent":
      return runIntent(c, m, params);
    case "tabs.readActivePage":
      return readActivePage(c, m);
    case "page.open":
      return openPage(c.name, m, params);
    case "tools.call":
      return toolsCall(c.name, m, params);
    case "net.fetch":
      return netFetch(m, params);
    case "programs.status":
      return { result: programsStatus(c.name) };
    case "programs.relink": {
      const relinked = relinkOwnPrograms(c.name);
      return relinked.ok ? { result: { ok: true } } : failure("refused", relinked.reason);
    }
    case "result": {
      const problem = answerCall(c.name, c.run, params);
      return problem ? failure("bad_request", problem) : { result: { ok: true } };
    }
  }
  if (method.startsWith("storage.") && ["storage.get", "storage.set", "storage.delete", "storage.keys"].includes(method)) return storageMethod(c, m, method, params);
  if (["secrets.get", "secrets.set", "secrets.delete"].includes(method)) return secretsMethod(c, m, method, params);
  if ((UI_METHODS as readonly string[]).includes(method)) return uiMethod(c, m, method, params);
  return null;
}
