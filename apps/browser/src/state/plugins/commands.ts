import type { CommandAction as BarAction } from "@ardia/core";
import type { CommandSpec, PageSide } from "../../lib/pluginManifest";
import { SPLIT_SIDES } from "../../lib/pluginManifest";
import { showToast } from "../app/toasts";
import { notePlugin } from "../telemetry/pluginCounts";
import { activeManifest, activeNames, currentPlugins, type PluginsStore } from "./store";
import { callTool } from "./tools";
import { openPluginPage } from "./pages";
import { valuesFor } from "./values";
import { useBrowser } from "../browser/store";
import { eligibleKind } from "../automation/automationWindows";

export const PLUGIN_ACTION_PREFIX = "plugin:";
const MESSAGE_LIMIT = 200;
const PAGE_ACTION = ":page";

export function pluginBarActions(s: Pick<PluginsStore, "listings" | "records" | "order">): BarAction[] {
  const out: BarAction[] = [];
  for (const name of activeNames(s)) {
    const m = activeManifest(s, name)!;
    if (m.page) out.push({ id: `${PLUGIN_ACTION_PREFIX}${name}/${PAGE_ACTION}`, title: `Open ${m.page.title}`, icon: m.page.icon, keywords: [m.title, "plugin"] });
    for (const c of m.commands) out.push({ id: `${PLUGIN_ACTION_PREFIX}${name}/${c.name}`, title: c.title, icon: c.icon, keywords: [...c.keywords, m.title] });
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

async function runCommandSpec(name: string, title: string, command: CommandSpec, windowId: string) {
  notePlugin("plugin_commands_run");
  const action = command.action;
  if ("open" in action) {
    openPluginPage(windowId, name, { split: action.open === "split", side: sideOf(name, action.side, action.sideSetting), context: action.context, path: action.path });
    return;
  }
  const outcome = await callTool(name, action.tool, action.input, { kind: "command" });
  if (!outcome.ok) return showToast(windowId, `${title}: ${command.title} didn't work`, outcome.message.slice(0, MESSAGE_LIMIT), { icon: "exclamationmark.triangle" });
  const message = messageOf(outcome.result);
  if (message) showToast(windowId, message, undefined, { icon: command.icon });
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
  const command = m.commands.find((c) => c.name === action);
  if (command) await runCommandSpec(name, m.title, command, windowId);
}

export function pluginActionsRevision(): string {
  const s = currentPlugins();
  return activeNames(s).map((name) => `${name}:${s.listings[name]!.hash}`).join(",");
}
