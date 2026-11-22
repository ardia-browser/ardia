import { at, KEY, LIMITS, list, NAME, type Check } from "./pluginChecks";
import { MENU_SLOTS, type PluginContributions } from "./pluginContributions";
import { isHostPattern } from "./pluginNetwork";

export const STARTUP_EVENTS = ["*", "onStartupFinished"] as const;
export const ACTIVATION_PREFIXES = ["onCommand", "onView", "onPanel", "onToolbar", "onOmnibox", "onMenu", "onEvent", "onUrl"] as const;
export type ActivationPrefix = (typeof ACTIVATION_PREFIXES)[number];

const EVENT_NAME = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;

function argumentOk(prefix: ActivationPrefix, arg: string): boolean {
  switch (prefix) {
    case "onCommand":
      return NAME.test(arg);
    case "onMenu":
      return (MENU_SLOTS as readonly string[]).includes(arg);
    case "onEvent":
      return arg === "*" || EVENT_NAME.test(arg);
    case "onUrl":
      return isHostPattern(arg) && arg !== "*";
    default:
      return KEY.test(arg);
  }
}

export function activationEventProblem(event: unknown): string | null {
  if (typeof event !== "string") return "must be text";
  if ((STARTUP_EVENTS as readonly string[]).includes(event)) return null;
  const colon = event.indexOf(":");
  const prefix = colon < 0 ? event : event.slice(0, colon);
  if (!(ACTIVATION_PREFIXES as readonly string[]).includes(prefix)) return `must be *, onStartupFinished or start with ${ACTIVATION_PREFIXES.map((p) => `${p}:`).join(", ")}`;
  if (colon < 0 || !argumentOk(prefix as ActivationPrefix, event.slice(colon + 1))) return `has a bad ${prefix} argument`;
  return null;
}

export function activationEventsOf(c: Check, value: unknown): string[] | null {
  if (value === undefined) return null;
  const out: string[] = [];
  list(c, "activationEvents", value, LIMITS.activationEvents).forEach((event, i) => {
    const problem = activationEventProblem(event);
    if (problem) c.problems.push(`${at("activationEvents", i)} ${problem}`);
    else if (!out.includes(event as string)) out.push(event as string);
  });
  return out;
}

export function derivedActivationEvents(k: PluginContributions, runtime: { main: boolean; sidecar: boolean }): string[] {
  const out = new Set<string>();
  if (k.hooks.length || (runtime.sidecar && !runtime.main)) out.add("onStartupFinished");
  for (const x of k.commands) out.add(`onCommand:${x.name}`);
  for (const v of k.sidebarViews) out.add(`onView:${v.id}`);
  for (const p of k.panels) if (p.view) out.add(`onPanel:${p.id}`);
  for (const t of k.toolbar) out.add(`onToolbar:${t.id}`);
  for (const o of k.omnibox) out.add(`onOmnibox:${o.id}`);
  for (const slot of MENU_SLOTS) if (k.menus[slot].length) out.add(`onMenu:${slot}`);
  return [...out];
}

export const startsEagerly = (events: readonly string[]): boolean => events.some((e) => e === "*" || e === "onStartupFinished" || e.startsWith("onEvent:"));

export const urlActivationHosts = (events: readonly string[]): string[] => events.flatMap((e) => (e.startsWith("onUrl:") ? [e.slice("onUrl:".length)] : []));
