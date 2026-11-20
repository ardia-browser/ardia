import { onPluginExit, onPluginLine, replyToPlugin, sendToPlugin, type PluginLine } from "../../platform/plugins";
import { systemInfo } from "../../platform/app";
import { errorText } from "../../lib/errors";
import { redactedEventData } from "../automation/eventRedaction";
import { canonicalIpv6, formatUrl, minimizedUrl, urlParts } from "../../lib/urlParts";
import type { PluginManifest } from "../../lib/pluginManifest";
import { useBrowser } from "../browser/store";
import { failure, parseRequest, parseSubscription, type RequestId, type Subscription } from "../automation/automationMethods";
import { automationWindows, lastFocusedEligibleWindow } from "../automation/automationWindows";
import { SPLIT_SIDES, type PageSide } from "../../lib/pluginManifest";
import { isPagePath, openPluginPage } from "./pages";
import { eventTargets, refreshFeed, runMethod, setFeedConsumer, type Body } from "../automation/controlSocket";
import { applyMethod } from "../automation/workspaceMethods";
import { launchToReplay } from "../automation/lifecycleEvents";
import type { AutomationEventName } from "../automation/eventNames";
import { activeManifest, currentPlugins, usePlugins } from "./store";
import { answerCall, callTool, dropCalls } from "./tools";
import { acceptsLine, acceptsRun, onProcessStopped, processExited } from "./process";
import { valuesFor } from "./values";

export const CHANNEL_PROTOCOL = 1;

type Connection = { name: string; run: number; sub: Subscription | null; launchSent: boolean };

const connections = new Map<string, Connection>();
const key = (name: string, run: number) => `${name}#${run}`;

function connectionFor(name: string, run: number): Connection {
  const k = key(name, run);
  let c = connections.get(k);
  if (!c) connections.set(k, (c = { name, run, sub: null, launchSent: false }));
  return c;
}

const has = (m: PluginManifest, permission: PluginManifest["permissions"][number]) => m.permissions.includes(permission);

function minimizedWindows(full: boolean) {
  const windows = automationWindows(useBrowser.getState());
  return full ? windows : windows.map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t, url: minimizedUrl(t.url) })) }));
}

function subscribe(c: Connection, m: PluginManifest, params: Record<string, unknown>): Body {
  const given = params.events;
  if (!Array.isArray(given)) return failure("bad_request", "subscribe needs events: a list of event names, or [\"*\"].");
  const events = given.includes("*") ? m.hooks : given;
  const outside = events.filter((name) => typeof name !== "string" || !m.hooks.includes(name));
  if (outside.length) return failure("refused", `This plugin's hooks don't list ${outside.join(", ")}.`);
  const sub = parseSubscription({ events, idle: params.idle, fullUrls: has(m, "fullUrls") });
  if ("error" in sub) return sub;
  c.sub = sub.events.size ? sub : null;
  refreshFeed();
  if (c.sub?.events.has("app.launched") && !c.launchSent) {
    const launch = launchToReplay();
    if (launch) {
      c.launchSent = true;
      setTimeout(() => deliverTo(c, "app.launched", launch.data, launch.time), 0);
    }
  }
  return { result: { ok: true } };
}

function openPage(name: string, m: PluginManifest, params: Record<string, unknown>): Body {
  if (!m.page) return failure("refused", "This plugin has no page.");
  const { path, split, side, context } = params;
  if (path !== undefined && (typeof path !== "string" || !isPagePath(path))) return failure("bad_request", "page.open's path is /like/this?q=1, at most 512 characters.");
  if (side !== undefined && !(SPLIT_SIDES as readonly unknown[]).includes(side)) return failure("bad_request", "side is left, right, top or bottom.");
  if (context === true && !has(m, "tabs")) return failure("refused", "Handing the page a tab needs the tabs permission.");
  const windowId = lastFocusedEligibleWindow(useBrowser.getState());
  if (!windowId) return failure("no_window", "No window to open the page in.");
  const tabId = openPluginPage(windowId, name, { path: (path as string | undefined) ?? "", split: split === true, side: side as PageSide | undefined, context: context === true });
  return tabId ? { result: { tabId, windowId } } : failure("failed", "The page couldn't open.");
}

async function toolsCall(name: string, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  const { plugin, tool, input } = params;
  if (typeof plugin !== "string" || typeof tool !== "string") return failure("bad_request", "tools.call needs a plugin and a tool.");
  const callee = activeManifest(currentPlugins(), plugin);
  const missing = callee?.permissions.filter((p) => !m.permissions.includes(p)) ?? [];
  if (missing.length) return failure("refused", `${plugin} has permissions this plugin doesn't (${missing.join(", ")}), so it can't call its tools.`);
  const outcome = await callTool(plugin, tool, input, { kind: "plugin", plugin: name });
  return outcome.ok ? { result: outcome.result } : failure(outcome.code, outcome.message);
}

