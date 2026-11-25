import { isFields } from "./decode";
import { only, type Check } from "./pluginChecks";

export const STATE_TOPICS = ["tabs", "workspace", "navigation", "downloads"] as const;
export type StateTopic = (typeof STATE_TOPICS)[number];

export const STATE_INTENTS = ["tabs.group", "tabs.ungroup", "tabs.move", "tabs.pin", "tabs.unpin", "tabs.mute", "tabs.unmute", "tabs.activate", "groups.update"] as const;
export type StateIntent = (typeof STATE_INTENTS)[number];

export const TOPICS_NEEDING_TABS: readonly StateTopic[] = ["tabs", "workspace", "navigation"];

export type StateAccess = { events: StateTopic[]; intents: StateIntent[] };

export const STATE_KEYS = ["events", "intents"] as const;

export const isStateTopic = (value: unknown): value is StateTopic => typeof value === "string" && (STATE_TOPICS as readonly string[]).includes(value);
export const isStateIntent = (value: unknown): value is StateIntent => typeof value === "string" && (STATE_INTENTS as readonly string[]).includes(value);

function namesOf<T extends string>(c: Check, path: string, value: unknown, known: readonly T[], is: (v: unknown) => v is T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > known.length * 2) {
    c.problems.push(`${path} must be a list of ${known.join(", ")}`);
    return [];
  }
  const out: T[] = [];
  value.forEach((name, i) => {
    if (!is(name)) c.problems.push(`${path}[${i}] must be one of ${known.join(", ")}`);
    else if (!out.includes(name)) out.push(name);
  });
  return out;
}

export function stateAccessOf(c: Check, value: unknown, tabs: "read" | "write" | false): StateAccess | false {
  if (value === undefined || value === false) return false;
  if (!isFields(value)) {
    c.problems.push(`permissions.state must be an object of ${STATE_KEYS.join(" and ")}`);
    return false;
  }
  only(c, "permissions.state", value, STATE_KEYS);
  const events = namesOf(c, "permissions.state.events", value.events, STATE_TOPICS, isStateTopic);
  const intents = namesOf(c, "permissions.state.intents", value.intents, STATE_INTENTS, isStateIntent);
  for (const topic of events) if (TOPICS_NEEDING_TABS.includes(topic) && !tabs) c.problems.push(`permissions.state.events: ${topic} needs tabs`);
  if (intents.length && tabs !== "write") c.problems.push("permissions.state.intents need tabs: write");
  return events.length || intents.length ? { events, intents } : false;
}

export const grantsTopic = (access: StateAccess | false, topic: StateTopic) => !!access && access.events.includes(topic);
export const grantsIntent = (access: StateAccess | false, intent: StateIntent) => !!access && access.intents.includes(intent);

export function stateGranted(access: StateAccess | false): string[] {
  if (!access) return [];
  return [...access.events.map((t) => `state:${t}`), ...access.intents.map((i) => `intent:${i}`)];
}

export function stateMissing(caller: StateAccess | false, callee: StateAccess | false): string[] {
  if (!callee) return [];
  return [...callee.events.filter((t) => !grantsTopic(caller, t)).map((t) => `state:${t}`), ...callee.intents.filter((i) => !grantsIntent(caller, i)).map((i) => `intent:${i}`)];
}
