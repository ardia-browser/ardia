import { onPluginExit, onPluginLine, replyToPlugin, sendToPlugin, type PluginLine } from "../../platform/plugins";
import { errorText } from "../../lib/errors";
import { redactedEventData } from "../automation/eventRedaction";
import type { PluginManifest } from "../../lib/pluginManifest";
import { failure, parseRequest, parseSubscription, type RequestId, type Subscription } from "../automation/automationMethods";
import { changeSubscription } from "../automation/automationFeed";
import { eventTargets, refreshFeed, setFeedConsumer, type Body } from "../automation/controlSocket";
import { launchToReplay } from "../automation/lifecycleEvents";
import { isDecideEvent, type AutomationEventName } from "../automation/eventNames";
import { activeManifest, currentPlugins } from "./store";
import { dropCalls } from "./tools";
import { acceptsLine, onProcessStopped, processExited } from "./process";
import { valuesFor } from "./values";
import { dropHiddenRetainedSidePanels } from "./surfaces";
import { answerMethod } from "./channelApi";

export { pluginWebUrl } from "../../lib/pluginWebUrl";

type Connection = { name: string; run: number; sub: Subscription | null; launchSent: boolean };

const connections = new Map<string, Connection>();
const idleReplays = new Map<Connection, Record<string, unknown>[]>();
const key = (name: string, run: number) => `${name}#${run}`;

function connectionFor(name: string, run: number): Connection {
  const k = key(name, run);
  let c = connections.get(k);
  if (!c) connections.set(k, (c = { name, run, sub: null, launchSent: false }));
  return c;
}

const observedHooks = (m: PluginManifest) => m.hooks.filter((h) => !isDecideEvent(h));

function subscribe(c: Connection, m: PluginManifest, params: Record<string, unknown>): Body {
  const given = params.events;
  if (!Array.isArray(given)) return failure("bad_request", "subscribe needs events: a list of event names, or [\"*\"].");
  const hooks = observedHooks(m);
  const events = given.includes("*") ? hooks : given;
  const outside = events.filter((name) => typeof name !== "string" || !hooks.includes(name));
  if (outside.length) return failure("refused", `This plugin's hooks don't list ${outside.join(", ")}.`);
  const sub = parseSubscription({ events, idle: params.idle, fullUrls: m.permissions.fullUrls });
  if ("error" in sub) return sub;
  const replay = changeSubscription(c.sub, sub.events.size ? sub : null, () => {
    c.sub = sub.events.size ? sub : null;
    refreshFeed();
  });
  if (replay.length) idleReplays.set(c, replay);
  if (c.sub?.events.has("app.launched") && !c.launchSent) {
    const launch = launchToReplay();
    if (launch) {
      c.launchSent = true;
      setTimeout(() => deliverTo(c, "app.launched", launch.data, launch.time), 0);
    }
  }
  return { result: { ok: true } };
}

function answer(c: Connection, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  if (method === "subscribe") return subscribe(c, m, params);
  return answerMethod(c, m, method, params) ?? failure("unknown_method", `There's no method ${method}.`);
}

function reply(c: Connection, id: RequestId, body: Body) {
  const replay = idleReplays.get(c) ?? [];
  idleReplays.delete(c);
  replyToPlugin(c.name, c.run, JSON.stringify({ id, ...body }));
  for (const data of replay) deliverTo(c, "tab.idle", data, Date.now());
}

function handlePluginLine({ name, run, launch, line }: PluginLine) {
  if (!acceptsLine(name, run, launch)) return;
  const manifest = activeManifest(currentPlugins(), name);
  const c = connectionFor(name, run);
  const request = parseRequest(line);
  if ("error" in request) return reply(c, request.id, { error: request.error });
  if (!manifest) return reply(c, request.id, failure("refused", "This plugin is off."));
  let body: Body | Promise<Body>;
  try {
    body = answer(c, manifest, request.method, request.params);
  } catch (error) {
    body = failure("failed", errorText(error));
  }
  if (body instanceof Promise) void body.then((settled) => reply(c, request.id, settled), (error: unknown) => reply(c, request.id, failure("failed", errorText(error))));
  else reply(c, request.id, body);
}

function deliverTo(c: Connection, name: AutomationEventName, data: Record<string, unknown>, time: number) {
  const full = !!c.sub?.fullUrls;
  const shown = full ? data : redactedEventData(data);
  sendToPlugin(c.name, c.run, JSON.stringify({ event: name, time, data: shown }));
}

function deliver(name: AutomationEventName, data: Record<string, unknown>, time: number) {
  const subs = new Map<number, Subscription>();
  const byIndex: Connection[] = [];
  for (const c of connections.values()) {
    if (!c.sub || !activeManifest(currentPlugins(), c.name)) continue;
    byIndex.push(c);
    subs.set(byIndex.length - 1, c.sub);
  }
  const { full, plain } = eventTargets(subs, name, data);
  for (const index of [...full, ...plain]) deliverTo(byIndex[index]!, name, data, time);
}

function dropConnections(name: string) {
  let changed = false;
  for (const [k, c] of connections) {
    if (c.name !== name) continue;
    connections.delete(k);
    changed ||= !!c.sub;
  }
  if (changed) refreshFeed();
}

export function sendValues(name: string) {
  const values = valuesFor(name);
  for (const c of connections.values()) if (c.name === name) sendToPlugin(name, c.run, JSON.stringify({ event: "plugin.values", time: Date.now(), data: { values } }));
}

let listening = false;

export function startChannels() {
  if (listening) return;
  listening = true;
  onPluginLine((line) => {
    try {
      handlePluginLine(line);
    } catch (error) {
      console.warn("[plugins] a helper's request failed", error);
    }
  });
  onPluginExit(processExited);
  onProcessStopped(dropConnections);
  onProcessStopped(dropCalls);
  onProcessStopped(dropHiddenRetainedSidePanels);
  setFeedConsumer("plugins", { subscriptions: () => [...connections.values()].flatMap((c) => (c.sub ? [c.sub] : [])), deliver });
}