export const MAX_OPEN_URLS = 10;
export const MAX_OPEN_URL_LENGTH = 2048;

const AUTHORITY = /^([A-Za-z][A-Za-z\d+.-]*:\/\/)([^/?#]*)(.*)$/s;
const NON_ASCII = /[^\x00-\x7f]+/gu;

export type PluginWebUrl = { url: string } | { problem: string };

function withCanonicalHost(raw: string, authority: string): string | null {
  if (!authority.startsWith("[")) return raw;
  const close = authority.indexOf("]");
  const canonical = close < 0 ? null : canonicalIpv6(authority.slice(1, close).toLowerCase());
  if (!canonical) return null;
  const found = AUTHORITY.exec(raw)!;
  return `${found[1]}[${canonical}]${authority.slice(close + 1)}${found[3]}`;
}

export function pluginWebUrl(raw: unknown): PluginWebUrl {
  if (typeof raw !== "string") return { problem: "isn't text" };
  if (raw.length > MAX_OPEN_URL_LENGTH) return { problem: `is over ${MAX_OPEN_URL_LENGTH} characters` };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return { problem: "has a control character" };
  if (/\s/u.test(raw)) return { problem: "has a space; percent-encode it as %20" };
  if (raw.includes("\\")) return { problem: "has a backslash" };
  const found = AUTHORITY.exec(raw);
  if (!found || !/^https?:\/\/$/i.test(found[1]!)) return { problem: "isn't an http or https address with a host" };
  if (/[^\x00-\x7f]/.test(found[2]!)) return { problem: "has a host that isn't ASCII; send an international name as punycode (xn--)" };
  if (found[2]!.includes("@")) return { problem: "has credentials" };
  const plain = withCanonicalHost(raw, found[2]!);
  const parts = plain === null ? null : urlParts(plain);
  if (!parts || !parts.authority || !parts.host) return { problem: "isn't a valid address (check the host and that the port is 1 to 65535)" };
  try {
    return { url: formatUrl(parts).replace(NON_ASCII, (run) => encodeURIComponent(run)) };
  } catch {
    return { problem: "has text that isn't valid Unicode" };
  }
}

async function openTabs(c: Connection, m: PluginManifest, params: Record<string, unknown>): Promise<Body> {
  if (!has(m, "commands")) return failure("refused", "open needs the commands permission.");
  const { urls, activate } = params;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_OPEN_URLS) return failure("bad_request", `open takes urls: a list of 1 to ${MAX_OPEN_URLS} http or https addresses.`);
  const checked = urls.map(pluginWebUrl);
  const bad = checked.findIndex((u) => "problem" in u);
  if (bad >= 0) return failure("bad_request", `urls[${bad}] ${(checked[bad] as { problem: string }).problem}.`);
  const normalised = checked.map((u) => (u as { url: string }).url);
  const current = () => acceptsRun(c.name, c.run) && !!activeManifest(currentPlugins(), c.name)?.permissions.includes("commands");
  const body = await applyMethod({ ops: [{ op: "open", urls: normalised, ...(activate === true ? { activate: true } : {}) }] }, current);
  const applied = "result" in body ? (body.result as { ok?: boolean; results?: { tabs?: string[] }[] }) : null;
  if (!applied?.ok) return failure(current() ? "failed" : "refused", current() ? "The tabs couldn't open." : "This run of the helper has ended or lost commands, so nothing opened.");
  return { result: { ok: true, tabs: applied.results?.[0]?.tabs ?? [] } };
}

function answer(c: Connection, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  switch (method) {
    case "hello":
      return { result: { app: "Ardia", version: systemInfo().appVersion, protocol: CHANNEL_PROTOCOL, plugin: c.name, values: valuesFor(c.name) } };
    case "values":
      return { result: valuesFor(c.name) };
    case "subscribe":
      return subscribe(c, m, params);
    case "windows":
      return has(m, "tabs") ? { result: minimizedWindows(has(m, "fullUrls")) } : failure("refused", "windows needs the tabs permission.");
    case "run":
      return has(m, "commands") ? runMethod(params) : failure("refused", "run needs the commands permission.");
    case "open":
      return openTabs(c, m, params);
    case "page.open":
      return openPage(c.name, m, params);
    case "tools.call":
      return toolsCall(c.name, m, params);
    case "result": {
      const problem = answerCall(c.name, c.run, params);
      return problem ? failure("bad_request", problem) : { result: { ok: true } };
    }
  }
  return failure("unknown_method", `There's no method ${method}.`);
}

function reply(c: Connection, id: RequestId, body: Body) {
  replyToPlugin(c.name, c.run, JSON.stringify({ id, ...body }));
}

export function handlePluginLine({ name, run, launch, line }: PluginLine) {
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

export function dropConnections(name: string) {
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
  setFeedConsumer("plugins", { subscriptions: () => [...connections.values()].flatMap((c) => (c.sub ? [c.sub] : [])), deliver });
}

export const channelCount = () => connections.size;
