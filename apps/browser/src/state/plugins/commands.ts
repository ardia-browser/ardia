import type { CommandAction as BarAction } from "@ardia/core";
import type { CommandSpec, PageSide, PluginPermissions } from "../../lib/pluginManifest";
import { minimizedUrl, urlParts } from "../../lib/urlParts";
import { whenHolds, type WhenContext } from "../../lib/pluginWhen";
import { SPLIT_SIDES } from "../../lib/pluginManifest";
import { showToast } from "../app/toasts";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { activeManifest, activeNames, currentPlugins, type PluginsStore } from "./store";
import { callTool, invokePluginCall, type ToolOutcome } from "./tools";
import { openPluginPage } from "./pages";
import { valuesFor } from "./values";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, viewTabIds } from "../browser/model";
import { groupOf } from "../pins/tabGrouping";
import { splitOf } from "../splits/splits";
import { eligibleKind } from "../automation/automationWindows";
import { notePluginGesture } from "./gestures";
import { openPluginPanel } from "./panels";
import { openPluginCommandView } from "./surfaces";

export const PLUGIN_ACTION_PREFIX = "plugin:";
export const COMMAND_TIMEOUT_MS = 30_000;
const MESSAGE_LIMIT = 200;
const PAGE_ACTION = ":page";

export function windowWhenContext(windowId: string, s: BrowserState = useBrowser.getState()): WhenContext {
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  const parts = tab ? urlParts(tab.url) : null;
  return {
    urlHost: parts?.host ?? "",
    urlScheme: parts?.scheme ?? "",
    isPinned: !!tab?.pin,
    isInGroup: !!(tab && groupOf(s, tab.id)),
    isSplit: !!(tab && splitOf(s, tab.id)),
    isActive: !!tab,
    tabCount: viewTabIds(s, windowId).length,
  };
}

export function pluginBarActions(s: Pick<PluginsStore, "listings" | "records" | "order">, windowId?: string): BarAction[] {
  const out: BarAction[] = [];
  const when = windowId === undefined ? null : windowWhenContext(windowId);
  for (const name of activeNames(s)) {
    const m = activeManifest(s, name)!;
    if (m.page) out.push({ id: `${PLUGIN_ACTION_PREFIX}${name}/${PAGE_ACTION}`, title: `Open ${m.page.title}`, icon: m.page.icon, keywords: [m.title, "plugin"] });
    for (const c of m.commands) if (!when || whenHolds(c.when, when)) out.push({ id: `${PLUGIN_ACTION_PREFIX}${name}/${c.name}`, title: c.title, icon: c.icon, keywords: [...c.keywords, m.title] });
  }
  return out;
}

export const isPluginAction = (id: string) => id.startsWith(PLUGIN_ACTION_PREFIX);

function messageOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const message = (result as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message.slice(0, MESSAGE_LIMIT) : null;
}

function sideOf(name: string, side: PageSide, setting: string | null): PageSide {
  const chosen = setting ? valuesFor(name)[setting] : undefined;
  return typeof chosen === "string" && (SPLIT_SIDES as readonly string[]).includes(chosen) ? (chosen as PageSide) : side;
}

function reportOutcome(windowId: string, title: string, command: CommandSpec, outcome: ToolOutcome) {
  if (!outcome.ok) return showToast(windowId, `${title}: ${command.title} didn't work`, outcome.message.slice(0, MESSAGE_LIMIT), { icon: "exclamationmark.triangle" });
  const message = messageOf(outcome.result);
  if (message) showToast(windowId, message, undefined, { icon: command.icon });
}

export type CommandContext = Record<string, unknown>;

const URL_KEY = /^(url|[a-z]+Url)$/;
const PAGE_TEXT_KEY = /^(selection|text|linkText)$/;
const TAB_TEXT_KEY = /^(title|[a-z]+Title)$/;

export function shownCommandContext(p: PluginPermissions, context: CommandContext): CommandContext {
  const out: CommandContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (URL_KEY.test(key)) {
      if (typeof value === "string" && p.tabs) out[key] = p.fullUrls ? value : minimizedUrl(value);
    } else if (TAB_TEXT_KEY.test(key)) {
      if (typeof value === "string" && p.tabs) out[key] = value;
    } else if (PAGE_TEXT_KEY.test(key)) {
      if (typeof value === "string" && p.activePage) out[key] = value.slice(0, 20_000);
    } else if (value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
  }
  return out;
}

async function runCommandSpec(name: string, title: string, permissions: PluginPermissions, command: CommandSpec, windowId: string, context: CommandContext, consent: ConsentToken | null) {
  notePlugin("plugin_commands_run", consent);
  notePluginGesture(name, windowId, typeof context.tabId === "string" ? context.tabId : undefined);
  const action = command.action;
  if ("open" in action) {
    openPluginPage(windowId, name, { split: action.open === "split", side: sideOf(name, action.side, action.sideSetting), context: action.context, path: action.path, consent });
    return;
  }
  if ("view" in action) return void openPluginCommandView(windowId, { plugin: name, command: command.name, viewId: action.view, title: command.title, icon: command.icon });
  if ("panel" in action) {
    const opened = openPluginPanel(windowId, name, action.panel, consent);
    if (!opened.ok) showToast(windowId, `${title}: ${command.title} didn't work`, opened.reason.slice(0, MESSAGE_LIMIT), { icon: "exclamationmark.triangle" });
    return;
  }
  if ("tool" in action) return reportOutcome(windowId, title, command, await callTool(name, action.tool, action.input, { kind: "command" }, consent));
  reportOutcome(windowId, title, command, await invokePluginCall(name, { kind: "command", command: command.name, context: { ...shownCommandContext(permissions, context), windowId } }, { kind: "command" }, COMMAND_TIMEOUT_MS, { consent }));
}

export async function runPluginCommand(name: string, commandName: string, windowId: string, context: CommandContext = {}, when?: WhenContext, consent?: ConsentToken | null): Promise<boolean> {
  const token = consent !== undefined ? consent : consentToken();
  if (!eligibleKind(useBrowser.getState(), windowId)) return false;
  const m = activeManifest(currentPlugins(), name);
  const command = m?.commands.find((c) => c.name === commandName);
  if (!m || !command || !whenHolds(command.when, when ?? windowWhenContext(windowId))) return false;
  await runCommandSpec(name, m.title, m.permissions, command, windowId, context, token);
  return true;
}

export async function runPluginAction(id: string, windowId: string): Promise<void> {
  if (!eligibleKind(useBrowser.getState(), windowId)) return;
  const rest = id.slice(PLUGIN_ACTION_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return;
  const name = rest.slice(0, slash);
  const action = rest.slice(slash + 1);
  const m = activeManifest(currentPlugins(), name);
  if (!m) return;
  if (action === PAGE_ACTION) return void openPluginPage(windowId, name);
  await runPluginCommand(name, action, windowId);
}

export function pluginActionsRevision(): string {
  const s = currentPlugins();
  return activeNames(s).map((name) => `${name}:${s.listings[name]!.hash}`).join(",");
}
