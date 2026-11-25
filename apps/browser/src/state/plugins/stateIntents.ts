import { TAB_GROUP_COLORS } from "@ardia/core";
import { isFields } from "../../lib/decode";
import { isWellFormed } from "../../lib/pluginNames";
import { grantsIntent, isStateIntent, STATE_INTENTS, type StateIntent } from "../../lib/pluginState";
import type { PluginManifest } from "../../lib/pluginManifest";
import { useBrowser } from "../browser/store";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { eligibleKind, isEligibleTab } from "../automation/automationWindows";
import { isEligibleGroup } from "../automation/workspaceTree";
import { applyMethod } from "../automation/workspaceMethods";
import { iconValue, type Op } from "../automation/workspaceOps";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken } from "../telemetry/choice";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { intentProblem, type GuardProblem } from "./stateIntentGuards";

export const MAX_INTENT_TABS = 100;
const MAX_NAME = 200;
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
const COLORS: readonly string[] = ["neutral", "none", ...TAB_GROUP_COLORS];

type Kind = "tabs" | "tab" | "group" | "groupOrNull" | "window" | "bool" | "name" | "color" | "icon" | "pinAs";
type Spec = { op: string; required: readonly string[]; fields: Readonly<Record<string, Kind>> };

const TABS_ONLY = { tabs: "tabs" } as const;
const GROUP_LOOK = { name: "name", color: "color", icon: "icon", collapsed: "bool" } as const;

export const INTENT_SPECS: Readonly<Record<StateIntent, Spec>> = {
  "tabs.group": { op: "group.create", required: ["tabs"], fields: { ...TABS_ONLY, ...GROUP_LOOK } },
  "tabs.ungroup": { op: "group.ungroup", required: ["group"], fields: { group: "group" } },
  "tabs.move": { op: "tab.move", required: ["tabs"], fields: { ...TABS_ONLY, before: "tab", after: "tab", group: "groupOrNull", window: "window" } },
  "tabs.pin": { op: "tab.pin", required: ["tabs"], fields: { ...TABS_ONLY, as: "pinAs" } },
  "tabs.unpin": { op: "tab.unpin", required: ["tabs"], fields: TABS_ONLY },
  "tabs.mute": { op: "tab.mute", required: ["tabs"], fields: TABS_ONLY },
  "tabs.unmute": { op: "tab.unmute", required: ["tabs"], fields: TABS_ONLY },
  "tabs.activate": { op: "tab.activate", required: ["tab"], fields: { tab: "tab" } },
  "groups.update": { op: "group.update", required: ["group"], fields: { group: "group", ...GROUP_LOOK } },
};

type Checked = { value: unknown } | { code: "bad_request" | "refused"; message: string };

const bad = (message: string): Checked => ({ code: "bad_request", message });
const gone = (message: string): Checked => ({ code: "refused", message });

function tabId(value: unknown, path: string): Checked {
  if (typeof value !== "string" || !ID.test(value)) return bad(`${path} must be a tab id.`);
  return isEligibleTab(useBrowser.getState(), value) ? { value } : gone(`There's no tab ${value} this plugin may use.`);
}

function groupId(value: unknown, path: string): Checked {
  if (typeof value !== "string" || !ID.test(value)) return bad(`${path} must be a group id.`);
  return isEligibleGroup(useBrowser.getState(), value) ? { value } : gone(`There's no group ${value} this plugin may use.`);
}

function checkField(kind: Kind, value: unknown, path: string): Checked {
  switch (kind) {
    case "tabs": {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INTENT_TABS) return bad(`${path} must be a list of 1 to ${MAX_INTENT_TABS} tab ids.`);
      if (new Set(value).size !== value.length) return bad(`${path} names a tab twice.`);
      for (const [i, id] of value.entries()) {
        const one = tabId(id, `${path}[${i}]`);
        if (!("value" in one)) return one;
      }
      return { value: [...value] };
    }
    case "tab":
      return tabId(value, path);
    case "group":
      return groupId(value, path);
    case "groupOrNull":
      return value === null ? { value: null } : groupId(value, path);
    case "window":
      if (typeof value !== "string" || !ID.test(value)) return bad(`${path} must be a window id.`);
      return eligibleKind(useBrowser.getState(), value) === "normal" ? { value } : gone(`There's no window ${value} this plugin may use.`);
    case "bool":
      return typeof value === "boolean" ? { value } : bad(`${path} must be true or false.`);
    case "name":
      if (typeof value !== "string" || value.length > MAX_NAME || UNSAFE_TEXT.test(value) || !isWellFormed(value)) return bad(`${path} must be text of at most ${MAX_NAME} characters with no control or direction characters.`);
      return { value: value.trim() };
    case "color":
      return typeof value === "string" && COLORS.includes(value) ? { value } : bad(`${path} must be one of ${COLORS.join(", ")}.`);
    case "icon":
      return iconValue(value) === undefined ? bad(`${path} must be an emoji from Ardia's picker, symbol:<SF Symbol name>, "none", or null.`) : { value };
    case "pinAs":
      return value === "tile" || value === "row" ? { value } : bad(`${path} must be "tile" or "row".`);
  }
}

export type IntentOp = { op: string; [field: string]: unknown };

export function parseIntent(intent: unknown, args: unknown): { op: IntentOp; intent: StateIntent } | { code: "bad_request" | "refused"; message: string } {
  if (!isStateIntent(intent)) return { code: "bad_request", message: `intent is one of ${STATE_INTENTS.join(", ")}.` };
  const spec = INTENT_SPECS[intent];
  const given = args === undefined ? {} : args;
  if (!isFields(given)) return { code: "bad_request", message: `${intent}'s args are an object.` };
  const op: IntentOp = { op: spec.op };
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(spec.fields, key)) return { code: "bad_request", message: `${intent} takes ${Object.keys(spec.fields).join(", ")}, not ${key.slice(0, 40)}.` };
    const checked = checkField(spec.fields[key]!, given[key], key);
    if (!("value" in checked)) return checked;
    op[key] = checked.value;
  }
  const missing = spec.required.filter((key) => op[key] === undefined);
  if (missing.length) return { code: "bad_request", message: `${intent} needs ${missing.join(" and ")}.` };
  if (op.before !== undefined && op.after !== undefined) return { code: "bad_request", message: `${intent} takes before or after, not both.` };
  if (intent === "tabs.move" && op.before === undefined && op.after === undefined && op.group === undefined && op.window === undefined) return { code: "bad_request", message: "tabs.move needs a destination: before, after, group or window." };
  if (intent === "groups.update" && Object.keys(op).length < 3) return { code: "bad_request", message: "groups.update needs name, color, icon or collapsed." };
  if ((intent === "tabs.move" || intent === "tabs.group") && Array.isArray(op.tabs)) {
    const anchor = (op.before ?? op.after) as string | undefined;
    if (anchor && (op.tabs as string[]).includes(anchor)) return { code: "bad_request", message: `${intent} can't place tabs next to one of themselves.` };
  }
  return { op, intent };
}

const stillGranted = (c: Caller, intent: StateIntent) => () => {
  const m = activeManifest(currentPlugins(), c.name);
  return acceptsRun(c.name, c.run) && !!m && grantsIntent(m.permissions.state, intent);
};

type Caller = { name: string; run: number };

type Applied = { ok?: boolean; results?: { group?: string; tabs?: string[] }[]; error?: { code: string; message: string } };

export async function runIntent(c: Caller, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const consent = consentToken();
  const unknown = Object.keys(params).filter((key) => key !== "intent" && key !== "args");
  if (unknown.length) {
    notePlugin("plugin_state_intent_refusals", consent);
    return failure("bad_request", `state.intent takes intent and args, not ${unknown.slice(0, 4).map((k) => k.slice(0, 40)).join(", ")}.`);
  }
  if (isStateIntent(params.intent) && !grantsIntent(m.permissions.state, params.intent)) {
    notePlugin("plugin_state_intent_refusals", consent);
    return failure("refused", `This plugin's permissions.state.intents don't list ${params.intent}.`);
  }
  const parsed = parseIntent(params.intent, params.args);
  if (!("op" in parsed)) {
    notePlugin("plugin_state_intent_refusals", consent);
    return failure(parsed.code, parsed.message);
  }
  const granted = stillGranted(c, parsed.intent);
  const op = parsed.intent === "tabs.group" ? { ...parsed.op, pinned: false } : parsed.op;
  const early = intentProblem(useBrowser.getState(), parsed.intent, op as Op);
  if (early) {
    notePlugin("plugin_state_intent_refusals", consent);
    return failure(early.code, early.message);
  }
  if (parsed.intent === "tabs.mute" || parsed.intent === "tabs.unmute") return muteTabs(op.tabs as string[], parsed.intent === "tabs.mute", consent);
  let late: GuardProblem | null = null;
  const allowed = () => {
    if (!granted()) return false;
    late = intentProblem(useBrowser.getState(), parsed.intent, op as Op);
    return late === null;
  };
  const body = await applyMethod({ ops: [op] }, allowed, 0, () => ({ error: "An intent opens no addresses." }));
  const applied = "result" in body ? (body.result as Applied) : null;
  if (!applied?.ok) {
    notePlugin("plugin_state_intent_refusals", consent);
    const changedUnder = late as GuardProblem | null;
    if (changedUnder) return failure(changedUnder.code, changedUnder.message);
    if (!granted()) return failure("refused", "This run of the plugin has ended or lost that intent, so nothing changed.");
    const error = "error" in body ? body.error : applied?.error;
    return failure(error?.code === "no_window" ? "refused" : "failed", error?.message?.replace(/the ardia command/g, "this plugin") ?? "The change couldn't be made.");
  }
  notePlugin("plugin_state_intents", consent);
  const group = applied.results?.[0]?.group;
  return { result: { ok: true, ...(typeof group === "string" && isEligibleGroup(useBrowser.getState(), group) ? { group } : {}) } };
}

function muteTabs(ids: string[], muted: boolean, consent: ReturnType<typeof consentToken>): Body {
  const s = useBrowser.getState();
  if (ids.some((id) => !isEligibleTab(s, id))) {
    notePlugin("plugin_state_intent_refusals", consent);
    return failure("refused", "A tab named isn't one this plugin may use.");
  }
  s.setMuted(ids, muted);
  if (ids.some((id) => useBrowser.getState().tabs[id]?.muted !== muted)) {
    notePlugin("plugin_state_intent_refusals", consent);
    return failure("failed", `Ardia didn't ${muted ? "mute" : "unmute"} every tab named.`);
  }
  notePlugin("plugin_state_intents", consent);
  return { result: { ok: true } };
}
